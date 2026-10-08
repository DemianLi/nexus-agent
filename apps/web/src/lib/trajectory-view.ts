/**
 * 讀軌跡投影（[#1027](https://github.com/DemianLi/nexus-agent/issues/1027)）的那一層：哪些值可以信、怎麼寫成字。
 * 觀測分頁（`trace-view.ts`、`panel.tsx`）只透過這裡碰投影，所以「不認得的版本不畫、拋過的不畫」只有一個地方。
 *
 * ## 閘門
 *
 * 投影走 `projection` frame 的 `(key, version)`：`failed: true`（該單元的折疊拋過、已停用）、版本不是這份程式碼認得的、
 * 或 view 的形狀不對，一律當成**沒有**，由呼叫端退回第 0 版（只有順序）。不顯示過期的值，也不猜。
 *
 * ## 「沒記」與「是 0」
 *
 * 舊日誌沒有的欄位在 view 上是缺席的。這裡的格式化函式收 `undefined`、回 `—`，**永遠不把缺席補成 0**。
 *
 * @module
 */

import {
  REQUEST_SNAPSHOTS_PROJECTION,
  REQUEST_SNAPSHOTS_VERSION,
  TRAJECTORY_PROJECTION,
  TRAJECTORY_VERSION,
} from '@nexus/wire';
import type {
  ConversationState,
  RequestSnapshotsView,
  TrajectoryApproval,
  TrajectoryApprovalOutcome,
  TrajectoryDecision,
  TrajectoryEnd,
  TrajectoryTurnKind,
  TrajectoryView,
  WireProjection,
} from '@nexus/wire';

import {
  NOT_RECORDED,
  cacheHitRate,
  cacheHitRateText,
  usageBuckets,
} from '@/lib/session-usage-view';

/** 沒記的欄位顯示成這個。 */
export const ABSENT = '—';

/** 一個投影的 view；沒有、拋過、版本不認得都是 `undefined`。root 與子代理的值同一個形狀，所以收一份 `key → 投影` 的表。 */
export function viewOf(
  projections: Readonly<Record<string, WireProjection>>,
  key: string,
  version: number,
): unknown {
  const projection = projections[key];
  if (projection === undefined || projection.failed === true || projection.version !== version) {
    return undefined;
  }
  return projection.view;
}

/** 軌跡投影的 view；沒有、拋過、版本不認得、形狀不對都是 `undefined`。 */
export function trajectoryOf(state: ConversationState): TrajectoryView | undefined {
  const view = viewOf(state.projections, TRAJECTORY_PROJECTION, TRAJECTORY_VERSION);
  if (typeof view !== 'object' || view === null) return undefined;
  const { turns, digests, omitted } = view as Partial<TrajectoryView>;
  if (!Array.isArray(turns) || !Array.isArray(digests) || typeof omitted !== 'number') {
    return undefined;
  }
  return view as TrajectoryView;
}

/** 一個子代理自己的軌跡 view（`subagentProjections[runId]`）；沒有、拋過、版本不認得、形狀不對都是 `undefined`。 */
export function subagentTrajectoryOf(
  state: ConversationState,
  runId: string,
): TrajectoryView | undefined {
  const projections = state.subagentProjections[runId];
  if (projections === undefined) return undefined;
  const view = viewOf(projections, TRAJECTORY_PROJECTION, TRAJECTORY_VERSION);
  if (typeof view !== 'object' || view === null) return undefined;
  const { turns, digests, omitted } = view as Partial<TrajectoryView>;
  if (!Array.isArray(turns) || !Array.isArray(digests) || typeof omitted !== 'number') {
    return undefined;
  }
  return view as TrajectoryView;
}

