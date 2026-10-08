/**
 * 用量投影的折疊：把**一份**會話日誌折成 {@link TokenMeterView}（[#1028](https://github.com/DemianLi/nexus-agent/issues/1028)）。
 *
 * **全部從日誌折，不回寫日誌、不碰產品路徑。** `apply` 是純的、同步的，不相干的事件回**同一個參照**（通道靠這個省掉下游工作）。
 * 單元宣告 `children: true`（#1073），所以 root 與每個子代理各折各的、`apply` 不知道自己在折誰：前景子代理的日誌沒有 `turn/start`，
 * 數字全落在 `outside`；背景的每一輪（派出去與每次 `subagent.send`）各有 `turn/start`／`turn/end`（`background-subagents.ts`，實測），照一般的輪折。root 的輪外事件也落在 `outside`，**逐輪加總因此總能對回會話總計**
 * （`session` ＝ `outside` ＋ 每一輪）。
 *
 * ## 輪是邏輯輪
 *
 * 一顆非 `resume` 的 `turn/start` 開一輪；停在核准點的輪以 `turn/end` 收尾、接著的 `resume` 併回同一輪（同 `session-stats.ts`、
 * `subagentLinks`）。**核准的等待**於是落在那一輪的牆鐘裡：`waitMs` ＝ 收尾的 `turn/end` 到接著它的 `resume` 的 `turn/start`。
 * 這裡**偏離卡上的寫法**（`interrupt/raised.time` 到 resume）：實測 `interrupt/raised` 之後同一批的其他工具還在跑（它們的
 * `tool/result` 落在 `turn/end` 之前），從 `raised` 起算會把那段工具時間算兩次；從 `turn/end` 起算，等待與工具時間在構造上不重疊。
 *
 * ## 三段時間與殘差
 *
 * - **模型**：每次 `model/start`→`model/end` 的牆鐘，扣掉其間 `llm/retry-started.waitedMs`（退避包在起訖之內）。失敗與中止的呼叫也計時
 *   （同 `llmMs`）。所以逐輪加總 + 退避 ＝ 會話統計的 `llmMs`。
 * - **工具**：`tool/call`→`tool/result` 以 `callId` 配對，**取區間聯集**（平行的工具不重複算）；另帶各自加總 `toolSumMs`（＝ `toolMs` of
 *   `sessionStats`）。核准後同一個 `callId` 會再記一顆 `tool/call`：配對看最後那顆，停在核准點的那一次沒有結果、不算。
 * - **等待**：重試退避（`retryWaitMs`，包在模型呼叫的起訖之內，所以上面從模型時間扣掉）加上停在核准點的時間（`waitMs`，見上）。
 *   兩格分開放，畫面要合成一段「等待」就相加。
 * - **殘差** `unaccountedMs` ＝ 牆鐘 − 模型 − 工具 − 重試退避 − 核准等待，不夾 0（見型別）。前景子代理跑的時間已在派它的工具裡。
 *
 * ## 模型 id
 *
 * `request/header` 落在配對的 `model/start` **之後**、而且變了才記，所以 id 要在 `model/end`／`model/usage` 的當下才讀（那時
 * 這次呼叫的快照已經在）；日誌上還沒有快照就是 `null`，不猜。
 *
 * @module
 */

import { isLogicalTurnStart } from '@nexus/core';
import type { ProjectionUnit, SessionEvent } from '@nexus/core';
import {
  TOKEN_METER_LINKS_CAP,
  TOKEN_METER_MODELS_CAP,
  TOKEN_METER_PROJECTION,
  TOKEN_METER_TOOL_NAMES_CAP,
  TOKEN_METER_TURNS_KEEP,
  TOKEN_METER_VERSION,
} from '@nexus/wire';
import type {
  TokenMeterEnd,
  TokenMeterLink,
  TokenMeterModelRow,
  TokenMeterModelsOther,
  TokenMeterSpan,
  TokenMeterToolRow,
  TokenMeterToolsOther,
  TokenMeterTurn,
  TokenMeterView,
} from '@nexus/wire';

