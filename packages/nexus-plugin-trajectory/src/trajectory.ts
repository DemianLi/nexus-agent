/**
 * 軌跡投影的折疊：把一份會話日誌（root 或子代理的，#1070）一輪一組折成 {@link TrajectoryView}（[#1027](https://github.com/DemianLi/nexus-agent/issues/1027)）。
 *
 * **全部從日誌折，不回寫日誌、不碰產品路徑。** `apply` 是純的、同步的，不相干的事件回**同一個參照**（通道靠這個省掉下游工作）；
 * 每顆事件只複製它碰到的那一輪與那一次呼叫，成本不隨會話長度長（長度被窗口封頂，見 `@nexus/wire` 的 `trajectory.ts`）。
 *
 * ## 歸屬：不看位置
 *
 * 模型呼叫靠 #1021 的識別（`model/start` 的 `seq`）：`model/end`、`model/usage`、`llm/retry*`、`assistant/message`、
 * `context/measure` 各帶 `modelCall`，工具靠 `callId` 出現在發出它的那則回覆的 `tool_calls[].id`。**規則與
 * `@nexus/core` 的 `createModelCallIndexer` 相同**（最近一則帶這個 id 的回覆勝出；那則沒有 `modelCall` 就歸不到、不落回更早的）。
 * 不直接用 indexer，是因為 `apply` 要純：indexer 是會就地改的物件，放進狀態要嘛改完回同一參照（通道當作沒變，一顆 frame 都不送），
 * 要嘛每次包新殼（每次都算有變）。所以這裡自己帶一張 callId→呼叫的表；**兩份實作由 `trajectory.test.ts` 的差分測試釘在一起**
 * （同一串事件，這裡歸給的呼叫與 indexer 歸給的必須一致）。歸不到的不猜：工具進 `looseTools`，模型事件計進 `unattributed`。
 *
 * ## 上限
 *
 * 窗口只封住輪數，一輪裡的量另有上限：最多留最新 {@link TRAJECTORY_TURN_CALLS_CAP} 次呼叫、一次呼叫最多留 {@link TRAJECTORY_CALL_TOOLS_CAP} 個工具、
 * `inputs`／`decisions`／`looseTools` 各最多 {@link TRAJECTORY_TURN_LIST_CAP} 筆。**摺掉的不讓計數變小**：摺掉的當下就把它們該貢獻的呼叫數、
 * 工具數、失敗數、重試數與用量記進 `carry`，`view` 加回去；`elided` 告訴讀的人有東西被摺掉了。代價是兩條明著的近似：摺掉的工具，
 * 失敗與否只記到摺掉當下；摺掉的呼叫，遲到的事件（用量、重試）靜靜丟掉並計進 `unattributed`。
 *
 * ## 輪
 *
 * 每顆 `turn/start` 開一輪（含 `resume`），`logical` 標它是不是開了新的邏輯輪（`resume` 不算：它接著上一輪停在核准點的那幾顆呼叫）。
 * 輪外的事件（標題、回饋…）不歸任何一輪；**輪中**的佇列變動與人插的話進 `inputs`，不算進任何一次模型呼叫——一對起訖之間夾著的
 * `inbox/spliced` 屬於輸入區（#1067 的承諾，這裡第一次有人讀）。
 *
 * ## 對日誌詞彙的讀法
 *
 * `goal/change`、`plan/mode`、`todo/write` 的種類是各自的擁有者套件用宣告合併補進來的；這裡**不依賴那些套件**，只讀它們
 * 公開事件裡的幾個結構化欄位，缺了就當作沒有（開放詞彙之後，窮舉只能在擁有者那一側做，#679）。
 *
 * @module
 */

import {
  isLogicalTurnStart,
  loggedContentBlocks,
  loggedMessageId,
  REPEAT_REMINDER_MARKER,
  toolCallIds,
} from '@nexus/core';
import { ProjectionDetailError } from '@nexus/core';
import type { ProjectionUnit, SessionEvent } from '@nexus/core';
import {
  TRAJECTORY_CALL_TOOLS_CAP,
  TRAJECTORY_DETAIL_TURNS,
  TRAJECTORY_DIGEST_CAP,
  TRAJECTORY_PREVIEW_CHARS,
  TRAJECTORY_PROJECTION,
  TRAJECTORY_TURN_CALLS_CAP,
  TRAJECTORY_TURN_LIST_CAP,
  TRAJECTORY_VERSION,
} from '@nexus/wire';
import type {
  TrajectoryApprovalOutcome,
  TrajectoryCall,
  TrajectoryDecision,
  TrajectoryDigest,
  TrajectoryEnd,
  TrajectoryInput,
  TrajectoryRetry,
  TrajectoryTool,
  TrajectoryTurn,
  TrajectoryTurnDetail,
  TrajectoryTurnKind,
  TrajectoryView,
} from '@nexus/wire';

/** 表裡的鍵：加前綴，免得 `"0"`、`"1"` 這種整數形的 id 被物件按數字序排到前面，把「最舊的先丟」的順序弄反。 */
const ownerKey = (callId: string): string => `#${callId}`;

/** 工具 id→呼叫 的表最多留幾筆；超過從最舊的丟。恢復（resume）要用到的只是還沒落定的那幾個，遠遠小於這個數。 */
const OWNERS_CAP = 2000;

/**
 * 一輪被單輪上限摺掉的東西的累計。**計數要含它們**（`callCount`／`toolCount`…不能因為摺掉而變小），所以摺掉的當下就把
 * 它們該貢獻的數字記在這裡。
 */
interface Carry {
  readonly calls: number;
  readonly tools: number;
  /** 摺掉的工具裡，摺掉當下已經是 `error` 的數目。 */
  readonly toolErrors: number;
  readonly retries: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** 摺掉的呼叫裡報了用量的有幾次，以及其中報了快取讀、快取寫的有幾次（全報才放進 view）。 */
  readonly usages: number;
  readonly cacheReadCalls: number;
  readonly cacheWriteCalls: number;
  readonly uncachedInputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly inputs: number;
  readonly decisions: number;
  /** 摺掉的工具裡，摺掉當下已帶子代理連結的數目。 */
  readonly subagents: number;
}

