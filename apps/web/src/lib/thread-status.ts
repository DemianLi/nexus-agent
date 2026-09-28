import type { Event, ThreadFeedFrame, ThreadSummary } from '@nexus/wire';
import { emptyConversation, isApprovalPending, reduceConversation } from '@nexus/wire';

import { isPlanReview } from '@/lib/plan-review';

/**
 * 側欄每一列的即時狀態（[#632](https://github.com/DemianLi/nexus-agent/issues/632)）：在跑、停著等人回答、跑完還沒看。
 *
 * 照 dsh `UiSession`（`packages/client/ui-session/src/client/index.ts`，`477b4f4`）的三格事實，逐條抄：
 *
 * - **在跑**：起點是列表（`reconcileStatus`），之後照全域下行的 `status` 翻。列表回來時先前不知道的**安靜寫入**，
 *   知道而不同的**當成一次翻轉**——所以也可能記下一筆「跑完沒看」。
 * - **等人回答**：全域下行的 `input-requested`／`input-withdrawn`，按 thread、按 `interruptId` 記。同一顆再來一次
 *   後到的蓋過先到的。一條 thread 同時掛好幾顆時照 dsh 的優先序取一顆：計劃審核 2 ＞ 提問 1 ＞ 核准 0。
 *   **每次接上都整份清掉**（`connected`）：伺服器接上當下會把還掛著的全部補送一次，清掉的是斷線期間已經答掉的。
 * - **跑完沒看**（dsh 的 `completionUnread`，`observeRunning`）：從在跑翻成閒著、而且不是目前打開的那條，記一筆；
 *   列表回來之前連先前狀態都不知道的那次停下也算。那條再跑起來、被打開、或列表上已經沒有它時清掉。
 *
 * **全部動作走同一個有序的 reducer**：接上的清空必須排在補送的第一顆之前。拆成兩次各自的 `setState`，React 合批時
 * 順序一錯，重接那一刻標記就全不見（#728 是同一個形狀）。
 *
 * @module
 */

/** 等人回答的三種。字串同 dsh `SessionPendingInteractionStatus`。 */
export type PendingKind = 'approval' | 'question' | 'plan-review';

const PRECEDENCE: Record<PendingKind, number> = { approval: 0, question: 1, 'plan-review': 2 };

export interface ThreadStatusState {
  readonly current: string;
  readonly running: ReadonlyMap<string, boolean>;
  /** threadId → interruptId → 哪一種。 */
  readonly pending: ReadonlyMap<string, ReadonlyMap<string, PendingKind>>;
  readonly unread: ReadonlySet<string>;
  /** 列表回來過至少一次。之前連先前狀態都不知道的停下也算「跑完沒看」（dsh 的 `beforeBaseline`）。 */
  readonly baselined: boolean;
}

export type ThreadStatusAction =
  | { readonly type: 'connected' }
  | { readonly type: 'frame'; readonly frame: ThreadFeedFrame }
  | { readonly type: 'listed'; readonly items: readonly ThreadSummary[] }
  | { readonly type: 'current'; readonly threadId: string };

export function initialThreadStatus(current: string): ThreadStatusState {
  return { current, running: new Map(), pending: new Map(), unread: new Set(), baselined: false };
}

/**
 * 一顆 `input.requested` 是哪一種。**跟畫面上的面板用同一個折疊器判**：核准與提問的分法（含 `kind` 缺席當核准、
 * 認不得的 `kind` 不收）只寫在 `@nexus/wire` 一處。認不得的回 `undefined`，那一列不畫標記。
 */
export function pendingKindOf(event: Event): PendingKind | undefined {
  const pending = reduceConversation(emptyConversation(), event).pendings[0];
  if (pending === undefined) return undefined;
  if (isApprovalPending(pending)) return 'approval';
  return isPlanReview(pending.questions) ? 'plan-review' : 'question';
}

