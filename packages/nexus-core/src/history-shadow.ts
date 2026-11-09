/**
 * 模型歷史從日誌推（[#2355](https://github.com/DemianLi/nexus-agent/issues/2355)）：每次模型呼叫，拿從日誌推出來的歷史跟這次真的要送的
 * `request.messages` 比（`shadow`），或拿它換掉 `request.messages`（`log`）。
 *
 * - `shadow` 只比、不換：請求原樣交下去，結果交給 {@link HistoryShadowSink}，不寫進會話日誌。比對本身出錯也只記一筆，不往外拋。
 * - `log` 只換、不比：推不出來、找不到日誌就拋，這次呼叫失敗，不退回 state——日誌上沒有的就不送。
 *
 * ## 掛在哪一層
 *
 * 兩顆都掛在 root 那一串裡緊貼 `requestSnapshot` 外側。這裡看到的是摘要器、參數截斷、補懸空呼叫都套過之後的那一串，跟推導端「送出去的樣子」
 * （三個 `apply*` 都開）同一個時間點；再外面的幾層還沒套，原理上比不齊。
 *
 * ## 比的是送上線的樣子
 *
 * 兩邊各投影成 `@langchain/openai` 舊路徑（`convertMessagesToCompletionsMessageParams`）會送的欄位，再套出貨 `fetch` 層
 * （`withShippedRequestBody` 的三格）的四個效果：空的助手訊息整則不送、有工具呼叫且內容是空陣列的送 `null`、空的工具結果送 `(no output)`、
 * 助手訊息不帶 `name`。LangChain 自己產的 `id` 不上線，不比。
 *
 * @module
 */

import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';

import type { AgentMiddleware } from './base-types.js';
import {
  TOOL_NOT_STARTED_TEXT,
  TOOL_OUTCOME_UNKNOWN_TEXT,
  isBlankContent,
  isBlankContentArray,
} from './conversation-replay.js';
import { toBaseMessage } from './langchain-message-adapter.js';
import { ModelHistoryCache } from './model-history.js';
import { withModelCallStep } from './model-call-step.js';
import type { ModelHistoryOptions } from './model-history.js';
import type { DeriveOptions, DerivedConversation } from './conversation-replay.js';
import type { NexusMessage } from './nexus-message.js';
import { patchedToolCallText } from './patch-tool-calls.js';
import type { SessionLookup } from './registry.js';
import type { SessionEvent, SessionLog } from './session-log.js';

/** middleware 的名字。 */
export const HISTORY_SHADOW_MIDDLEWARE_NAME = 'historyShadow';

/** `log` 那一顆的名字。 */
export const HISTORY_FROM_LOG_MIDDLEWARE_NAME = 'historyFromLog';

/**
 * 模型歷史從哪裡來。`state`：歷史取自 LangGraph state；`shadow`：送的仍是 state，另外拿日誌推導比一次；`log`：送日誌推出來的。
 */
export type HistorySource = 'state' | 'shadow' | 'log';

/** 認得的值，設定與旗標驗值用。 */
export const HISTORY_SOURCES = [
  'state',
  'shadow',
  'log',
] as const satisfies readonly HistorySource[];

/**
 * 一次比對的結果。
 *
 * - `match`：相同。
 * - `image-offload-after-start`：相同，但這次呼叫的 `image/offload` 落在它的 `model/start` 之後（recovery 接住 adapter 的錯之後才省略），
 *   推導要把那幾顆也算進去才對得上。分開記，不混進 `match`。
 * - `patch-closer`：唯一的差別是懸空呼叫的補結：請求那邊是 `patchToolCallsMiddleware` 那句，推導那邊是 {@link TOOL_OUTCOME_UNKNOWN_TEXT} 或 {@link TOOL_NOT_STARTED_TEXT}（寫回日誌的，或推導時補上的）。
 * - `other`：其餘的不同，連同推不出來、比對本身出錯。
 */
export type HistoryShadowKind = 'match' | 'image-offload-after-start' | 'patch-closer' | 'other';

/** 所有類別，計數用。 */
export const HISTORY_SHADOW_KINDS: readonly HistoryShadowKind[] = [
  'match',
  'image-offload-after-start',
  'patch-closer',
  'other',
];

/** 一次比對交出去的東西。 */
export interface HistoryShadowOutcome {
  readonly kind: HistoryShadowKind;
  /** 不是 `match` 時的第一處差異，給人看的。 */
  readonly detail?: string;
}