// ── 一段事件的內部數字 ───────────────────────────────────────────────────────────────────

/** 加得起來的欄位。`usages` 是內部欄位（有幾次呼叫報了用量），view 才換算成 `unknownSteps`。 */
const NUMBERS = [
  'steps',
  'failedSteps',
  'usages',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  // 有幾次用量報了快取讀／寫：跟 `usages` 一樣多才放進 view（缺席＝沒記，不是 0）。
  'cacheReadReports',
  'cacheWriteReports',
  'failedInputTokens',
  'failedOutputTokens',
  'summaries',
  'summariesUnknown',
  'summaryInputTokens',
  'summaryOutputTokens',
  'retries',
  'retryWaitMs',
  'modelMs',
  'toolCalls',
  'toolErrors',
  'toolSumMs',
  'toolMs',
  'waitMs',
] as const;
type NumberKey = (typeof NUMBERS)[number];

interface Sp {
  readonly n: Readonly<Record<NumberKey, number>>;
  readonly tools: readonly TokenMeterToolRow[];
  readonly toolsOther?: TokenMeterToolsOther;
  readonly models: readonly ModelAcc[];
  readonly modelsOther?: ModelAcc;
}

/**
 * 依模型的內部累計：view 的列加上「有幾次用量、其中幾次報了快取讀／寫」。**快取兩格缺席＝沒記**的規則跟段一樣
 * （全報才放），所以每一列自己數。
 */
interface ModelAcc {
  readonly model: string | null;
  readonly steps: number;
  readonly usages: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheReadReports: number;
  readonly cacheWriteReports: number;
}

const NO_MODEL_ACC = Object.freeze({
  steps: 0,
  usages: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cacheReadReports: 0,
  cacheWriteReports: 0,
});

function addAcc(
  left: Omit<ModelAcc, 'model'>,
  right: Omit<ModelAcc, 'model'>,
): Omit<ModelAcc, 'model'> {
  return {
    steps: left.steps + right.steps,
    usages: left.usages + right.usages,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    cacheReadReports: left.cacheReadReports + right.cacheReadReports,
    cacheWriteReports: left.cacheWriteReports + right.cacheWriteReports,
  };
}

/** 內部累計 → view 的列：快取兩格只在這一列每一次用量都報了才放。 */
function rowOf(acc: Omit<ModelAcc, 'model'>): Omit<TokenMeterModelsOther, never> {
  return {
    steps: acc.steps,
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    ...(acc.usages > 0 && acc.cacheReadReports === acc.usages
      ? { cacheReadTokens: acc.cacheReadTokens }
      : {}),
    ...(acc.usages > 0 && acc.cacheWriteReports === acc.usages
      ? { cacheWriteTokens: acc.cacheWriteTokens }
      : {}),
  };
}

const ZERO_NUMBERS = Object.freeze(
  Object.fromEntries(NUMBERS.map((key) => [key, 0])) as Record<NumberKey, number>,
);
const EMPTY: Sp = Object.freeze({ n: ZERO_NUMBERS, tools: [], models: [] });

function bump(sp: Sp, delta: Partial<Record<NumberKey, number>>): Sp {
  const n: Record<NumberKey, number> = { ...sp.n };
  for (const key of NUMBERS) n[key] += delta[key] ?? 0;
  return { ...sp, n };
}

/** 依工具名加一筆；名額滿了的新名字併進 `toolsOther`。 */
function addTool(sp: Sp, row: TokenMeterToolRow): Sp {
  const at = sp.tools.findIndex((each) => each.name === row.name);
  if (at >= 0) {
    const tools = sp.tools.slice();
    const was = tools[at]!;
    tools[at] = { name: was.name, calls: was.calls + row.calls, errors: was.errors + row.errors };
    return { ...sp, tools };
  }
  if (sp.tools.length < TOKEN_METER_TOOL_NAMES_CAP) return { ...sp, tools: [...sp.tools, row] };
  const other = sp.toolsOther ?? { calls: 0, errors: 0 };
  return {
    ...sp,
    toolsOther: { calls: other.calls + row.calls, errors: other.errors + row.errors },
  };
}

