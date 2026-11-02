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
 * - **清單途中的變化重放**（#1600 `N1362`，dsh `client/sessions/manager.ts:412-477`、`:600-606` 的 `listMutations`）：
 *   列表是冷讀磁碟，回來要好幾秒，回來時可能已經比全域下行舊。送出前記 `list-requested`，之後的 frame 照常套用、
 *   同時記下來；列表到了先當基線套上去，再照順序重放紀錄。重疊的刷新只套最新那一次的回應（ticket），紀錄從最早那一次
 *   起算。**每次接上都清掉紀錄**：斷線期間漏掉的 frame 不會補，斷線前記下的重放在接上後的清單之後會把舊事實蓋回去；
 *   接上之後馬上重抓，新的 ticket 丟掉舊的回應。
 * - **分叉的佔位**（#1581 刀 2，dsh `manager.ts:556-576` 的 `fork` 與 `:828-860` 的 `applyMutation`）：分叉一成功就放一列進清單，
 *   不等下一次刷新。它是變更紀錄的一筆：有刷新在途就記下來，回應到了照樣重放，晚到的舊清單蓋不掉它；沒有在途的話，下一份
 *   清單就是 server 講的話，佔位跟著清掉（子 thread 在 server 回分叉之前就落了盤，那一份清單裡有它）。清單上已經有那一列時，
 *   只補 `parentThreadId`，`blank` 只降不升。**佔位算講過（`engaged`）**：照 dsh 它是 `blank: true`，等 Host 的摘要校正；我們沒有
 *   session-added 推送，標著空白的話人一切走，那一列在下一次刷新之前就被側欄藏起來。分叉一定切在收了的一輪之後，子 thread
 *   不會是空的（偏離 dsh，理由 1：基座沒有那條推送）。
 * - **有效空白**（#1600 `N1363`，dsh `manager.ts:95`、`:284-298` 的 `engagedSessions`）：清單上的 `blank` 是磁碟上
 *   還沒有 `turn/start`。全域下行或清單說在跑過的那條就不算空白，**跑完也不鬆開**（照 dsh：跑完之後、下一次刷新之前
 *   快照還說空白），清單上沒有那條時才拿掉。
 *
 * **全部動作走同一個有序的 reducer**：接上的清空必須排在補送的第一顆之前。拆成兩次各自的 `setState`，React 合批時
 * 順序一錯，重接那一刻標記就全不見（#728 是同一個形狀）。
 *
 * @module
 */

/** 等人回答的三種。字串同 dsh `SessionPendingInteractionStatus`。 */
export type PendingKind = 'approval' | 'question' | 'plan-review';

const PRECEDENCE: Record<PendingKind, number> = { approval: 0, question: 1, 'plan-review': 2 };

/** 清單刷新途中記下、回應到了要重放的一筆變更（dsh 的 `SessionListMutation`）：全域下行的 frame，或分叉的佔位。 */
export type ListMutation =
  | { readonly kind: 'frame'; readonly frame: ThreadFeedFrame }
  | { readonly kind: 'placeholder'; readonly summary: ThreadSummary };

export interface ThreadStatusState {
  readonly current: string;
  readonly running: ReadonlyMap<string, boolean>;
  /** threadId → interruptId → 哪一種。 */
  readonly pending: ReadonlyMap<string, ReadonlyMap<string, PendingKind>>;
  readonly unread: ReadonlySet<string>;
  /** 列表回來過至少一次。之前連先前狀態都不知道的停下也算「跑完沒看」（dsh 的 `beforeBaseline`）。 */
  readonly baselined: boolean;
  /** 說在跑過的 thread（dsh 的 `engagedSessions`）：清單上標著空白也不算空白。 */
  readonly engaged: ReadonlySet<string>;
  /** 清單刷新途中的變更；`undefined` 是沒有刷新在途。 */
  readonly mutations: readonly ListMutation[] | undefined;
  /** 分叉的佔位，最新的在前；畫的時候由 {@link withPlaceholders} 合進清單。 */
  readonly placeholders: readonly ThreadSummary[];
}

export type ThreadStatusAction =
  | { readonly type: 'connected' }
  | { readonly type: 'frame'; readonly frame: ThreadFeedFrame }
  /** 送出一次列表請求，記在送出之前。 */
  | { readonly type: 'list-requested' }
  | { readonly type: 'listed'; readonly items: readonly ThreadSummary[] }
  /** 最新那一次列表請求失敗了：紀錄不再有人重放。 */
  | { readonly type: 'list-failed' }
  /** 分叉成功：子 thread 的佔位。 */
  | { readonly type: 'placeholder'; readonly summary: ThreadSummary }
  | { readonly type: 'current'; readonly threadId: string };