const NO_CARRY: Carry = {
  calls: 0,
  tools: 0,
  toolErrors: 0,
  retries: 0,
  inputTokens: 0,
  outputTokens: 0,
  usages: 0,
  cacheReadCalls: 0,
  cacheWriteCalls: 0,
  uncachedInputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  inputs: 0,
  decisions: 0,
  subagents: 0,
};

/** 狀態裡的一輪：沒有算出來的計數（那些在 `view` 才算），多一份摺掉的累計。 */
type TurnState = Omit<
  TrajectoryTurn,
  | 'callCount'
  | 'toolCount'
  | 'toolErrors'
  | 'subagentCount'
  | 'retryCount'
  | 'inputTokens'
  | 'outputTokens'
  | 'uncachedInputTokens'
  | 'cacheReadTokens'
  | 'cacheWriteTokens'
  | 'durationMs'
  | 'elided'
> & { readonly carry: Carry };

/** 折疊狀態。純 JSON（沒有 `undefined`）。 */
export interface TrajectoryState {
  readonly turns: readonly TurnState[];
  readonly digests: readonly TrajectoryDigest[];
  readonly omitted: number;
  /** 到目前為止開過幾輪（下一輪的 `index`）。 */
  readonly total: number;
  /** callId → 發出它的那次呼叫的識別；`null` 表示最近一則帶這個 id 的回覆歸不到（舊日誌）。 */
  readonly owners: Readonly<Record<string, number | null>>;
  /** 最近一份系統提示詞快照的位置、最近一份設定快照的位置與其中的模型 id；還沒看過就是 `null`。 */
  readonly system: number | null;
  readonly header: number | null;
  readonly model: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const preview = (text: string): string => {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length <= TRAJECTORY_PREVIEW_CHARS
    ? flat
    : `${flat.slice(0, TRAJECTORY_PREVIEW_CHARS - 1)}…`;
};

/** 一則訊息裡某種區塊的字數。 */
function blockChars(content: unknown, type: 'text' | 'reasoning'): number {
  let total = 0;
  for (const block of loggedContentBlocks(content as never) as unknown[]) {
    if (!isRecord(block) || block['type'] !== type) continue;
    const value = block[type];
    if (typeof value === 'string') total += value.length;
  }
  return total;
}

/** 空狀態。 */
export function initialTrajectory(): TrajectoryState {
  return {
    turns: [],
    digests: [],
    omitted: 0,
    total: 0,
    owners: {},
    system: null,
    header: null,
    model: null,
  };
}

/** 累加一格選填的快取桶：這一筆有報、而且（若已有累計）之前每一筆也都報了，才放。 */
function bucket(
  key: 'cacheReadTokens' | 'cacheWriteTokens',
  previous: { readonly cacheReadTokens?: number; readonly cacheWriteTokens?: number } | undefined,
  data: Readonly<Record<string, unknown>>,
): Partial<Record<typeof key, number>> {
  const reported = data[key];
  if (typeof reported !== 'number') return {};
  if (previous === undefined) return { [key]: reported };
  const before = previous[key];
  return before === undefined ? {} : { [key]: before + reported };
}

// ── 計數與摘要（view 才算） ─────────────────────────────────────────────────────────────

function withCounts(turn: TurnState): TrajectoryTurn {
  const { carry, ...rest } = turn;
  let toolCount = turn.looseTools.length + carry.tools;
  let toolErrors =
    turn.looseTools.filter((tool) => tool.status === 'error').length + carry.toolErrors;
  let subagentCount =
    turn.looseTools.filter((tool) => tool.subagent !== undefined).length + carry.subagents;
  let retryCount = carry.retries;
  let inputTokens = carry.inputTokens;
  let outputTokens = carry.outputTokens;
  let usages = carry.usages;
  let cacheReadCalls = carry.cacheReadCalls;
  let cacheWriteCalls = carry.cacheWriteCalls;
  let uncachedInputTokens = carry.uncachedInputTokens;
  let cacheReadTokens = carry.cacheReadTokens;
  let cacheWriteTokens = carry.cacheWriteTokens;
  for (const call of turn.calls) {
    const usage = call.usage;
    if (usage !== undefined) {
      usages += 1;
      uncachedInputTokens += usage.uncachedInputTokens ?? 0;
      if (usage.cacheReadTokens !== undefined) {
        cacheReadCalls += 1;
        cacheReadTokens += usage.cacheReadTokens;
      }
      if (usage.cacheWriteTokens !== undefined) {
        cacheWriteCalls += 1;
        cacheWriteTokens += usage.cacheWriteTokens;
      }
    }
    toolCount += call.tools.length;
    toolErrors += call.tools.filter((tool) => tool.status === 'error').length;
    subagentCount += call.tools.filter((tool) => tool.subagent !== undefined).length;
    retryCount += call.retries.length;
    inputTokens += call.usage?.inputTokens ?? 0;
    outputTokens += call.usage?.outputTokens ?? 0;
  }
  const folded = carry.calls > 0 || carry.tools > 0 || carry.inputs > 0 || carry.decisions > 0;
  return {
    ...rest,
    callCount: turn.calls.length + carry.calls,
    toolCount,
    toolErrors,
    subagentCount,
    retryCount,
    inputTokens,
    outputTokens,
    uncachedInputTokens,
    ...(usages > 0 && cacheReadCalls === usages ? { cacheReadTokens } : {}),
    ...(usages > 0 && cacheWriteCalls === usages ? { cacheWriteTokens } : {}),
    ...(turn.endTime === undefined ? {} : { durationMs: turn.endTime - turn.time }),
    ...(folded
      ? {
          elided: {
            calls: carry.calls,
            tools: carry.tools,
            inputs: carry.inputs,
            decisions: carry.decisions,
          },
        }
      : {}),
  };
}

function digestOf(turn: TurnState): TrajectoryDigest {
  const full = withCounts(turn);
  return {
    index: full.index,
    seq: full.seq,
    time: full.time,
    kind: full.kind,
    logical: full.logical,
    ...(full.end === undefined ? {} : { end: full.end }),
    ...(full.failureCode === undefined ? {} : { failureCode: full.failureCode }),
    ...(full.endTime === undefined ? {} : { endTime: full.endTime }),
    ...(full.durationMs === undefined ? {} : { durationMs: full.durationMs }),
    callCount: full.callCount,
    toolCount: full.toolCount,
    toolErrors: full.toolErrors,
    subagentCount: full.subagentCount,
    retryCount: full.retryCount,
    inputTokens: full.inputTokens,
    outputTokens: full.outputTokens,
    ...(full.uncachedInputTokens === undefined
      ? {}
      : { uncachedInputTokens: full.uncachedInputTokens }),
    ...(full.cacheReadTokens === undefined ? {} : { cacheReadTokens: full.cacheReadTokens }),
    ...(full.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: full.cacheWriteTokens }),
  };
}