/** 依模型加一筆；名額滿了的新模型併進 `modelsOther`。 */
function addModel(sp: Sp, row: ModelAcc): Sp {
  const at = sp.models.findIndex((each) => each.model === row.model);
  if (at >= 0) {
    const models = sp.models.slice();
    models[at] = { model: row.model, ...addAcc(models[at]!, row) };
    return { ...sp, models };
  }
  if (sp.models.length < TOKEN_METER_MODELS_CAP) return { ...sp, models: [...sp.models, row] };
  return {
    ...sp,
    modelsOther: {
      model: null,
      ...addAcc(sp.modelsOther ?? { model: null, ...NO_MODEL_ACC }, row),
    },
  };
}

/** 兩段併起來（窗口外的輪併成一列、算會話總計）。 */
function merge(a: Sp, b: Sp): Sp {
  let out = bump(a, b.n);
  for (const row of b.tools) out = addTool(out, row);
  if (b.toolsOther !== undefined) {
    const other = out.toolsOther ?? { calls: 0, errors: 0 };
    out = {
      ...out,
      toolsOther: {
        calls: other.calls + b.toolsOther.calls,
        errors: other.errors + b.toolsOther.errors,
      },
    };
  }
  for (const row of b.models) out = addModel(out, row);
  if (b.modelsOther !== undefined) {
    out = {
      ...out,
      modelsOther: {
        model: null,
        ...addAcc(out.modelsOther ?? { model: null, ...NO_MODEL_ACC }, b.modelsOther),
      },
    };
  }
  return out;
}

/** 內部數字 → view 的一段。 */
function toSpan(sp: Sp): TokenMeterSpan {
  const { n } = sp;
  return {
    steps: n.steps,
    failedSteps: n.failedSteps,
    unknownSteps: Math.max(0, n.steps - n.usages),
    inputTokens: n.inputTokens,
    outputTokens: n.outputTokens,
    uncachedInputTokens: n.inputTokens,
    ...(n.usages > 0 && n.cacheReadReports === n.usages
      ? { cacheReadTokens: n.cacheReadTokens }
      : {}),
    ...(n.usages > 0 && n.cacheWriteReports === n.usages
      ? { cacheWriteTokens: n.cacheWriteTokens }
      : {}),
    failedInputTokens: n.failedInputTokens,
    failedOutputTokens: n.failedOutputTokens,
    summaries: n.summaries,
    summariesUnknown: n.summariesUnknown,
    summaryInputTokens: n.summaryInputTokens,
    summaryOutputTokens: n.summaryOutputTokens,
    retries: n.retries,
    retryWaitMs: n.retryWaitMs,
    modelMs: n.modelMs,
    toolCalls: n.toolCalls,
    toolErrors: n.toolErrors,
    toolSumMs: n.toolSumMs,
    toolMs: n.toolMs,
    waitMs: n.waitMs,
    tools: sp.tools,
    ...(sp.toolsOther === undefined ? {} : { toolsOther: sp.toolsOther }),
    models: sp.models.map((acc): TokenMeterModelRow => ({ model: acc.model, ...rowOf(acc) })),
    ...(sp.modelsOther === undefined ? {} : { modelsOther: rowOf(sp.modelsOther) }),
  };
}

// ── 工具區間聯集 ───────────────────────────────────────────────────────────────────────

/** 互不重疊、由舊到新的區間 `[開始, 結束]`。 */
type Cover = readonly (readonly [number, number])[];