/** 比對結果的去處。 */
export interface HistoryShadowSink {
  /** 記一筆。拋的錯由 middleware 吞掉，不影響這次模型呼叫。 */
  record(outcome: HistoryShadowOutcome): void;
}

/** 數各類別的 {@link HistoryShadowSink}。 */
export interface HistoryShadowTally extends HistoryShadowSink {
  /** 目前為止各類別幾次。 */
  counts(): Readonly<Record<HistoryShadowKind, number>>;
}

/**
 * 建一份計數。
 *
 * @param onDifference - 不是 `match` 的那幾次另外交給它（serve 接伺服器日誌、CLI 接標準錯誤）；它拋的錯吞掉。
 * @returns 計數。
 */
export function createHistoryShadowTally(
  onDifference?: (outcome: HistoryShadowOutcome) => void,
): HistoryShadowTally {
  const counts = Object.fromEntries(HISTORY_SHADOW_KINDS.map((kind) => [kind, 0])) as Record<
    HistoryShadowKind,
    number
  >;
  return {
    record(outcome) {
      counts[outcome.kind] += 1;
      if (outcome.kind === 'match' || onDifference === undefined) return;
      try {
        onDifference(outcome);
      } catch {
        // 記錄端壞了不影響模型呼叫。
      }
    },
    counts: () => ({ ...counts }),
  };
}

/**
 * 工具結果是空的時候，出貨 `fetch` 層送給模型的那一個字。harness 的 `live-model.ts` 有自己的一份，兩份由
 * `history-shadow-scenarios.test.ts` 綁成同一個值。
 */
export const WIRE_EMPTY_TOOL_RESULT_TEXT = '(no output)';

/** `@langchain/openai` 舊路徑濾掉的區塊。 */
const DROPPED_BLOCK_TYPES: ReadonlySet<string> = new Set([
  'tool_use',
  'tool_call',
  'functionCall',
  'reasoning',
  'reasoning_content',
  'thinking',
]);

const isEmptyToolContent = (content: unknown): boolean =>
  content === null ||
  content === undefined ||
  content === '' ||
  (Array.isArray(content) &&
    content.every((block) => (block as { type?: unknown }).type === 'text') &&
    content.map((block) => (block as { text?: unknown }).text ?? '').join('') === '');

/**
 * 一則訊息送上線的樣子，序列化成字串；整則不送時是 `undefined`。見檔頭〈比的是送上線的樣子〉。
 *
 * @param message - 一則訊息。
 * @returns 序列化的投影。
 */
export function wireProjection(message: BaseMessage): string | undefined {
  const role = message.getType();
  const raw = message.content as unknown;
  let content: unknown = Array.isArray(raw)
    ? raw.filter((block) => !DROPPED_BLOCK_TYPES.has((block as { type?: string }).type ?? ''))
    : raw;
  const kwargs = message.additional_kwargs as Record<string, unknown>;
  let toolCalls: unknown;
  if (AIMessage.isInstance(message) && (message.tool_calls?.length ?? 0) > 0) {
    toolCalls = message.tool_calls!.map(({ id, name, args }) => ({ id, name, args }));
  } else if (kwargs['tool_calls'] != null) {
    toolCalls = kwargs['tool_calls'];
  }
  if (role === 'ai') {
    const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;
    if (hasToolCalls ? isBlankContentArray(content) : isBlankContent(content)) {
      if (!hasToolCalls) return undefined;
      content = null;
    }
  }
  if (role === 'tool' && isEmptyToolContent(content)) content = WIRE_EMPTY_TOOL_RESULT_TEXT;
  return JSON.stringify({
    role,
    content,
    ...(role !== 'ai' && message.name != null && { name: message.name }),
    ...(kwargs['function_call'] != null && { function_call: kwargs['function_call'] }),
    ...(toolCalls !== undefined && { tool_calls: toolCalls }),
    ...(ToolMessage.isInstance(message) && { tool_call_id: message.tool_call_id }),
  });
}

/**
 * 給這次模型呼叫推歷史用的那一段事件：去掉還開著的那顆 `model/start`；它之後只留 `image/offload`（recovery 在送出前才下的決定）。
 *
 * @param events - root 那一份日誌目前的全部事件。
 * @returns 要推的事件，與 `model/start` 之後有沒有 `image/offload`。
 */
