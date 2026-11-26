/**
 * nexus 自己的訊息（{@link NexusMessage}）與 LangChain `BaseMessage` 之間的轉接（[#2350](https://github.com/DemianLi/nexus-agent/issues/2350)）。
 *
 * 從日誌推模型歷史的那一側（`conversation-replay.ts`、`model-history.ts`）只用 nexus 的訊息；還在 LangGraph 上的讀者（續接灌回 graph state、
 * 會話內容搜尋、請求端的剪刀與摘要器）要的是 `BaseMessage`，由這裡轉。轉法只有一種：{@link toBaseMessage}，`data` 原樣交給建構子。
 *
 * 請求端在 `BaseMessage` 上套剪法與縮短的那幾支也在這裡：「換成什麼」與推導端共用 `tool-result-prune-log.ts`、`tool-arg-truncation-log.ts`
 * 的同一支函式，這裡只負責拆開與包回 `BaseMessage`。
 *
 * @module
 */

import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';

import { closerErrorOf, deriveConversation } from './conversation-replay.js';
import type { DeriveOptions, UnreplayableReason } from './conversation-replay.js';
import { readLoggedMessage } from './logged-message.js';
import { isMachineSource, messageSourceOf, turnStartMessage } from './message-source.js';
import type { MessageContent, NexusMessage, NexusToolCall } from './nexus-message.js';
import type { SessionEvent, SessionEventMap } from './session-log.js';
import { truncatedCalls } from './tool-arg-truncation-log.js';
import { markToolError } from './tool-events.js';
import type {
  NewlyTruncatedCall,
  RecordedArgTruncation,
  RecordedArgTruncations,
} from './tool-arg-truncation-log.js';
import { prunedContent } from './tool-result-prune-log.js';
import type { RecordedPrunes } from './tool-result-prune-log.js';

/**
 * 一則 nexus 訊息轉成 `BaseMessage`：`data` 拷一層（`content`、`contentBlocks` 兩個陣列也拷，建構子會在上面補東西）原樣交給建構子，
 * 同 {@link readLoggedMessage}。巢狀的值與 `message` 共用，**傳進來的必須是私有拷貝或整張深凍過的**（`deriveConversation` 預設交出的、
 * 或 `shareStored` 的）；傳日誌上沒凍過的那一份，下游改巢狀的值會改到日誌。推導補上的錯誤結果（`closer` 造的）把錯誤碼掛回去（`markToolError`）。
 */
export function toBaseMessage(message: NexusMessage): BaseMessage {
  const base = readLoggedMessage(message);
  const error = closerErrorOf(message);
  return error === undefined ? base : markToolError(base, error);
}

/** 推的結果，`BaseMessage` 那一份。`seq` 是第一顆推不下去的事件。 */
export type ConversationReplay =
  | { readonly kind: 'replayed'; readonly messages: readonly BaseMessage[] }
  | { readonly kind: 'unreplayable'; readonly reason: UnreplayableReason; readonly seq: number };

/** 同 {@link DeriveOptions}，只有 `origin` 交出的是轉好的 `BaseMessage`。 */
export interface ReplayOptions extends Omit<DeriveOptions, 'origin'> {
  /** 見 {@link DeriveOptions.origin}。交出的那一則與回傳的 `messages` 裡的那一則是同一個物件（同一則 nexus 訊息只轉一次）。 */
  readonly origin?: (message: BaseMessage, event: SessionEvent) => void;
}

/**
 * 把一份 root 日誌推回模型的對話歷史，交給 LangGraph 那一側：{@link deriveConversation} 推完、逐則 {@link toBaseMessage}。
 *
 * @param events - root 那一份日誌的全部事件，照 `seq` 排（續接時讀回來的那些）。
 * @param options - 見 {@link ReplayOptions}。
 * @returns 要灌回 graph state 的那一串（壓縮過就是摘要加之後的），或推不出來的原因。
 */
export function replayConversation(
  events: readonly SessionEvent[],
  options: ReplayOptions = {},
): ConversationReplay {
  const converted = new Map<NexusMessage, BaseMessage>();
  const convert = (message: NexusMessage): BaseMessage => {
    let base = converted.get(message);
    if (base === undefined) {
      base = toBaseMessage(message);
      converted.set(message, base);
    }
    return base;
  };
  const { origin, ...rest } = options;
  const derived = deriveConversation(
    events,
    origin === undefined
      ? rest
      : { ...rest, origin: (message, event) => origin(convert(message), event) },
  );
  return derived.kind === 'replayed'
    ? { kind: 'replayed', messages: derived.messages.map(convert) }
    : derived;
}