// ── 更新的小工具（結構共享：只複製碰到的那一路） ─────────────────────────────────────

function replaceAt<T>(list: readonly T[], at: number, value: T): readonly T[] {
  const next = list.slice();
  next[at] = value;
  return next;
}

interface CallAt {
  readonly turn: number;
  readonly call: number;
}

/** 在窗口裡由新到舊找一次呼叫。窗口外（已成摘要）的找不到——遲到的事件靜靜丟掉。 */
function locateCall(state: TrajectoryState, id: number): CallAt | undefined {
  for (let t = state.turns.length - 1; t >= 0; t -= 1) {
    const calls = state.turns[t]!.calls;
    for (let c = calls.length - 1; c >= 0; c -= 1) {
      if (calls[c]!.id === id) return { turn: t, call: c };
    }
  }
  return undefined;
}

function updateCall(
  state: TrajectoryState,
  at: CallAt,
  change: (call: TrajectoryCall) => TrajectoryCall,
): TrajectoryState {
  const turn = state.turns[at.turn]!;
  const call = turn.calls[at.call]!;
  const next = change(call);
  if (next === call) return state;
  return {
    ...state,
    turns: replaceAt(state.turns, at.turn, {
      ...turn,
      calls: replaceAt(turn.calls, at.call, next),
    }),
  };
}

function updateLastTurn(
  state: TrajectoryState,
  change: (turn: TurnState) => TurnState,
): TrajectoryState {
  const last = state.turns.length - 1;
  if (last < 0) return state;
  const turn = state.turns[last]!;
  const next = change(turn);
  return next === turn ? state : { ...state, turns: replaceAt(state.turns, last, next) };
}

/** 最後一輪還開著（沒有收尾）才回它。 */
const openTurn = (state: TrajectoryState): TurnState | undefined => {
  const turn = state.turns.at(-1);
  return turn !== undefined && turn.end === undefined ? turn : undefined;
};

/** 清單超過上限就丟最舊的，回新清單與被丟掉的那幾筆。 */
function capList<T>(
  list: readonly T[],
  cap: number,
): { kept: readonly T[]; dropped: readonly T[] } {
  const cut = list.length - cap;
  return cut <= 0
    ? { kept: list, dropped: [] }
    : { kept: list.slice(cut), dropped: list.slice(0, cut) };
}

function withDecision(state: TrajectoryState, decision: TrajectoryDecision): TrajectoryState {
  return updateLastTurn(state, (turn) => {
    const { kept, dropped } = capList([...turn.decisions, decision], TRAJECTORY_TURN_LIST_CAP);
    return {
      ...turn,
      decisions: kept,
      carry: { ...turn.carry, decisions: turn.carry.decisions + dropped.length },
    };
  });
}

const APPROVAL_OUTCOMES: readonly TrajectoryApprovalOutcome[] = [
  'allowed-once',
  'rejected',
  'cancelled',
  'unavailable',
];

function isApprovalOutcome(value: unknown): value is TrajectoryApprovalOutcome {
  return APPROVAL_OUTCOMES.some((each) => each === value);
}

/** 任何一輪裡是否已有這個 id 的中斷列。 */
function hasInterrupt(state: TrajectoryState, id: string): boolean {
  return state.turns.some((turn) =>
    turn.decisions.some((decision) => decision.kind === 'interrupt' && decision.id === id),
  );
}

/**
 * 改某顆中斷的決策列（以中斷 id 認）。**結局落在回答它的那一輪（`resume`），中斷在前一輪**，所以往回找所有留著逐呼叫
 * 結構的輪；找不到（被摺進摘要、或根本不是人那條路）就原樣不動。
 */
function settleInterrupt(
  state: TrajectoryState,
  id: string,
  change: (decision: Extract<TrajectoryDecision, { kind: 'interrupt' }>) => TrajectoryDecision,
): TrajectoryState {
  for (let t = state.turns.length - 1; t >= 0; t -= 1) {
    const turn = state.turns[t]!;
    const at = turn.decisions.findIndex(
      (decision) => decision.kind === 'interrupt' && decision.id === id,
    );
    if (at < 0) continue;
    const decision = turn.decisions[at]!;
    if (decision.kind !== 'interrupt') continue;
    const next = change(decision);
    if (next === decision) return state;
    return {
      ...state,
      turns: replaceAt(state.turns, t, {
        ...turn,
        decisions: replaceAt(turn.decisions, at, next),
      }),
    };
  }
  return state;
}

function withInput(state: TrajectoryState, input: TrajectoryInput): TrajectoryState {
  if (openTurn(state) === undefined) return state;
  return updateLastTurn(state, (turn) => {
    const { kept, dropped } = capList([...turn.inputs, input], TRAJECTORY_TURN_LIST_CAP);
    return {
      ...turn,
      inputs: kept,
      carry: { ...turn.carry, inputs: turn.carry.inputs + dropped.length },
    };
  });
}

/** 就地改的歸屬表目前有幾筆（只有按需拉細節的重放用就地改，見 {@link TrimPolicy.ownersInPlace}）。 */
const inPlaceSizes = new WeakMap<object, number>();