/** 一個子代理自己的請求快照（`system`／`header` 的 `seq` 指的是它自己日誌的位置）；同上。 */
export function subagentSnapshotsOf(
  state: ConversationState,
  runId: string,
): RequestSnapshotsView | undefined {
  const projections = state.subagentProjections[runId];
  if (projections === undefined) return undefined;
  const view = viewOf(projections, REQUEST_SNAPSHOTS_PROJECTION, REQUEST_SNAPSHOTS_VERSION);
  if (typeof view !== 'object' || view === null) return undefined;
  const { system, header } = view as Partial<RequestSnapshotsView>;
  if (!Array.isArray(system) || !Array.isArray(header)) return undefined;
  return view as RequestSnapshotsView;
}

/** 請求快照投影的 view；同上。 */
export function snapshotsOf(state: ConversationState): RequestSnapshotsView | undefined {
  const view = viewOf(state.projections, REQUEST_SNAPSHOTS_PROJECTION, REQUEST_SNAPSHOTS_VERSION);
  if (typeof view !== 'object' || view === null) return undefined;
  const { system, header } = view as Partial<RequestSnapshotsView>;
  if (!Array.isArray(system) || !Array.isArray(header)) return undefined;
  return view as RequestSnapshotsView;
}

const pad = (value: number) => String(value).padStart(2, '0');