/** 最多留幾段區間；更舊的丟掉（新來的工具不會比最近 64 段更早開始，除非它跑了極久）。 */
const COVER_CAP = 64;

/** 把 `[start, end]` 加進區間聯集，回新的聯集與**新增**的長度。 */
function coverAdd(cover: Cover, start: number, end: number): { cover: Cover; added: number } {
  let overlap = 0;
  let mergedStart = start;
  let mergedEnd = end;
  const before: [number, number][] = [];
  const after: [number, number][] = [];
  for (const run of cover) {
    if (run[1] < start) before.push([run[0], run[1]]);
    else if (run[0] > end) after.push([run[0], run[1]]);
    else {
      overlap += Math.max(0, Math.min(run[1], end) - Math.max(run[0], start));
      mergedStart = Math.min(mergedStart, run[0]);
      mergedEnd = Math.max(mergedEnd, run[1]);
    }
  }
  const next = [...before, [mergedStart, mergedEnd] as [number, number], ...after];
  return {
    cover: next.length > COVER_CAP ? next.slice(next.length - COVER_CAP) : next,
    added: end - start - overlap,
  };
}

// ── 狀態 ─────────────────────────────────────────────────────────────────────────────────

/** 一個邏輯輪的內部狀態。 */
interface Row {
  readonly index: number;
  readonly seq: number;
  readonly time: number;
  readonly kind: string;
  readonly end?: TokenMeterEnd;
  readonly endTime?: number;
  readonly sp: Sp;
  /** 這一輪的工具區間聯集；收進 `closed` 時清掉（只有目前這一輪還會有新工具）。 */
  readonly cover: Cover;
}

/** 折疊狀態。 */
export interface TokenMeterState {
  /** 不在任何輪裡的事件（前景子代理那份全在這裡）與它的工具區間聯集。 */
  readonly outside: Sp;
  readonly outsideCover: Cover;
  /** 最近一個邏輯輪；收尾了也留著，因為接著它的 `resume` 要併回來。 */
  readonly current: Row | null;
  /** 比 `current` 早、還在窗口裡的輪。 */
  readonly closed: readonly Row[];
  /** 窗口外併起來的輪。 */
  readonly earlier: Sp;
  readonly earlierTurns: number;
  /** 到目前為止開過幾個邏輯輪（下一輪的 `index`）。 */
  readonly total: number;
  /** 現在在不在物理輪裡（`turn/start` 到 `turn/end`／`turn/failed` 之間）。 */
  readonly open: boolean;
  /** 這個物理輪裡掛過 `interrupt/raised`（收尾時據此判「停在核准點」）。 */
  readonly paused: boolean;
  /** 最近一份 `request/header` 讀到的模型 id。 */
  readonly model: string | null;
  /** 還沒結束的模型呼叫：開始時刻與其間等掉的退避。 */
  readonly call: { readonly start: number; readonly waited: number } | null;
  /** 還沒落定的工具呼叫：鍵加 `#` 前綴，免得 `callId` 叫 `constructor` 讀到繼承來的東西。 */
  readonly pending: Readonly<Record<string, { readonly name: string; readonly time: number }>>;
  readonly links: readonly TokenMeterLink[];
  readonly linksOmitted: number;
}

const NO_PENDING: TokenMeterState['pending'] = Object.freeze({});