/** 工具表：加進一筆擁有者，超過上限從最舊的丟。 */
function noteOwners(
  owners: Readonly<Record<string, number | null>>,
  ids: readonly string[],
  owner: number | null,
  inPlace: boolean,
): Readonly<Record<string, number | null>> {
  if (ids.length === 0) return owners;
  if (inPlace) {
    // 重放自己獨佔這張表：每筆都複製整張（上限 2000）會讓重放成本隨會話長度平方長。就地改，語意相同（先刪再放、丟最舊的）。
    const table = owners as Record<string, number | null>;
    let size = inPlaceSizes.get(table) ?? Object.keys(table).length;
    for (const id of ids) {
      if (Object.hasOwn(table, ownerKey(id))) size -= 1;
      delete table[ownerKey(id)];
      table[ownerKey(id)] = owner;
      size += 1;
    }
    // 批次丟：超過兩倍上限才一次丟回上限，攤下來每筆 O(1)。代價是重放的表最多比推送的多留 {@link OWNERS_CAP} 筆較舊的歸屬——
    // 更遠以前的遲到事件在這裡認得出歸屬、在推送的投影裡認不出（那裡窗口外的輪本來就丟掉遲到事件），細節比骨架完整，不是更差。
    if (size > OWNERS_CAP * 2) {
      for (const key of Object.keys(table).slice(0, size - OWNERS_CAP)) delete table[key];
      size = OWNERS_CAP;
    }
    inPlaceSizes.set(table, size);
    return table;
  }
  const next: Record<string, number | null> = { ...owners };
  for (const id of ids) {
    // 先刪再放：同一個 id 重新出現要排到最新。
    delete next[ownerKey(id)];
    next[ownerKey(id)] = owner;
  }
  const keys = Object.keys(next);
  for (let drop = 0; drop < keys.length - OWNERS_CAP; drop += 1) delete next[keys[drop]!];
  return next;
}

// ── 工具 ────────────────────────────────────────────────────────────────────────────

function upsertTool(
  tools: readonly TrajectoryTool[],
  tool: TrajectoryTool,
): readonly TrajectoryTool[] {
  const at = tools.findIndex((each) => each.callId === tool.callId);
  return at < 0 ? [...tools, tool] : replaceAt(tools, at, tool);
}

/**
 * 把一顆跟工具有關的事件折到它所屬的呼叫上；歸不到進 `looseTools`。
 *
 * @param change - 對既有的那筆工具（沒有就 `undefined`）算出新的一筆。
 */
function applyTool(
  state: TrajectoryState,
  callId: string,
  change: (previous: TrajectoryTool | undefined) => TrajectoryTool | undefined,
): TrajectoryState {
  const owner = state.owners[ownerKey(callId)];
  if (owner === undefined || owner === null) {
    // 歸不到：放進目前開著那一輪的 looseTools（輪外沒有地方放，丟）。
    if (openTurn(state) === undefined) return state;
    return updateLastTurn(state, (turn) => {
      const previous = turn.looseTools.find((each) => each.callId === callId);
      const next = change(previous);
      if (next === undefined) return turn;
      const { kept, dropped } = capList(
        upsertTool(turn.looseTools, next),
        TRAJECTORY_TURN_LIST_CAP,
      );
      return { ...turn, looseTools: kept, carry: carryTools(turn.carry, dropped) };
    });
  }
  const at = locateCall(state, owner);
  if (at === undefined) return state;
  const changed = updateCall(state, at, (call) => {
    const previous = call.tools.find((each) => each.callId === callId);
    const next = change(previous);
    return next === undefined ? call : { ...call, tools: upsertTool(call.tools, next) };
  });
  return capCallTools(changed, at);
}

/** 摺掉的工具記進累計：數目與當下已失敗的數目。 */
function carryTools(carry: Carry, dropped: readonly TrajectoryTool[]): Carry {
  if (dropped.length === 0) return carry;
  return {
    ...carry,
    tools: carry.tools + dropped.length,
    toolErrors: carry.toolErrors + dropped.filter((tool) => tool.status === 'error').length,
    subagents: carry.subagents + dropped.filter((tool) => tool.subagent !== undefined).length,
  };
}

/** 一次呼叫的工具超過上限就丟最舊的，記進那一輪的累計。 */
function capCallTools(state: TrajectoryState, at: CallAt): TrajectoryState {
  const turn = state.turns[at.turn]!;
  const call = turn.calls[at.call]!;
  if (call.tools.length <= TRAJECTORY_CALL_TOOLS_CAP) return state;
  const { kept, dropped } = capList(call.tools, TRAJECTORY_CALL_TOOLS_CAP);
  const next: TurnState = {
    ...turn,
    calls: replaceAt(turn.calls, at.call, { ...call, tools: kept }),
    carry: carryTools(turn.carry, dropped),
  };
  return { ...state, turns: replaceAt(state.turns, at.turn, next) };
}

// ── 折疊 ────────────────────────────────────────────────────────────────────────────

function endOf(reason: unknown): TrajectoryEnd {
  if (!isRecord(reason)) return 'completed';
  switch (reason['kind']) {
    case 'aborted':
      return 'aborted';
    case 'max-tokens':
      return 'max-tokens';
    case 'interrupted':
      return 'interrupted';
    case 'blocked':
      return 'blocked';
    default:
      return 'completed';
  }
}

/** 一顆 `turn/start` 的預覽來源。 */
function startText(data: Record<string, unknown>): string | undefined {
  switch (data['kind']) {
    case 'message':
    case 'agent-message':
    case 'goal':
      return typeof data['text'] === 'string' ? data['text'] : undefined;
    case 'subagent-settled':
      return typeof data['summary'] === 'string' ? data['summary'] : undefined;
    default:
      return undefined;
  }
}

const TURN_KINDS: ReadonlySet<string> = new Set([
  'message',
  'resume',
  'agent-message',
  'subagent-settled',
  'goal',
]);

/**
 * 窗口的裁法。預設（推送的投影）是只留最新 {@link TRAJECTORY_DETAIL_TURNS} 輪；按需拉細節時重放整份日誌，`pinned` 指到的輪**不裁**
 * （目標邏輯輪的實體輪們），好讓之後才到的事件還記得進去。
 */
interface TrimPolicy {
  readonly detailTurns: number;
  /** 以輪的 `seq` 判斷；省略就都不釘。 */
  readonly pinned?: (seq: number) => boolean;
  /** 歸屬表就地改。**只有獨佔狀態的重放可以開**（推送的投影要純，狀態會被通道拿去比對）。 */
  readonly ownersInPlace?: true;
}

const DEFAULT_TRIM: TrimPolicy = { detailTurns: TRAJECTORY_DETAIL_TURNS };