export function eventsForModelCall(events: readonly SessionEvent[]): {
  readonly events: readonly SessionEvent[];
  readonly offloadAfterStart: boolean;
} {
  let start = -1;
  for (let index = events.length - 1; index >= 0; index--) {
    const type = events[index]!.type;
    if (type === 'model/end') break;
    if (type === 'model/start') {
      start = index;
      break;
    }
  }
  if (start === -1) return { events, offloadAfterStart: false };
  const after = events.slice(start + 1).filter((event) => event.type === 'image/offload');
  return after.length === 0
    ? { events: events.slice(0, start), offloadAfterStart: false }
    : { events: [...events.slice(0, start), ...after], offloadAfterStart: true };
}

/** 推導端的那兩句補結。 */
const DERIVED_CLOSER_TEXTS: ReadonlySet<string> = new Set([
  TOOL_OUTCOME_UNKNOWN_TEXT,
  TOOL_NOT_STARTED_TEXT,
]);

/** 這一格的差別是不是只有補結的那一句。 */
function closerOnly(request: string, derived: string): boolean {
  const a = JSON.parse(request) as {
    role: string;
    content: unknown;
    tool_call_id?: string;
    name?: string;
  };
  const b = JSON.parse(derived) as { role: string; content: unknown; tool_call_id?: string };
  return (
    a.role === 'tool' &&
    b.role === 'tool' &&
    a.tool_call_id === b.tool_call_id &&
    a.content === patchedToolCallText(a.name ?? '', a.tool_call_id ?? '') &&
    typeof b.content === 'string' &&
    DERIVED_CLOSER_TEXTS.has(b.content)
  );
}

/**
 * 比兩串投影。
 *
 * @param request - 請求那邊。
 * @param derived - 推導那邊。
 * @returns `match`、`patch-closer` 或 `other`（帶第一處差異）。
 */
export function compareProjections(
  request: readonly string[],
  derived: readonly string[],
): HistoryShadowOutcome {
  if (request.length !== derived.length) {
    return {
      kind: 'other',
      detail: `則數不同：請求 ${String(request.length)} 則、推導 ${String(derived.length)} 則（${firstDifference(request, derived)}）`,
    };
  }
  let closers = 0;
  for (let index = 0; index < request.length; index++) {
    if (request[index] === derived[index]) continue;
    if (closerOnly(request[index]!, derived[index]!)) {
      closers += 1;
      continue;
    }
    return { kind: 'other', detail: firstDifference(request, derived) };
  }
  return closers === 0
    ? { kind: 'match' }
    : { kind: 'patch-closer', detail: `${String(closers)} 則補結的句子不同` };
}

function firstDifference(request: readonly string[], derived: readonly string[]): string {
  const length = Math.max(request.length, derived.length);
  for (let index = 0; index < length; index++) {
    if (request[index] === derived[index]) continue;
    const cut = (text: string | undefined) =>
      text === undefined ? '（沒有）' : text.length > 200 ? `${text.slice(0, 200)}…` : text;
    return `第 ${String(index)} 則：請求 ${cut(request[index])}／推導 ${cut(derived[index])}`;
  }
  return '沒有差異';
}

/** 投影按訊息物件快取：state 裡的訊息與 `ModelHistoryCache` 推出來的訊息都跨呼叫沿用，同一個物件不重投影。 */
const requestProjections = new WeakMap<BaseMessage, string | null>();
const derivedProjections = new WeakMap<NexusMessage, string | null>();

function projectRequest(messages: readonly BaseMessage[]): string[] {
  const out: string[] = [];
  for (const message of messages) {
    let projected = requestProjections.get(message);
    if (projected === undefined) {
      projected = wireProjection(message) ?? null;
      requestProjections.set(message, projected);
    }
    if (projected !== null) out.push(projected);
  }
  return out;
}

function projectDerived(messages: readonly NexusMessage[]): string[] {
  const out: string[] = [];
  for (const message of messages) {
    let projected = derivedProjections.get(message);
    if (projected === undefined) {
      projected = wireProjection(toBaseMessage(message)) ?? null;
      derivedProjections.set(message, projected);
    }
    if (projected !== null) out.push(projected);
  }
  return out;
}

/**
 * 比一次：這次要送的那一串對上日誌推出來的。
 *
 * @param messages - `request.messages`。
 * @param log - 這次呼叫的那一份日誌。
 * @param cache - 這份日誌的增量推導，選項要是「送出去的樣子」（三個 `apply*` 都開）。
 * @returns 比對結果。
 */