export function initialThreadStatus(current: string): ThreadStatusState {
  return {
    current,
    running: new Map(),
    pending: new Map(),
    unread: new Set(),
    baselined: false,
    engaged: new Set(),
    mutations: undefined,
    placeholders: [],
  };
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
  const engaged =
    running && !state.engaged.has(threadId) ? new Set(state.engaged).add(threadId) : state.engaged;
  if (running) unread.delete(threadId);
  else if (
    (previous === true || (previous === undefined && !state.baselined)) &&
    threadId !== state.current
  ) {
    unread.add(threadId);
  }
  return { ...state, running: nextRunning, unread, engaged };
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
      if (item.running) next = { ...next, engaged: new Set(next.engaged).add(item.threadId) };
    } else if (previous !== item.running) {
      next = observeRunning(next, item.threadId, item.running);
    } else if (item.running && !next.engaged.has(item.threadId)) {
      next = { ...next, engaged: new Set(next.engaged).add(item.threadId) };
    }
  }
  const present = new Set(items.map((item) => item.threadId));
  const running = new Map([...next.running].filter(([id]) => present.has(id)));
  const unread = new Set([...next.unread].filter((id) => present.has(id) && id !== next.current));
  const engaged = new Set([...next.engaged].filter((id) => present.has(id)));
  return { ...next, running, unread, engaged, baselined: true };
}

function applyPlaceholder(state: ThreadStatusState, summary: ThreadSummary): ThreadStatusState {
  const rest = state.placeholders.filter((row) => row.threadId !== summary.threadId);
  return {
    ...state,
    placeholders: [summary, ...rest],
    engaged: state.engaged.has(summary.threadId)
      ? state.engaged
      : new Set(state.engaged).add(summary.threadId),
  };
}

/** 列表到了之後，照順序重放刷新途中記下的變更（dsh `refreshList` 的 `mutations.reduce(applyMutation, baseline)`）。 */
function replay(state: ThreadStatusState, mutations: readonly ListMutation[]): ThreadStatusState {
  return mutations.reduce(
    (next, mutation) =>
      mutation.kind === 'frame'
        ? applyFrame(next, mutation.frame)
        : applyPlaceholder(next, mutation.summary),
    state,
  );
}

export function reduceThreadStatus(
  state: ThreadStatusState,
  action: ThreadStatusAction,
): ThreadStatusState {
  switch (action.type) {
    case 'connected':
      return {
        ...state,
        pending: new Map(),
        ...(state.mutations === undefined ? {} : { mutations: [] }),
      };
    case 'frame': {
      const next = applyFrame(state, action.frame);
      return state.mutations === undefined
        ? next
        : { ...next, mutations: [...state.mutations, { kind: 'frame', frame: action.frame }] };
    }
    case 'list-requested':
      return state.mutations === undefined ? { ...state, mutations: [] } : state;
    case 'listed':
      // 清單是基線：在途之前放的佔位由它取代，在途期間放的由重放放回去。
      return {
        ...replay(
          { ...applyListing(state, action.items), placeholders: [] },
          state.mutations ?? [],
        ),
        mutations: undefined,
      };
    case 'list-failed':
      return state.mutations === undefined ? state : { ...state, mutations: undefined };
    case 'placeholder': {
      const next = applyPlaceholder(state, action.summary);
      return state.mutations === undefined
        ? next
        : {
            ...next,
            mutations: [...state.mutations, { kind: 'placeholder', summary: action.summary }],
          };
    }
    case 'current': {
      if (action.threadId === state.current && !state.unread.has(action.threadId)) return state;
      const unread = new Set(state.unread);
      unread.delete(action.threadId);
      return { ...state, current: action.threadId, unread };
    }
  }
}

/**
 * 這一列算不算空白（#1600 `N1363`，dsh `effectiveBlank`）：清單說空白、而且沒有人說它在跑過。側欄的過濾、分組與
 * 「新對話」挑哪一條都看這個；列的名字與時間照舊看清單的 `blank`。
 */
export function effectiveBlank(state: ThreadStatusState, item: ThreadSummary): boolean {
  return item.blank && !state.engaged.has(item.threadId);
}

/**
 * 清單合上分叉的佔位（dsh `applyMutation` 的 `placeholder` 那一支）：清單上沒有的放最前面；已經有的只補 `parentThreadId`，
 * `blank` 只降不升，其餘照清單。沒有佔位時原樣回傳同一份。
 */
export function withPlaceholders(
  items: readonly ThreadSummary[],
  placeholders: readonly ThreadSummary[],
): readonly ThreadSummary[] {
  if (placeholders.length === 0) return items;
  const listed = new Set(items.map((item) => item.threadId));
  const fresh = placeholders.filter((row) => !listed.has(row.threadId));
  const filled = items.map((item) => {
    const placeholder = placeholders.find((row) => row.threadId === item.threadId);
    if (placeholder === undefined) return item;
    return {
      ...item,
      blank: item.blank && placeholder.blank,
      ...(item.parentThreadId === undefined && placeholder.parentThreadId !== undefined
        ? { parentThreadId: placeholder.parentThreadId }
        : {}),
    };
  });
  return [...fresh, ...filled];
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

/** 列上寫出來的狀態字。`waiting` 是等人回答的三種：這三種不帶時間、標題加粗。 */
export const ROW_STATUS_TEXT: Record<
  Exclude<RowStatus, undefined>,
  { readonly label: string; readonly waiting: boolean }
> = {
  approval: { label: '等待核准', waiting: true },
  'plan-review': { label: '計劃待審', waiting: true },
  question: { label: '等待回答', waiting: true },
  running: { label: '執行中', waiting: false },
  completed: { label: '已完成', waiting: false },
};