function startTurn(state: TrajectoryState, event: SessionEvent, trim: TrimPolicy): TrajectoryState {
  const data = event.data as unknown as Record<string, unknown>;
  const kindRaw = data['kind'];
  // 不認得的 `turn/start` 種類（之後才長出來的）照樣開一輪，標成 message 以外沒有的誠實做法是丟掉它的預覽。
  const kind: TrajectoryTurnKind = TURN_KINDS.has(String(kindRaw))
    ? (kindRaw as TrajectoryTurnKind)
    : 'message';
  const text = startText(data);
  const turn: TurnState = {
    index: state.total,
    seq: event.seq,
    time: event.time,
    kind,
    logical: isLogicalTurnStart(event),
    ...(text === undefined ? {} : { preview: preview(text), chars: text.length }),
    inputs: [],
    calls: [],
    looseTools: [],
    decisions: [],
    unattributed: 0,
    carry: NO_CARRY,
  };
  let turns = [...state.turns, turn];
  let digests = state.digests;
  let omitted = state.omitted;
  const pinned = trim.pinned ?? ((): boolean => false);
  while (turns.filter((each) => !pinned(each.seq)).length > trim.detailTurns) {
    const at = turns.findIndex((each) => !pinned(each.seq));
    digests = [...digests, digestOf(turns[at]!)];
    turns = turns.filter((_, index) => index !== at);
    if (digests.length > TRAJECTORY_DIGEST_CAP) {
      digests = digests.slice(digests.length - TRAJECTORY_DIGEST_CAP);
      omitted += 1;
    }
  }
  return { ...state, turns, digests, omitted, total: state.total + 1 };
}

/** 沒有 `turn/start` 的日誌的那一輪：從第一次模型呼叫開始，不會收尾。 */
function startRun(state: TrajectoryState, event: SessionEvent): TrajectoryState {
  const turn: TurnState = {
    index: 0,
    seq: event.seq,
    time: event.time,
    kind: 'run',
    logical: true,
    inputs: [],
    calls: [],
    looseTools: [],
    decisions: [],
    unattributed: 0,
    carry: NO_CARRY,
  };
  return { ...state, turns: [turn], total: 1 };
}

function closeTurn(
  state: TrajectoryState,
  event: SessionEvent,
  end: TrajectoryEnd,
  failure?: string,
  failureCode?: string,
): TrajectoryState {
  if (openTurn(state) === undefined) return state;
  return updateLastTurn(state, (turn) => ({
    ...turn,
    end,
    endSeq: event.seq,
    endTime: event.time,
    ...(failure === undefined ? {} : { failure: preview(failure) }),
    ...(failureCode === undefined ? {} : { failureCode }),
  }));
}

/** 事件指到的呼叫不存在（`modelCall` 缺席、指到窗口外）：計進最後一輪的 `unattributed`。 */
function unattributed(state: TrajectoryState): TrajectoryState {
  if (openTurn(state) === undefined) return state;
  return updateLastTurn(state, (turn) => ({ ...turn, unattributed: turn.unattributed + 1 }));
}

function onCall(
  state: TrajectoryState,
  modelCall: unknown,
  change: (call: TrajectoryCall) => TrajectoryCall,
): TrajectoryState {
  const at = typeof modelCall === 'number' ? locateCall(state, modelCall) : undefined;
  return at === undefined ? unattributed(state) : updateCall(state, at, change);
}

function startCall(prior: TrajectoryState, event: SessionEvent): TrajectoryState {
  // 一份整份都沒有 `turn/start` 的日誌（前景子代理，#1070）：第一次模型呼叫開一輪 `run`，不然它的呼叫與工具全落在輪外、被丟掉。
  // 只在「一輪都還沒開過」時開：root 的第一次模型呼叫一定在 `turn/start` 之後，所以這一條對 root 不會觸發；之後輪外的呼叫照舊丟。
  const state = prior.total === 0 && prior.turns.length === 0 ? startRun(prior, event) : prior;
  if (openTurn(state) === undefined) return state;
  const call: TrajectoryCall = {
    id: event.seq,
    time: event.time,
    ...(state.model === null ? {} : { model: state.model }),
    ...(state.system === null ? {} : { system: state.system }),
    ...(state.header === null ? {} : { header: state.header }),
    retries: [],
    tools: [],
  };
  return updateLastTurn(state, (turn) => {
    const { kept, dropped } = capList([...turn.calls, call], TRAJECTORY_TURN_CALLS_CAP);
    if (dropped.length === 0) return { ...turn, calls: kept };
    let carry = turn.carry;
    for (const gone of dropped) {
      carry = carryTools(carry, gone.tools);
      carry = {
        ...carry,
        calls: carry.calls + 1,
        retries: carry.retries + gone.retries.length,
        inputTokens: carry.inputTokens + (gone.usage?.inputTokens ?? 0),
        outputTokens: carry.outputTokens + (gone.usage?.outputTokens ?? 0),
        ...(gone.usage === undefined
          ? {}
          : {
              usages: carry.usages + 1,
              uncachedInputTokens:
                carry.uncachedInputTokens + (gone.usage.uncachedInputTokens ?? 0),
              cacheReadCalls:
                carry.cacheReadCalls + (gone.usage.cacheReadTokens === undefined ? 0 : 1),
              cacheReadTokens: carry.cacheReadTokens + (gone.usage.cacheReadTokens ?? 0),
              cacheWriteCalls:
                carry.cacheWriteCalls + (gone.usage.cacheWriteTokens === undefined ? 0 : 1),
              cacheWriteTokens: carry.cacheWriteTokens + (gone.usage.cacheWriteTokens ?? 0),
            }),
      };
    }
    return { ...turn, calls: kept, carry };
  });
}

/**
 * 軌跡投影的 `apply`。
 *
 * @param state - 目前的狀態。
 * @param event - 日誌的下一顆事件。
 * @param trim - 窗口的裁法，只有按需拉細節（{@link trajectoryTurnDetail}）會換掉預設。
 * @returns 新狀態；不相干的事件回傳同一個參照。
 */