/** 一顆 `turn/start` 送進圖的那則 `HumanMessage`：{@link turnStartMessage} 轉過來。live 路徑（pump、CLI）用它。 */
export function humanMessageForTurnStart(data: SessionEventMap['turn/start']): HumanMessage {
  return toBaseMessage(turnStartMessage(data)) as HumanMessage;
}

/**
 * 這則 `HumanMessage` 是機器造的嗎——**有來源、而且不是 `user`**。
 * 不是 `HumanMessage` 也回 `false`：這個述詞問的是「人講話以外的 user-role 訊息」。
 */
export function isMachineMessage(message: BaseMessage | undefined): boolean {
  if (!HumanMessage.isInstance(message)) return false;
  return isMachineSource(messageSourceOf(message));
}

/**
 * 把一則 `BaseMessage` 換上記過的剪法（請求端用）。換成什麼見 {@link prunedContent}。
 *
 * @param message - 任何一則訊息；不是工具結果的原樣回。
 * @param recorded - `recordedPrunesOf` 的結果。
 * @returns 換過的新 `ToolMessage`（只換 `content`，其餘欄位原樣）；沒記過、或文字量對不上就是**傳進來的那一則**。
 */
export function applyRecordedPrune(message: BaseMessage, recorded: RecordedPrunes): BaseMessage {
  if (!ToolMessage.isInstance(message)) return message;
  const content = prunedContent(message.tool_call_id, message.content as MessageContent, recorded);
  return content === undefined
    ? message
    : new ToolMessage({ ...message, content: content as never });
}

/**
 * 把一串 `BaseMessage` 裡每一則記過的工具結果換上剪過的內容。
 *
 * @returns 一則都沒換時是**原本那個陣列**；否則長度與順序與輸入相同的新陣列。
 */
export function applyRecordedPrunes(
  messages: readonly BaseMessage[],
  recorded: RecordedPrunes,
): readonly BaseMessage[] {
  if (recorded.size === 0) return messages;
  let changed = false;
  const next = messages.map((message) => {
    const replaced = applyRecordedPrune(message, recorded);
    if (replaced !== message) changed = true;
    return replaced;
  });
  return changed ? next : messages;
}

/** 一則訊息的工具呼叫；不是助手訊息、或沒有工具呼叫就是 `undefined`。 */
function toolCallsOf(message: BaseMessage): AIMessage['tool_calls'] {
  if (!AIMessage.isInstance(message)) return undefined;
  return message.tool_calls !== undefined && message.tool_calls.length > 0
    ? message.tool_calls
    : undefined;
}

/**
 * 把一則 `BaseMessage` 裡每個記過的參數換上縮短後的字串（請求端用）。換成什麼見 {@link truncatedCalls}。
 *
 * @param message - 任何一則訊息；不是助手訊息、或沒有一個參數對得上的原樣回。
 * @param recorded - `recordedArgTruncationsOf` 的結果。
 * @returns 有換的時候是只換了 `tool_calls[i].args`（與同 id 的 `tool_call` 區塊）的新 `AIMessage`（其餘欄位原樣）；否則是傳進來的那一則。
 */
export function applyRecordedArgTruncation(
  message: BaseMessage,
  recorded: RecordedArgTruncations,
): BaseMessage {
  const calls = toolCallsOf(message);
  if (calls === undefined) return message;
  const source = message as AIMessage;
  const next = truncatedCalls(
    calls as readonly NexusToolCall[],
    source.content as MessageContent,
    recorded,
  );
  if (next === undefined) return message;
  return new AIMessage({
    ...source,
    content: next.content as never,
    tool_calls: next.tool_calls as AIMessage['tool_calls'],
  });
}

/**
 * 把一串 `BaseMessage` 裡每個記過的參數換上縮短後的字串。
 *
 * @returns 一則都沒換時是**原本那個陣列**；否則長度與順序與輸入相同的新陣列。
 */