function observeRunning(
  state: ThreadStatusState,
  threadId: string,
  running: boolean,
): ThreadStatusState {
  const previous = state.running.get(threadId);
  const nextRunning = new Map(state.running).set(threadId, running);
  const unread = new Set(state.unread);
  if (running) unread.delete(threadId);
  else if (
    (previous === true || (previous === undefined && !state.baselined)) &&
    threadId !== state.current
  ) {
    unread.add(threadId);
  }
  return { ...state, running: nextRunning, unread };
}

function applyFrame(state: ThreadStatusState, frame: ThreadFeedFrame): ThreadStatusState {
  switch (frame.type) {
    case 'status':
      return observeRunning(state, frame.threadId, frame.running);
    case 'input-requested': {
      const kind = pendingKindOf(frame.event);
      const interruptId = (frame.event.params.data as { interrupt_id?: unknown }).interrupt_id;
      if (kind === undefined || typeof interruptId !== 'string') return state;
      const own = new Map(state.pending.get(frame.threadId)).set(interruptId, kind);
      return { ...state, pending: new Map(state.pending).set(frame.threadId, own) };
    }
    case 'input-withdrawn': {
      const own = state.pending.get(frame.threadId);
      if (own === undefined || !own.has(frame.interruptId)) return state;
      const rest = new Map(own);
      rest.delete(frame.interruptId);
      const pending = new Map(state.pending);
      if (rest.size === 0) pending.delete(frame.threadId);
      else pending.set(frame.threadId, rest);
      return { ...state, pending };
    }
  }
}

function applyListing(
  state: ThreadStatusState,
  items: readonly ThreadSummary[],
): ThreadStatusState {
  let next = state;
  for (const item of items) {
    const previous = next.running.get(item.threadId);
    if (previous === undefined) {
      next = { ...next, running: new Map(next.running).set(item.threadId, item.running) };
    } else if (previous !== item.running) {
      next = observeRunning(next, item.threadId, item.running);
    }
  }
  const present = new Set(items.map((item) => item.threadId));
  const running = new Map([...next.running].filter(([id]) => present.has(id)));
  const unread = new Set([...next.unread].filter((id) => present.has(id) && id !== next.current));
  return { ...next, running, unread, baselined: true };
}

export function reduceThreadStatus(
  state: ThreadStatusState,
  action: ThreadStatusAction,
): ThreadStatusState {
  switch (action.type) {
    case 'connected':
      return { ...state, pending: new Map() };
    case 'frame':
      return applyFrame(state, action.frame);
    case 'listed':
      return applyListing(state, action.items);
    case 'current': {
      if (action.threadId === state.current && !state.unread.has(action.threadId)) return state;
      const unread = new Set(state.unread);
      unread.delete(action.threadId);
      return { ...state, current: action.threadId, unread };
    }
  }
}

/** 一列畫什麼。等人回答 ＞ 在跑 ＞ 跑完沒看 ＞ 什麼都不畫（dsh `sessionStatuses` 的順序）。 */
export type RowStatus = PendingKind | 'running' | 'completed' | undefined;

export function rowStatus(state: ThreadStatusState, item: ThreadSummary): RowStatus {
  const own = state.pending.get(item.threadId);
  if (own !== undefined && own.size > 0) {
    return [...own.values()].reduce((best, kind) =>
      PRECEDENCE[kind] > PRECEDENCE[best] ? kind : best,
    );
  }
  if (state.running.get(item.threadId) ?? item.running) return 'running';
  if (state.unread.has(item.threadId)) return 'completed';
  return undefined;
}

/**
 * 報讀器唸的那一句，以及取代時間的那幾個字（dsh 的 `label` 與 `trailingLabel`，文案照 dsh 的 zh 字典換成我們的用字）。
 * 只有等人回答的三種有短的那一句：dsh 也只替它們換掉時間。
 */
export const ROW_STATUS_TEXT: Record<
  Exclude<RowStatus, undefined>,
  { readonly label: string; readonly compact?: string }
> = {
  approval: { label: '等待核准', compact: '待核准' },
  'plan-review': { label: '計劃待審', compact: '計劃待審' },
  question: { label: '等待回答', compact: '待回答' },
  running: { label: '執行中' },
  completed: { label: '已完成' },
};