export function applyTrajectory(
  state: TrajectoryState,
  event: SessionEvent,
  trim: TrimPolicy = DEFAULT_TRIM,
): TrajectoryState {
  // 擁有者套件才宣告的種類（`goal/change`…）不在 core 的聯集裡，所以用字串比，資料當未知結構讀。
  const type: string = event.type;
  const data = event.data as unknown as Record<string, unknown>;
  switch (type) {
    case 'turn/start':
      return startTurn(state, event, trim);
    case 'turn/end': {
      const end = endOf(data['reason']);
      return closeTurn(state, event, end);
    }
    case 'turn/failed':
      return closeTurn(
        state,
        event,
        'failed',
        typeof data['message'] === 'string' ? data['message'] : '',
        isRecord(data['error']) &&
          typeof data['error']['code'] === 'string' &&
          data['error']['code'] !== ''
          ? data['error']['code']
          : undefined,
      );
    case 'model/start':
      return startCall(state, event);
    case 'model/end':
      return onCall(state, data['modelCall'], (call) => ({
        ...call,
        endTime: event.time,
        durationMs: event.time - call.time,
        ...(data['outcome'] === 'error' || data['outcome'] === 'aborted'
          ? { outcome: data['outcome'] }
          : {}),
      }));
    case 'model/usage':
      return onCall(state, data['modelCall'], (call) => ({
        ...call,
        usage: {
          // 未快取那一桶（#724，照 dsh 的四桶互不重疊）：格式 36 起日誌的 `inputTokens` 本來就是它，快取兩格另放；
          // 舊日誌沒有那兩格，`inputTokens` 就是整個 prompt（沒記快取，也就沒有可分的）。
          inputTokens: (call.usage?.inputTokens ?? 0) + Number(data['inputTokens'] ?? 0),
          outputTokens: (call.usage?.outputTokens ?? 0) + Number(data['outputTokens'] ?? 0),
          totalTokens: (call.usage?.totalTokens ?? 0) + Number(data['totalTokens'] ?? 0),
          uncachedInputTokens:
            (call.usage?.uncachedInputTokens ?? 0) + Number(data['inputTokens'] ?? 0),
          // 快取兩格缺席＝沒記；同一次呼叫的多筆用量只要有一筆沒報就整格缺席（不拿一部分當總數）。
          ...bucket('cacheReadTokens', call.usage, data),
          ...bucket('cacheWriteTokens', call.usage, data),
        },
      }));
    case 'context/measure':
      return onCall(state, data['modelCall'], (call) => ({
        ...call,
        measure: {
          approxTokens: Number(data['approxTokens'] ?? 0),
          messageCount: Number(data['messageCount'] ?? 0),
        },
      }));
    case 'llm/retry': {
      const failure = isRecord(data['failure']) ? data['failure'] : {};
      const retry: TrajectoryRetry = {
        seq: event.seq,
        time: event.time,
        retry: Number(data['retry'] ?? 0),
        maxRetries: Number(data['maxRetries'] ?? 0),
        retryId: String(data['retryId']),
        code: typeof failure['code'] === 'string' ? failure['code'] : 'UNKNOWN',
        ...(typeof failure['status'] === 'number' ? { status: failure['status'] } : {}),
      };
      return onCall(state, data['modelCall'], (call) => ({
        ...call,
        retries: [...call.retries, retry],
      }));
    }
    case 'llm/retry-started':
      return onCall(state, data['modelCall'], (call) => {
        const at = call.retries.findIndex(
          (each) => each.retryId === data['retryId'] && each.retry === Number(data['retry']),
        );
        if (at < 0) return call;
        return {
          ...call,
          retries: replaceAt(call.retries, at, {
            ...call.retries[at]!,
            waitedMs: Number(data['waitedMs'] ?? 0),
          }),
        };
      });
    case 'assistant/message': {
      const message = (data as { message?: { data?: { content?: unknown; id?: unknown } } })
        .message;
      const modelCall = typeof data['modelCall'] === 'number' ? data['modelCall'] : null;
      const at = modelCall === null ? undefined : locateCall(state, modelCall);
      const ids = toolCallIds(event as SessionEvent<'assistant/message'>);
      // 工具的歸屬先記：歸不到的回覆也要蓋掉同 id 較早的歸屬（null），否則工具會落到更早一次呼叫上。
      const owners = noteOwners(
        state.owners,
        ids,
        at === undefined ? null : modelCall,
        trim.ownersInPlace === true,
      );
      const withOwners = owners === state.owners ? state : { ...state, owners };
      if (at === undefined) return unattributed(withOwners);
      const messageId = message === undefined ? undefined : loggedMessageId(message as never);
      return updateCall(withOwners, at, (call) => ({
        ...call,
        reply: {
          seq: event.seq,
          time: event.time,
          ...(messageId === undefined ? {} : { messageId }),
          ...(data['interrupted'] === true ? { interrupted: true as const } : {}),
          textChars: blockChars(message?.data?.content, 'text'),
          reasoningChars: blockChars(message?.data?.content, 'reasoning'),
          toolCalls: ids.length,
        },
      }));
    }
    case 'tool/call': {
      const callId = String(data['callId']);
      return applyTool(state, callId, (previous) => ({
        callId,
        name: String(data['name']),
        seq: event.seq,
        time: event.time,
        status: 'running',
        ...(previous?.subagent === undefined ? {} : { subagent: previous.subagent }),
      }));
    }
    case 'tool/result': {
      const callId = String(data['callId']);
      const error = isRecord(data['error']) ? data['error'] : undefined;
      const code =
        error !== undefined && typeof error['code'] === 'string' ? error['code'] : undefined;
      return applyTool(state, callId, (previous) =>
        previous === undefined
          ? undefined
          : {
              ...previous,
              status: data['isError'] === true ? 'error' : 'ok',
              endTime: event.time,
              durationMs: event.time - previous.time,
              ...(code === undefined ? {} : { code }),
            },
      );
    }
    case 'subagent/catalog': {
      const callId = String(data['callId']);
      const childId = String(data['childId']);
      return applyTool(state, callId, (previous) =>
        previous === undefined
          ? undefined
          : {
              ...previous,
              subagent: {
                childId,
                runId: childId.slice(childId.lastIndexOf('/') + 1),
                mode: data['mode'] === 'continuable' ? 'continuable' : 'one-shot',
                catalogSeq: event.seq,
              },
            },
      );
    }
    case 'request/system':
      return noteSnapshot(state, event, data, 'system');
    case 'request/header':
      return noteSnapshot(state, event, data, 'header');
    case 'user/message':
      return onUserMessage(state, event, data);
    case 'inbox/spliced': {
      const inserted = Array.isArray(data['inserted']) ? data['inserted'].length : 0;
      const removed = typeof data['removedCount'] === 'number' ? data['removedCount'] : 0;
      return withInput(state, {
        seq: event.seq,
        time: event.time,
        source: 'inbox',
        inserted,
        removed,
      });
    }
    case 'compaction/summary':
      return withDecision(state, {
        kind: 'compaction',
        seq: event.seq,
        time: event.time,
        cutoffIndex: Number(data['cutoffIndex'] ?? 0),
        messagesBefore: Number(data['messagesBefore'] ?? 0),
      });
    case 'interrupt/raised': {
      // 一輪裡有好幾顆要答的（一批工具各自要核准），答掉一顆後沒答的會在恢復那一輪**以同一個 id 再掛一次**。
      // 同 id 是同一個問題，不長第二列——否則它搶走之後的結局、側欄看到一個永遠「等著」的重複列。
      const raisedId = data['interruptId'];
      if (typeof raisedId === 'string' && hasInterrupt(state, raisedId)) return state;
      return withDecision(state, {
        kind: 'interrupt',
        seq: event.seq,
        time: event.time,
        ...(typeof raisedId === 'string' ? { id: raisedId } : {}),
      });
    }
    case 'approval/asked': {
      // 核准的問題掛在它的那顆中斷上（人那條路上兩者同 id，pump 在同一刻寫）。找不到中斷的是不必問人就確定的
      // （政策關掉、沒有管道）：沒有人被擋下來等，結局在那一次呼叫的錯誤碼上，不在這裡。
      const id = data['id'];
      const tool = data['toolName'];
      if (typeof id !== 'string' || typeof tool !== 'string') return state;
      return settleInterrupt(state, id, (decision) => ({
        ...decision,
        approval: {
          tool,
          ...(typeof data['callId'] === 'string' ? { callId: data['callId'] } : {}),
        },
      }));
    }
    case 'approval/decided': {
      const id = data['id'];
      const outcome = data['outcome'];
      if (typeof id !== 'string' || !isApprovalOutcome(outcome)) return state;
      return settleInterrupt(state, id, (decision) =>
        decision.approval === undefined
          ? decision
          : { ...decision, approval: { ...decision.approval, outcome, decidedAt: event.time } },
      );
    }
    case 'goal/change': {
      const goal = isRecord(data['goal']) ? data['goal'] : undefined;
      return withDecision(state, {
        kind: 'goal',
        seq: event.seq,
        time: event.time,
        ...(typeof data['operation'] === 'string' ? { operation: data['operation'] } : {}),
        ...(goal !== undefined && typeof goal['phase'] === 'string'
          ? { phase: goal['phase'] }
          : {}),
      });
    }
    case 'plan/mode':
      return withDecision(state, {
        kind: 'plan',
        seq: event.seq,
        time: event.time,
        active: data['active'] === true,
      });
    case 'todo/write':
      return withDecision(state, {
        kind: 'todo',
        seq: event.seq,
        time: event.time,
        items: Array.isArray(data['todos']) ? data['todos'].length : 0,
      });
    default:
      return state;
  }
}