/** 空狀態。 */
export function initialTokenMeter(): TokenMeterState {
  return {
    outside: EMPTY,
    outsideCover: [],
    current: null,
    closed: [],
    earlier: EMPTY,
    earlierTurns: 0,
    total: 0,
    open: false,
    paused: false,
    model: null,
    call: null,
    pending: NO_PENDING,
    links: [],
    linksOmitted: 0,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 事件現在算進哪裡：開著的輪，否則輪外。 */
function inRow(state: TokenMeterState): boolean {
  return state.open && state.current !== null;
}

/** 對「現在這個去處」的數字做一次更新。 */
function update(state: TokenMeterState, change: (sp: Sp) => Sp): TokenMeterState {
  if (inRow(state)) {
    const row = state.current!;
    return { ...state, current: { ...row, sp: change(row.sp) } };
  }
  return { ...state, outside: change(state.outside) };
}

// ── 折疊 ─────────────────────────────────────────────────────────────────────────────────

/** 目前這一輪收進窗口；窗口滿了，最舊的併進 `earlier`。 */
function retire(state: TokenMeterState): TokenMeterState {
  const row = state.current;
  if (row === null) return state;
  let closed = [...state.closed, { ...row, cover: [] }];
  let earlier = state.earlier;
  let earlierTurns = state.earlierTurns;
  while (closed.length > TOKEN_METER_TURNS_KEEP - 1) {
    earlier = merge(earlier, closed[0]!.sp);
    earlierTurns += 1;
    closed = closed.slice(1);
  }
  return { ...state, current: null, closed, earlier, earlierTurns };
}

function startRow(state: TokenMeterState, event: SessionEvent): TokenMeterState {
  const data = event.data as unknown as Record<string, unknown>;
  const retired = retire(state);
  const row: Row = {
    index: retired.total,
    seq: event.seq,
    time: event.time,
    kind: typeof data['kind'] === 'string' ? data['kind'] : 'message',
    sp: EMPTY,
    cover: [],
  };
  return { ...retired, current: row, total: retired.total + 1, open: true, paused: false };
}

function resumeRow(state: TokenMeterState, event: SessionEvent): TokenMeterState {
  const row = state.current!;
  // 接著收尾的那一輪：等待是收尾到現在。沒收尾過（行程中途死了）就沒有可量的。
  const waited = row.endTime === undefined ? 0 : Math.max(0, event.time - row.endTime);
  const { end: _end, endTime: _endTime, ...rest } = row;
  return {
    ...state,
    current: { ...rest, sp: bump(row.sp, { waitMs: waited }) },
    open: true,
    paused: false,
  };
}

function endOf(reason: unknown, paused: boolean): TokenMeterEnd {
  if (isRecord(reason)) {
    switch (reason['kind']) {
      case 'aborted':
        return 'aborted';
      case 'max-tokens':
        return 'max-tokens';
      case 'interrupted':
        return 'interrupted';
      default:
        break;
    }
  }
  return paused ? 'paused' : 'completed';
}

function closeRow(
  state: TokenMeterState,
  event: SessionEvent,
  end: TokenMeterEnd,
): TokenMeterState {
  if (!inRow(state)) return state;
  const row = state.current!;
  return {
    ...state,
    current: { ...row, end, endTime: event.time },
    open: false,
    paused: false,
    pending: NO_PENDING,
  };
}

/** 讀 `request/header` 裡的模型 id；沒有就維持原來的。 */
function modelOf(data: Record<string, unknown>, previous: string | null): string | null {
  const header = data['header'];
  const config = isRecord(header) ? header['config'] : undefined;
  const model = isRecord(config) ? config['model'] : undefined;
  return typeof model === 'string' ? model : previous;
}

/**
 * 用量投影的 `apply`。
 *
 * @param state - 目前的狀態。
 * @param event - 這份日誌的下一顆事件。
 * @returns 新狀態；不相干的事件回傳同一個參照。
 */
export function applyTokenMeter(state: TokenMeterState, event: SessionEvent): TokenMeterState {
  const data = event.data as unknown as Record<string, unknown>;
  switch (event.type) {
    case 'turn/start':
      return isLogicalTurnStart(event) || state.current === null
        ? startRow(state, event)
        : resumeRow(state, event);
    case 'turn/end':
      return closeRow(state, event, endOf(data['reason'], state.paused));
    case 'turn/failed':
      return closeRow(state, event, 'failed');
    case 'interrupt/raised':
      return state.open && !state.paused ? { ...state, paused: true } : state;
    case 'request/header': {
      const model = modelOf(data, state.model);
      return model === state.model ? state : { ...state, model };
    }
    case 'model/start':
      return { ...state, call: { start: event.time, waited: 0 } };
    case 'llm/retry-started': {
      const waited = typeof data['waitedMs'] === 'number' ? data['waitedMs'] : 0;
      const counted = update(state, (sp) => bump(sp, { retries: 1, retryWaitMs: waited }));
      return counted.call === null
        ? counted
        : { ...counted, call: { ...counted.call, waited: counted.call.waited + waited } };
    }
    case 'model/usage': {
      // **未快取的輸入**（#724，照 dsh 的四桶互不重疊）：格式 36 起日誌的 `inputTokens` 本來就是它；舊日誌沒有快取兩格，
      // `inputTokens` 就是整個 prompt（沒記快取，也就沒有可分的）。
      const input = typeof data['inputTokens'] === 'number' ? data['inputTokens'] : 0;
      const output = typeof data['outputTokens'] === 'number' ? data['outputTokens'] : 0;
      const failed = data['outcome'] !== undefined;
      const cacheRead = data['cacheReadTokens'];
      const cacheWrite = data['cacheWriteTokens'];
      return update(state, (sp) =>
        addModel(
          bump(sp, {
            usages: 1,
            inputTokens: input,
            outputTokens: output,
            cacheReadTokens: typeof cacheRead === 'number' ? cacheRead : 0,
            cacheWriteTokens: typeof cacheWrite === 'number' ? cacheWrite : 0,
            cacheReadReports: typeof cacheRead === 'number' ? 1 : 0,
            cacheWriteReports: typeof cacheWrite === 'number' ? 1 : 0,
            failedInputTokens: failed ? input : 0,
            failedOutputTokens: failed ? output : 0,
          }),
          {
            model: state.model,
            ...NO_MODEL_ACC,
            usages: 1,
            inputTokens: input,
            outputTokens: output,
            cacheReadTokens: typeof cacheRead === 'number' ? cacheRead : 0,
            cacheWriteTokens: typeof cacheWrite === 'number' ? cacheWrite : 0,
            cacheReadReports: typeof cacheRead === 'number' ? 1 : 0,
            cacheWriteReports: typeof cacheWrite === 'number' ? 1 : 0,
          },
        ),
      );
    }
    case 'model/end': {
      const started = state.call;
      const failed = data['outcome'] !== undefined;
      const modelMs =
        started === null ? 0 : Math.max(0, event.time - started.start - started.waited);
      const next = update(state, (sp) =>
        addModel(bump(sp, { steps: 1, failedSteps: failed ? 1 : 0, modelMs }), {
          model: state.model,
          ...NO_MODEL_ACC,
          steps: 1,
        }),
      );
      return { ...next, call: null };
    }
    case 'compaction/summary': {
      const usage = isRecord(data['usage']) ? data['usage'] : undefined;
      // 生摘要那一次的輸入也是未快取那一桶（同上）。
      const input =
        usage !== undefined && typeof usage['inputTokens'] === 'number' ? usage['inputTokens'] : 0;
      const output =
        usage !== undefined && typeof usage['outputTokens'] === 'number'
          ? usage['outputTokens']
          : 0;
      return update(state, (sp) =>
        bump(sp, {
          summaries: 1,
          summariesUnknown: usage === undefined ? 1 : 0,
          summaryInputTokens: input,
          summaryOutputTokens: output,
        }),
      );
    }
    case 'tool/call': {
      const callId = String(data['callId']);
      return {
        ...state,
        pending: {
          ...state.pending,
          [`#${callId}`]: { name: String(data['name']), time: event.time },
        },
      };
    }
    case 'tool/result': {
      const key = `#${String(data['callId'])}`;
      const dispatched = Object.hasOwn(state.pending, key) ? state.pending[key] : undefined;
      if (dispatched === undefined) return state;
      const pending = Object.fromEntries(
        Object.entries(state.pending).filter(([id]) => id !== key),
      );
      const error = data['isError'] === true;
      const duration = Math.max(0, event.time - dispatched.time);
      const settled = { ...state, pending };
      const apply = (sp: Sp, added: number): Sp =>
        addTool(
          bump(sp, {
            toolCalls: 1,
            toolErrors: error ? 1 : 0,
            toolSumMs: duration,
            toolMs: added,
          }),
          { name: dispatched.name, calls: 1, errors: error ? 1 : 0 },
        );
      if (inRow(settled)) {
        const row = settled.current!;
        const { cover, added } = coverAdd(row.cover, dispatched.time, event.time);
        return { ...settled, current: { ...row, cover, sp: apply(row.sp, added) } };
      }
      const { cover, added } = coverAdd(settled.outsideCover, dispatched.time, event.time);
      return { ...settled, outsideCover: cover, outside: apply(settled.outside, added) };
    }
    case 'subagent/catalog': {
      const childId = String(data['childId']);
      const runId = childId.slice(childId.lastIndexOf('/') + 1);
      const callId = String(data['callId']);
      if (state.links.some((link) => link.runId === runId && link.callId === callId)) return state;
      const link: TokenMeterLink = {
        runId,
        callId,
        mode: data['mode'] === 'continuable' ? 'continuable' : 'one-shot',
        ...(inRow(state) ? { turn: state.current!.index } : {}),
      };
      const links = [...state.links, link];
      const cut = Math.max(0, links.length - TOKEN_METER_LINKS_CAP);
      return {
        ...state,
        links: cut === 0 ? links : links.slice(cut),
        linksOmitted: state.linksOmitted + cut,
      };
    }
    case 'session/end-seed':
      // 這個行程沒寫過它之前的事件：還開著的呼叫與工具屬於一個已經結束的生命週期，不跟之後的結果配對。
      return state.call === null && Object.keys(state.pending).length === 0
        ? state
        : { ...state, call: null, pending: NO_PENDING };
    default:
      return state;
  }
}

// ── view ─────────────────────────────────────────────────────────────────────────────────

function rowToTurn(row: Row): TokenMeterTurn {
  const span = toSpan(row.sp);
  const wallMs = row.endTime === undefined ? undefined : row.endTime - row.time;
  return {
    ...span,
    index: row.index,
    seq: row.seq,
    time: row.time,
    kind: row.kind,
    ...(row.end === undefined ? {} : { end: row.end }),
    ...(row.endTime === undefined ? {} : { endTime: row.endTime }),
    ...(wallMs === undefined
      ? {}
      : {
          wallMs,
          unaccountedMs: wallMs - span.modelMs - span.toolMs - span.retryWaitMs - span.waitMs,
        }),
  };
}

/** 狀態 → 線上的 view。 */
export function viewTokenMeter(state: TokenMeterState): TokenMeterView {
  const rows = state.current === null ? state.closed : [...state.closed, state.current];
  let session = merge(state.outside, state.earlier);
  for (const row of rows) session = merge(session, row.sp);
  return {
    session: toSpan(session),
    outside: toSpan(state.outside),
    turns: rows.map(rowToTurn),
    ...(state.earlierTurns > 0
      ? { earlier: { ...toSpan(state.earlier), turns: state.earlierTurns } }
      : {}),
    totalTurns: state.total,
    links: state.links,
    linksOmitted: state.linksOmitted,
  };
}

/** 用量投影的單元。root 與每個子代理各折一份（`children: true`，見檔頭）。 */
export const tokenMeterUnit: ProjectionUnit<TokenMeterState, TokenMeterView> = {
  key: TOKEN_METER_PROJECTION,
  stateVersion: TOKEN_METER_VERSION,
  children: true,
  init: initialTokenMeter,
  apply: applyTokenMeter,
  view: viewTokenMeter,
};
