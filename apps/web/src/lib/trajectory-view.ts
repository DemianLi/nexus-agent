/**
 * 讀軌跡投影（[#1027](https://github.com/DemianLi/nexus-agent/issues/1027)）的那一層：哪些值可以信、怎麼寫成字。
 * 觀測分頁（`trace-view.ts`、`trace-panel.tsx`）只透過這裡碰投影，所以「不認得的版本不畫、拋過的不畫」只有一個地方。
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
  TrajectoryDecision,
  TrajectoryEnd,
  TrajectoryTurnKind,
  TrajectoryView,
} from '@nexus/wire';

/** 沒記的欄位顯示成這個。 */
export const ABSENT = '—';

function viewOf(state: ConversationState, key: string, version: number): unknown {
  const projection = state.projections[key];
  if (projection === undefined || projection.failed === true || projection.version !== version) {
    return undefined;
  }
  return projection.view;
}

/** 軌跡投影的 view；沒有、拋過、版本不認得、形狀不對都是 `undefined`。 */
export function trajectoryOf(state: ConversationState): TrajectoryView | undefined {
  const view = viewOf(state, TRAJECTORY_PROJECTION, TRAJECTORY_VERSION);
  if (typeof view !== 'object' || view === null) return undefined;
  const { turns, digests, omitted } = view as Partial<TrajectoryView>;
  if (!Array.isArray(turns) || !Array.isArray(digests) || typeof omitted !== 'number') {
    return undefined;
  }
  return view as TrajectoryView;
}

/** 請求快照投影的 view；同上。 */
export function snapshotsOf(state: ConversationState): RequestSnapshotsView | undefined {
  const view = viewOf(state, REQUEST_SNAPSHOTS_PROJECTION, REQUEST_SNAPSHOTS_VERSION);
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

/** 一輪是怎麼開始的。 */
export const TURN_KIND_LABEL: Readonly<Record<TrajectoryTurnKind, string>> = {
  message: '人的訊息',
  resume: '核准後續接',
  'agent-message': '子代理來信',
  'subagent-settled': '子代理結算',
  goal: '目標排的輪',
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
      return '停下來等人決定';
  }
}