/** 請求快照：記下「最近一份」的位置，並把它指給記下它的那次呼叫。 */
function noteSnapshot(
  state: TrajectoryState,
  event: SessionEvent,
  data: Record<string, unknown>,
  which: 'system' | 'header',
): TrajectoryState {
  let model = state.model;
  if (which === 'header') {
    const header = isRecord(data['header']) ? data['header'] : undefined;
    const config =
      header !== undefined && isRecord(header['config']) ? header['config'] : undefined;
    if (config !== undefined && typeof config['model'] === 'string') model = config['model'];
  }
  const next: TrajectoryState = { ...state, [which]: event.seq, model };
  const at =
    typeof data['modelCall'] === 'number' ? locateCall(next, data['modelCall']) : undefined;
  if (at === undefined) return next;
  return updateCall(next, at, (call) => ({
    ...call,
    [which]: event.seq,
    ...(which === 'header' && model !== null ? { model } : {}),
  }));
}

function onUserMessage(
  state: TrajectoryState,
  event: SessionEvent,
  data: Record<string, unknown>,
): TrajectoryState {
  const source = isRecord(data['source']) ? data['source'] : {};
  const kind = typeof source['kind'] === 'string' ? source['kind'] : 'unknown';
  if (kind === 'plugin') {
    const plugin = typeof source['plugin'] === 'string' ? source['plugin'] : 'unknown';
    const message = isRecord(data['message']) ? data['message'] : {};
    const inner = isRecord(message['data']) ? message['data'] : {};
    const kwargs = isRecord(inner['additional_kwargs']) ? inner['additional_kwargs'] : {};
    const marker = kwargs[REPEAT_REMINDER_MARKER];
    if (isRecord(marker)) {
      return withDecision(state, {
        kind: 'reminder',
        seq: event.seq,
        time: event.time,
        ...(typeof marker['tool'] === 'string' ? { tool: marker['tool'] } : {}),
        ...(typeof marker['count'] === 'number' ? { count: marker['count'] } : {}),
      });
    }
    return withDecision(state, {
      kind: 'plugin-message',
      seq: event.seq,
      time: event.time,
      plugin,
    });
  }
  // 人插的話、子代理來信與結算通知：輪中的輸入。`session-reference` 的快照是模型讀的背景，不是輸入。
  if (kind === 'session-reference') return state;
  const message = isRecord(data['message']) ? data['message'] : {};
  const inner = isRecord(message['data']) ? message['data'] : {};
  const text = textOfContent(inner['content']);
  return withInput(state, {
    seq: event.seq,
    time: event.time,
    source: kind,
    ...(kind === 'user' || kind === 'agent-message'
      ? { preview: preview(text) }
      : typeof source['summary'] === 'string'
        ? { preview: preview(source['summary']) }
        : {}),
  });
}

function textOfContent(content: unknown): string {
  let text = '';
  for (const block of loggedContentBlocks(content as never) as unknown[]) {
    if (isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string') {
      text += block['text'];
    }
  }
  return text;
}

/**
 * 狀態→送給 web 的 view。
 *
 * @param state - 折疊狀態。
 */