export function compareHistoryWithLog(
  messages: readonly BaseMessage[],
  log: SessionLog,
  cache: ModelHistoryCache,
): HistoryShadowOutcome {
  const { events, offloadAfterStart } = eventsForModelCall(log.events);
  const derived = cache.derive(events);
  if (derived.kind !== 'replayed') {
    return { kind: 'other', detail: `推不出來：${derived.reason}@${String(derived.seq)}` };
  }
  const outcome = compareProjections(projectRequest(messages), projectDerived(derived.messages));
  return outcome.kind === 'match' && offloadAfterStart
    ? { kind: 'image-offload-after-start' }
    : outcome;
}

/** 影子比對要的東西。 */
export interface HistoryShadowOptions {
  /** 比對結果的去處。 */
  readonly sink: HistoryShadowSink;
  /** 見 {@link DeriveOptions.toolResultAsSeen}：工具結果在模型那一格的樣子由組裝點決定。 */
  readonly toolResultAsSeen?: DeriveOptions['toolResultAsSeen'];
}

/**
 * 建影子比對那一顆。只用 `wrapModelCall`：不多一個節點，請求原樣交下去。
 *
 * 一份日誌一份增量推導，按日誌物件認；日誌只往後長，所以每次只推新的那幾顆；`model/start` 之後有 `image/offload` 的那次交進去的不是前綴，整份重推。
 *
 * @param deps - 找日誌的通道與 {@link HistoryShadowOptions}。
 * @returns middleware。
 */
export function createHistoryShadowMiddleware(
  deps: HistoryShadowOptions & { readonly sessions: { forCall(config: unknown): SessionLookup } },
): AgentMiddleware {
  const cacheOf = sentHistoryCaches(deps.toolResultAsSeen);
  return withModelCallStep(
    (rawRequest, handler) => {
      const request = rawRequest as { readonly messages: BaseMessage[] };
      let outcome: HistoryShadowOutcome;
      try {
        const found = deps.sessions.forCall({
          configurable: (request as { runtime?: { configurable?: unknown } }).runtime?.configurable,
        });
        outcome =
          found.kind === 'ok'
            ? compareHistoryWithLog(request.messages, found.log, cacheOf(found.log))
            : { kind: 'other', detail: `找不到日誌：${found.kind}` };
      } catch (error) {
        outcome = { kind: 'other', detail: `比對出錯：${String(error)}` };
      }
      try {
        deps.sink.record(outcome);
      } catch {
        // 記錄端壞了不影響模型呼叫。
      }
      return handler(request);
    },
    (wrapModelCall) =>
      createMiddleware({
        name: HISTORY_SHADOW_MIDDLEWARE_NAME,
        wrapModelCall: wrapModelCall as never,
      }) as unknown as AgentMiddleware,
  );
}

/** 一份日誌一份增量推導，按日誌物件認。 */
function historyCaches(options: ModelHistoryOptions): (log: SessionLog) => ModelHistoryCache {
  const caches = new WeakMap<SessionLog, ModelHistoryCache>();
  return (log) => {
    let cache = caches.get(log);
    if (cache === undefined) {
      cache = new ModelHistoryCache(options);
      caches.set(log, cache);
    }
    return cache;
  };
}

/** 「送出去的樣子」（三個 `apply*` 都開）的 {@link historyCaches}。 */
function sentHistoryCaches(
  toolResultAsSeen: DeriveOptions['toolResultAsSeen'] | undefined,
): (log: SessionLog) => ModelHistoryCache {
  return historyCaches({
    ...(toolResultAsSeen !== undefined && { toolResultAsSeen }),
    applyPrunes: true,
    applyArgTruncations: true,
    applyImageOffloads: true,
  });
}

/** 轉好的訊息按推出來的訊息物件快取：`ModelHistoryCache` 推出來的訊息跨呼叫沿用，同一個物件不重轉。 */
const sentMessages = new WeakMap<NexusMessage, BaseMessage>();

/**
 * 這次模型呼叫要送的歷史，從日誌推。切法同 {@link compareHistoryWithLog}：`model/start` 之後的 `image/offload` 算進去，重送時不會再送一次圖。
 *
 * @param log - 這次呼叫的那一份日誌。
 * @param cache - 這份日誌「送出去的樣子」的增量推導。
 * @returns 要送的訊息：陣列每次是新的，訊息物件跨呼叫共用，呼叫端不能就地改。
 * @throws 推不出來時。
 */
export function sentHistoryFromLog(log: SessionLog, cache: ModelHistoryCache): BaseMessage[] {
  return messagesOf(cache.derive(eventsForModelCall(log.events).events));
}