export function applyRecordedArgTruncations(
  messages: readonly BaseMessage[],
  recorded: RecordedArgTruncations,
): readonly BaseMessage[] {
  if (recorded.size === 0) return messages;
  let changed = false;
  const next = messages.map((message) => {
    const replaced = applyRecordedArgTruncation(message, recorded);
    if (replaced !== message) changed = true;
    return replaced;
  });
  return changed ? next : messages;
}

/**
 * 拿基座交下去的串跟進來的串比，找出哪些工具呼叫的哪些參數被縮短了。
 *
 * 用工具呼叫 `id` 對，不用位置：交下去的串開頭可能多一則摘要、少一截舊訊息。**進來的串裡同一個 `id` 出現不只一次的不比**
 * （供應商重用 id，分不出是哪一個，見 `tool-arg-truncation-log.ts` 的檔頭）。字串參數的值不同就算，不管變長變短——
 * 日誌要證明的是「模型看到的那一份」，不是基座的規則。
 *
 * @param before - 交給基座之前的串（已套過記過的縮短）。
 * @param sent - 基座交下去的串。
 * @returns 新縮短的呼叫，照 `sent` 的順序；沒有就是空陣列。
 */
export function newlyTruncatedArgs(
  before: readonly BaseMessage[],
  sent: readonly BaseMessage[],
): NewlyTruncatedCall[] {
  const baseline = new Map<string, Readonly<Record<string, unknown>> | null>();
  for (const message of before) {
    for (const call of toolCallsOf(message) ?? []) {
      if (call.id === undefined) continue;
      baseline.set(call.id, baseline.has(call.id) ? null : (call.args as Record<string, unknown>));
    }
  }
  const found: NewlyTruncatedCall[] = [];
  for (const message of sent) {
    for (const call of toolCallsOf(message) ?? []) {
      if (call.id === undefined) continue;
      const original = baseline.get(call.id);
      if (original === undefined || original === null) continue;
      const args: Record<string, RecordedArgTruncation> = {};
      for (const [key, value] of Object.entries(call.args as Record<string, unknown>)) {
        const was = original[key];
        if (typeof value === 'string' && typeof was === 'string' && value !== was) {
          args[key] = { originalChars: was.length, value };
        }
      }
      if (Object.keys(args).length > 0) found.push({ callId: call.id, args });
    }
  }
  return found;
}

/**
 * 把基座這次新縮短的那幾則換回交給基座之前的原訊息（[#1702](https://github.com/DemianLi/nexus-agent/issues/1702)）：
 * `compaction/truncate-args` 記不進去時，這次的縮短不生效，模型看到的要跟日誌一致。
 *
 * **整則換回，不逐個參數改回**：基座縮短時整則重建訊息（見 `tool-arg-truncation-log.ts` 的檔頭），換回 `before` 裡那一則，`id` 與其餘欄位也一起回來。
 * 一則裡只要有一個呼叫在 `calls` 裡就換；`before` 裡同一個 `id` 出現不只一次的不換（分不出是哪一則，同 {@link newlyTruncatedArgs}）。
 * 日誌上記過、交給基座之前就換上去的那些縮短在 `before` 裡本來就是短的，所以照樣生效。
 *
 * @param before - 交給基座之前的串（已套過記過的縮短）。
 * @param sent - 基座交下去的串。
 * @param calls - {@link newlyTruncatedArgs} 的結果。
 * @returns 沒有要換的時候是 `sent` 本身；否則長度與順序與 `sent` 相同的新陣列。
 */
export function restoreNewlyTruncatedArgs(
  before: readonly BaseMessage[],
  sent: readonly BaseMessage[],
  calls: readonly NewlyTruncatedCall[],
): readonly BaseMessage[] {
  if (calls.length === 0) return sent;
  const owner = new Map<string, BaseMessage | null>();
  for (const message of before) {
    for (const call of toolCallsOf(message) ?? []) {
      if (call.id === undefined) continue;
      owner.set(call.id, owner.has(call.id) ? null : message);
    }
  }
  const truncated = new Set(calls.map((call) => call.callId));
  let changed = false;
  const next = sent.map((message) => {
    for (const call of toolCallsOf(message) ?? []) {
      if (call.id === undefined || !truncated.has(call.id)) continue;
      const original = owner.get(call.id);
      if (original === undefined || original === null) continue;
      changed = true;
      return original;
    }
    return message;
  });
  return changed ? next : sent;
}