export function viewTrajectory(state: TrajectoryState): TrajectoryView {
  // `run` 輪（前景子代理）永不收尾，沒有「結束後退成摘要」的時刻，所以在 view 這一層直接只出摘要：K 個子代理的瀏覽器狀態
  // 不該是 K 份完整輪。它只會是日誌的第一輪（`startRun` 只在一輪都還沒開過時開），所以接在 `digests` 後面仍然是由舊到新。
  const running = state.turns.filter((turn) => turn.kind === 'run');
  return {
    digests: running.length === 0 ? state.digests : [...state.digests, ...running.map(digestOf)],
    omitted: state.omitted,
    turns: state.turns.filter((turn) => turn.kind !== 'run').map(withCounts),
  };
}

// ── 按需細節 ────────────────────────────────────────────────────────────────────────

/** 錨點的 `seq`：非負整數，數字或數字字串（來自網址）。 */
function anchorSeq(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const number = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0) {
    throw new ProjectionDetailError('invalid-argument', 'seq 要是非負整數');
  }
  return number;
}

/** 對話裡那則回覆的 `assistant/message` 事件位置；同一個 id 出現多次取最後一次（對話端也是後者取代前者）。 */
function seqOfMessage(events: readonly SessionEvent[], messageId: string): number | undefined {
  let found: number | undefined;
  for (const event of events) {
    if (event.type !== 'assistant/message') continue;
    const message = (event.data as { message?: unknown }).message;
    if (message !== undefined && loggedMessageId(message as never) === messageId) {
      found = event.seq;
    }
  }
  return found;
}

/**
 * **按需拉一個邏輯輪**（[#1083](https://github.com/DemianLi/nexus-agent/issues/1083)）：把整份日誌餵進同一個 {@link applyTrajectory}，
 * 目標邏輯輪（它的實體輪們：開頭那顆 `logical` 輪加上它的 resume 輪）釘住不裁，其餘照預設只留最新一輪。
 *
 * **為什麼重放整份而不只切那一段**：折疊狀態有跨輪的承載（`system`／`header`／`model` 的位置、callId 的歸屬表、第幾輪），
 * 切片不是自給自足的。**也為什麼不在目標輪結束就停**：之後才到的事件（遲到的工具結果、後面 resume 輪才落日誌的核准結局）
 * 要能記回這一輪——推送的投影裡窗口外的輪會丟掉它們，這裡不丟，所以細節比摘要更完整，以這邊為準。
 *
 * 沒有 `turn/start` 的日誌（前景子代理，只有一輪 `run`）整份就是一個邏輯輪。
 *
 * @param events - 這份日誌目前全部的事件。
 * @param query - `{ seq? , messageId? }`，最多給一個；都沒給就是第一個邏輯輪。
 * @throws {@link ProjectionDetailError} 錨點不合（`invalid-argument`）或日誌裡沒有對應的輪（`not-found`）。
 */
export function trajectoryTurnDetail(
  events: readonly SessionEvent[],
  query: Readonly<Record<string, unknown>>,
): TrajectoryTurnDetail {
  const seq = anchorSeq(query['seq']);
  const messageId = query['messageId'];
  if (messageId !== undefined && (typeof messageId !== 'string' || messageId === '')) {
    throw new ProjectionDetailError('invalid-argument', 'messageId 要是非空字串');
  }
  if (seq !== undefined && messageId !== undefined) {
    throw new ProjectionDetailError('invalid-argument', 'seq 與 messageId 只能給一個');
  }
  const last = events.at(-1);
  if (last === undefined) throw new ProjectionDetailError('not-found', '這份日誌是空的');
  const starts = events
    .filter((event) => event.type === 'turn/start' && isLogicalTurnStart(event))
    .map((event) => event.seq);
  let from = Number.NEGATIVE_INFINITY;
  let until = Number.POSITIVE_INFINITY;
  if (starts.length > 0) {
    let target: number | undefined = seq;
    if (messageId !== undefined) {
      target = seqOfMessage(events, messageId);
      if (target === undefined) {
        throw new ProjectionDetailError('not-found', `日誌裡沒有訊息 ${messageId} 的回覆`);
      }
    }
    if (target !== undefined && target > last.seq) {
      throw new ProjectionDetailError(
        'not-found',
        `日誌最後只到 ${String(last.seq)}，沒有 ${String(target)}`,
      );
    }
    // 沒給錨點＝第一個邏輯輪。
    const at = target === undefined ? 0 : starts.findLastIndex((start) => start <= target);
    if (at < 0) {
      throw new ProjectionDetailError('not-found', `${String(target)} 在第一輪開始之前`);
    }
    from = starts[at]!;
    until = starts[at + 1] ?? Number.POSITIVE_INFINITY;
  } else if (messageId !== undefined && seqOfMessage(events, messageId) === undefined) {
    throw new ProjectionDetailError('not-found', `日誌裡沒有訊息 ${messageId} 的回覆`);
  } else if (seq !== undefined && seq > last.seq) {
    throw new ProjectionDetailError(
      'not-found',
      `日誌最後只到 ${String(last.seq)}，沒有 ${String(seq)}`,
    );
  }
  const trim: TrimPolicy = {
    detailTurns: TRAJECTORY_DETAIL_TURNS,
    pinned: (turnSeq) => turnSeq >= from && turnSeq < until,
    ownersInPlace: true,
  };
  let state = initialTrajectory();
  for (const event of events) state = applyTrajectory(state, event, trim);
  const turns = state.turns.filter((turn) => turn.seq >= from && turn.seq < until).map(withCounts);
  if (turns.length === 0) throw new ProjectionDetailError('not-found', '這份日誌裡沒有這一輪');
  return { turns, seq: last.seq };
}

/**
 * 不做窗口與 `run` 輪摘要化的 view：狀態裡每一輪都帶完整結構。測試（量折疊本身，不量窗口）用；推送的是 {@link viewTrajectory}。
 *
 * @param state - 折疊狀態。
 */
export function viewTrajectoryFull(state: TrajectoryState): TrajectoryView {
  return { digests: state.digests, omitted: state.omitted, turns: state.turns.map(withCounts) };
}

/** 軌跡投影單元。 */
export const trajectoryUnit: ProjectionUnit<TrajectoryState, TrajectoryView> = {
  key: TRAJECTORY_PROJECTION,
  stateVersion: TRAJECTORY_VERSION,
  children: true,
  init: initialTrajectory,
  apply: applyTrajectory,
  view: viewTrajectory,
  detail: trajectoryTurnDetail,
};