function messagesOf(derived: DerivedConversation): BaseMessage[] {
  if (derived.kind !== 'replayed') {
    throw new Error(
      `模型歷史從日誌推不出來（${derived.reason}@${String(derived.seq)}）：history-source=log 不退回 state`,
    );
  }
  return derived.messages.map((message) => {
    let sent = sentMessages.get(message);
    if (sent === undefined) {
      sent = toBaseMessage(message);
      sentMessages.set(message, sent);
    }
    return sent;
  });
}

/**
 * 讀「模型看得到的那一串」的讀者（pre-step 的 listener）在 `log` 時用：摘要套上，剪法、參數截斷、圖片省略不套，跟 state 那邊
 * （`applySummaryCutoff` 套切點表）同一個視圖。一份日誌一份增量推導；交出的訊息物件跨呼叫共用，呼叫端不能就地改。
 *
 * @param toolResultAsSeen - 見 {@link DeriveOptions.toolResultAsSeen}。
 * @returns 從日誌推到目前為止的那一串；推不出來就拋。
 */
export function createVisibleHistoryReader(
  toolResultAsSeen?: DeriveOptions['toolResultAsSeen'],
): (log: SessionLog) => BaseMessage[] {
  const cacheOf = historyCaches(toolResultAsSeen === undefined ? {} : { toolResultAsSeen });
  return (log) => messagesOf(cacheOf(log).derive(eventsForModelCall(log.events).events));
}

/** `log` 那一顆要的東西。 */
export interface HistoryFromLogOptions {
  /** 見 {@link DeriveOptions.toolResultAsSeen}。 */
  readonly toolResultAsSeen?: DeriveOptions['toolResultAsSeen'];
}

/**
 * 建 `log` 那一顆：拿日誌推出來的歷史換掉 `request.messages`，其餘原樣交下去。摘要器、剪刀、參數截斷讀 state 決定要不要做，決定記進日誌；這裡只照日誌上記的套（摘要、剪法、截斷、圖片省略），不自己判斷。
 *
 * 找不到日誌、推不出來都拋，這次呼叫失敗。
 *
 * @param deps - 找日誌的通道與 {@link HistoryFromLogOptions}。
 * @returns middleware。
 */
export function createHistoryFromLogMiddleware(
  deps: HistoryFromLogOptions & { readonly sessions: { forCall(config: unknown): SessionLookup } },
): AgentMiddleware {
  const cacheOf = sentHistoryCaches(deps.toolResultAsSeen);
  return withModelCallStep(
    (request, handler) => {
      const found = deps.sessions.forCall({
        configurable: (request as { runtime?: { configurable?: unknown } }).runtime?.configurable,
      });
      if (found.kind !== 'ok') {
        throw new Error(
          `找不到這次模型呼叫的日誌（${found.kind}）：history-source=log 不退回 state`,
        );
      }
      return handler({ ...request, messages: sentHistoryFromLog(found.log, cacheOf(found.log)) });
    },
    (wrapModelCall) =>
      createMiddleware({
        name: HISTORY_FROM_LOG_MIDDLEWARE_NAME,
        wrapModelCall: wrapModelCall as never,
      }) as unknown as AgentMiddleware,
  );
}

/** fold 在 `log` 時標起來的 `registry.sessions`，見 {@link markHistoryFromLog}。 */
const fromLog = new WeakSet<object>();

/**
 * 標明這份 `registry.sessions` 那條 thread 的歷史從日誌推（`log`）。fold 在組裝開頭叫，標了不撤。用 {@link isHistoryFromLog} 查的有
 * pre-step 宿主、重複提醒（兩顆在載入插件時就建好、拿的就是這個物件）與 `toolCallOwner`（屏障、`returnDirect` 收尾、原字串）。
 *
 * @param sessions - 那條 thread 的 `registry.sessions`。
 */
export function markHistoryFromLog(sessions: object): void {
  fromLog.add(sessions);
}

/**
 * 這份 `registry.sessions` 的歷史是不是從日誌推。是的話，找不到這次呼叫的日誌就得拋，不退回 state：要記進日誌的訊息
 * 沒記進去，模型永遠看不到；讀歷史的讀者讀 state，看到的不是模型收到的那一串。
 *
 * @param sessions - 那條 thread 的 `registry.sessions`。
 * @returns 有沒有被 {@link markHistoryFromLog} 標過。
 */
export function isHistoryFromLog(sessions: object): boolean {
  return fromLog.has(sessions);
}