/** 時刻（毫秒）寫成本地時間的 `HH:MM:SS`；沒有就是 {@link ABSENT}。 */
export function clockText(time: number | undefined): string {
  if (time === undefined) return ABSENT;
  const at = new Date(time);
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/** 耗時（毫秒）：不到一秒寫 ms，一分鐘內寫秒，再長寫分秒；沒有就是 {@link ABSENT}。 */
export function durationText(ms: number | undefined): string {
  if (ms === undefined) return ABSENT;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

/** token 數；沒記就是 {@link ABSENT}（不是 0）。 */
export function tokenText(count: number | undefined): string {
  return count === undefined ? ABSENT : count.toLocaleString('en-US');
}

/** 觀測分頁一處用量要畫的字（呼叫的 `usage`、一輪的加總都走這條，規則同成本分頁與頂列）。 */
export interface TokenFacts {
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly uncachedInputTokens?: number | undefined;
  readonly cacheReadTokens?: number | undefined;
  readonly cacheWriteTokens?: number | undefined;
}

export interface TokenParts {
  /** 輸入：新 server 是未快取的那一桶，舊 server 是 `inputTokens`（含快取）；沒報用量是 {@link ABSENT}。 */
  readonly input: string;
  readonly output: string;
  /** 兩格快取：新 server 才有（缺席畫「沒記」）；舊 server 沒有這兩格。 */
  readonly cache?: { readonly read: string; readonly write: string };
  /** 命中率（一位小數或「沒記」）；不該畫（沒有快取資料、分母是 0、舊 server 沒報用量）沒有這一格。 */
  readonly hitRate?: string;
}

export function tokenParts(facts: TokenFacts): TokenParts {
  // 沒報用量（呼叫沒有 `usage`）時 `inputTokens` 缺席；報了就一定有，未快取那一格只是它的選填明細。
  if (facts.inputTokens === undefined)
    return { input: ABSENT, output: tokenText(facts.outputTokens) };
  // 四桶互不重疊，**不讀 `inputTokens`**（#724）：它之後改成只算未快取，畫面的數字不能跟著動。
  const buckets = usageBuckets({
    inputTokens: facts.inputTokens ?? 0,
    outputTokens: facts.outputTokens ?? 0,
    ...(facts.uncachedInputTokens === undefined
      ? {}
      : { uncachedInputTokens: facts.uncachedInputTokens }),
    ...(facts.cacheReadTokens === undefined ? {} : { cacheReadTokens: facts.cacheReadTokens }),
    ...(facts.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: facts.cacheWriteTokens }),
  });
  const rate = cacheHitRate(buckets);
  return {
    input: tokenText(buckets.input),
    output: tokenText(buckets.output),
    ...(buckets.cacheInInput
      ? {}
      : {
          cache: {
            read: cacheTokenText(buckets.cacheRead),
            write: cacheTokenText(buckets.cacheWrite),
          },
        }),
    ...(rate === undefined ? {} : { hitRate: cacheHitRateText(rate) }),
  };
}

const cacheTokenText = (count: number | undefined): string =>
  count === undefined ? NOT_RECORDED : tokenText(count);

/** 一輪是怎麼開始的。 */
export const TURN_KIND_LABEL: Readonly<Record<TrajectoryTurnKind, string>> = {
  message: '人的訊息',
  resume: '核准後續接',
  'agent-message': '子代理來信',
  'subagent-settled': '子代理結算',
  goal: '目標排的輪',
  // 前景子代理整份日誌沒有輪的邊界，從第一次模型呼叫算一輪、沒有結束；跑完與否看派它的那顆工具的狀態。
  run: '子代理的一段執行',
};

/**
 * 一輪是怎麼結束的；還沒結束沒有這一格。`interrupted` 是行程被打斷後重啟補收的那一種（`interrupted-turn.ts` 補的 `turn/end`），
 * 不是停在核准點：停在核准點的輪是正常收尾，接著另有一顆 `resume`。
 */
export const TURN_END_LABEL: Readonly<Record<TrajectoryEnd, string>> = {
  completed: '完成',
  aborted: '已停止',
  'max-tokens': '輸出上限',
  interrupted: '意外中斷',
  failed: '失敗',
};

/**
 * 失敗的那一輪是哪一類失敗（`TrajectoryDigest.failureCode`，#434／#1115／#1121）。詞彙與 `llm/retry` 的碼同一份；
 * 少了一個鍵就是畫面上多一個看不懂的英文碼，所以每一個都有一句話。`HTTP_<n>` 帶狀態碼，另走 {@link failureCodeText}。
 */
export const FAILURE_CODE_LABEL: Readonly<Record<string, string>> = {
  AUTH: '驗證失敗',
  QUOTA: '額度用盡',
  RATE_LIMIT: '被限流',
  CONTEXT_WINDOW_EXCEEDED: '超出上下文上限',
  INVALID_REQUEST: '請求被拒',
  SERVER: '服務端錯誤',
  TIMEOUT: '逾時',
  TRANSPORT: '連線失敗',
  UNKNOWN: '原因不明',
};

const HTTP_FAILURE_CODE = /^HTTP_(\d{3})$/;

/**
 * 失敗碼的一句話。`HTTP_<n>` 寫成 `HTTP <n>`；不認得的碼**原樣顯示**，不猜也不改成「原因不明」（日誌可能比這份畫面新）。
 * 只認自己的鍵，不認 `constructor` 這類原型上的。
 */
export function failureCodeText(code: string): string {
  if (Object.hasOwn(FAILURE_CODE_LABEL, code)) return FAILURE_CODE_LABEL[code]!;
  const http = HTTP_FAILURE_CODE.exec(code);
  return http === null ? code : `HTTP ${http[1]}`;
}

export type SignalKind = Exclude<TrajectoryDecision['kind'], 'compaction'>;

export const SIGNAL_LABEL: Readonly<Record<SignalKind, string>> = {
  reminder: '系統提醒',
  'plugin-message': '外掛訊息',
  goal: '目標',
  plan: '計劃模式',
  todo: '待辦',
  interrupt: '停下來等人',
};

/** 目標變更的動詞與階段（`nexus-plugin-goal` 的 `SNAPSHOT_OPERATIONS`、`PHASES`）；不認得的原樣顯示，不猜。 */
const GOAL_OPERATION_LABEL: Readonly<Record<string, string>> = {
  create: '建立目標',
  edit: '修改目標',
  pause: '暫停目標',
  resume: '繼續目標',
  complete: '完成目標',
  block: '目標卡住了',
  clear: '清掉目標',
};

const GOAL_PHASE_LABEL: Readonly<Record<string, string>> = {
  active: '進行中',
  paused: '暫停',
  blocked: '卡住',
  complete: '完成',
};

/**
 * 一個決策點寫成一行。**只讀結構化欄位**，不顯示寫給模型的原文（#1018 Q3）。
 * 壓縮不在這裡：對話裡有那一則壓縮標記，畫面上已經有一列。
 */
export function signalText(decision: Exclude<TrajectoryDecision, { kind: 'compaction' }>): string {
  switch (decision.kind) {
    case 'reminder': {
      const tool = decision.tool ?? '同一個工具';
      return decision.count === undefined
        ? `重複呼叫：${tool}`
        : `重複呼叫：${tool} 連續第 ${decision.count} 次`;
    }
    case 'plugin-message':
      return `外掛 ${decision.plugin} 插了一則訊息`;
    case 'goal': {
      const operation =
        decision.operation === undefined
          ? '目標變更'
          : (GOAL_OPERATION_LABEL[decision.operation] ?? `目標：${decision.operation}`);
      return decision.phase === undefined
        ? operation
        : `${operation}（${GOAL_PHASE_LABEL[decision.phase] ?? decision.phase}）`;
    }
    case 'plan':
      return decision.active ? '進入計劃模式' : '離開計劃模式';
    case 'todo':
      return `待辦清單更新，共 ${decision.items} 項`;
    case 'interrupt':
      return decision.approval === undefined
        ? '停下來等人決定'
        : approvalText(decision.approval, decision.time);
  }
}

/**
 * 核准結局的說法（詞彙同 `@nexus/core` 的 `ApprovalOutcome`）。不認得的結局（以後多出來的）原樣顯示，不猜它的意思。
 */
export const APPROVAL_OUTCOME_LABEL: Readonly<Record<TrajectoryApprovalOutcome, string>> = {
  'allowed-once': '允許一次',
  rejected: '已拒絕',
  cancelled: '已取消',
  unavailable: '無法回答',
};

/** 還沒有結局時寫的話：**不推一個結果**——還沒答、或停在這裡沒人答就關掉了（重開之後一樣）。 */
export const APPROVAL_UNDECIDED_TEXT = '還沒有結局（還沒回答，或停在這裡就關掉了）';

/**
 * 一個核准問題寫成一行：被問的工具、結局、等了多久。等多久是結局時刻減中斷時刻，兩邊都有才算（`decidedAt` 缺席就不寫，
 * 不拿現在的時鐘補）。
 */
export function approvalText(approval: TrajectoryApproval, raisedAt: number): string {
  const head = `核准 ${approval.tool}`;
  if (approval.outcome === undefined) return `${head}：${APPROVAL_UNDECIDED_TEXT}`;
  const verdict = APPROVAL_OUTCOME_LABEL[approval.outcome] ?? approval.outcome;
  const waited =
    approval.decidedAt === undefined
      ? ''
      : `（等了 ${durationText(approval.decidedAt - raisedAt)}）`;
  return `${head}：${verdict}${waited}`;
}

/**
 * 不必問人就確定的核准，結局在那一次工具呼叫的錯誤碼（`tool/result.error.code`，`TrajectoryTool.code`）：沒有人被擋下來等，
 * 所以軌跡上沒有中斷列。`error.name` 都是 `ApprovalDenied`，與工具自己失敗分得開。其他的碼不在這裡（原樣不顯示）。
 */
export const APPROVAL_CODE_LABEL: Readonly<Record<string, string>> = {
  APPROVAL_POLICY_NEVER: '核准政策一律不允許',
  APPROVAL_NO_CHANNEL: '沒有人可以問',
  APPROVAL_REJECTED_BY_USER: '人拒絕了',
  TOOL_DENIED_BY_LISTENER: '被攔截器拒絕',
};

/** 錯誤碼對應的一句話；不是核准那幾個碼就 `undefined`（只認自己的鍵，不認 `constructor` 這類原型上的）。 */
export function approvalCodeText(code: string): string | undefined {
  return Object.hasOwn(APPROVAL_CODE_LABEL, code) ? APPROVAL_CODE_LABEL[code] : undefined;
}
