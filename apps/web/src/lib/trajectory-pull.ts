/**
 * 軌跡的細節按需拉（[#1083](https://github.com/DemianLi/nexus-agent/issues/1083)）。
 *
 * 推送的軌跡投影只有最近幾輪帶逐呼叫、逐工具的結構，更早的輪只剩一行摘要。要看那些輪的細節，帶錨點（`seq` 或回覆的 `messageId`）
 * 向伺服器要**那一個邏輯輪**（`WireClient.trajectoryTurn`），回來的實體輪形狀、`index`、`seq` 都與推送的骨架相同，所以可以原位取代
 * 那幾列摘要。這裡是這條路的全部：拉取的 store（快取、進行中、失敗）與把拉回來的輪併進推送的 view 的純函式。
 *
 * ## 快取什麼
 *
 * 只信**已經不會再變**的輪：收了尾、沒有還在跑的工具、沒有還沒有結局的核准問題（那一種的結局會落在後面的 resume 輪裡）。
 * 其餘的照樣顯示，但標成還會變，推送的 view 往前走時（呼叫端去抖）重拉。推送窗口裡走過的輪若已定案也記進來（`seed`），
 * 所以窗口往前滑、它變成摘要時不必再問一次。
 *
 * ## 誰贏
 *
 * 窗口裡的輪**一律用推送的**（它跟著即時事件走）；拉回來的只取代窗口外的摘要。兩份都有同一個輪時，拉的那一份比摘要完整
 * （遲到的工具結果、後面 resume 輪才落日誌的核准結局都已折進去），計數以它為準。
 *
 * ## 回應不保證順序
 *
 * 路由允許並行、不保證回應順序。每一輪記下拉回來時伺服器看到的日誌位置（`through`），舊的不覆蓋新的；不靠請求的先後。
 *
 * @module
 */

import type {
  TrajectoryDigest,
  TrajectoryTurn,
  TrajectoryTurnQuery,
  TrajectoryView,
  WireClient,
} from '@nexus/wire';

/** 一個錨點：日誌上的位置，或回覆的訊息 id。 */
export type PullAnchor =
  | { readonly seq: number; readonly messageId?: undefined }
  | { readonly messageId: string; readonly seq?: undefined };

export function anchorKey(anchor: PullAnchor): string {
  return anchor.seq !== undefined ? `seq:${anchor.seq}` : `msg:${anchor.messageId}`;
}

/** 拉到（或從推送收進來）的一個實體輪。 */
export interface PulledTurn {
  readonly turn: TrajectoryTurn;
  /** 不會再變了（見檔頭）；不是的話推送往前走時要重拉。 */
  readonly final: boolean;
  /** 拉回來時伺服器看到的日誌位置；從推送收進來的是 {@link SEEDED}，任何一次拉都比它新。 */
  readonly through: number;
}

/** 從推送窗口收進來的輪的 `through`：沒有伺服器給的位置。 */
export const SEEDED = -1;

export interface PullSnapshot {
  /** 實體輪的 `seq` → 那一輪。 */
  readonly turns: ReadonlyMap<number, PulledTurn>;
  /** 進行中的錨點（{@link anchorKey}）。 */
  readonly pending: ReadonlySet<string>;
  /** 最近一次失敗的原因（伺服器給的中文原樣，或「連線出了問題」）；成功就清掉。 */
  readonly failed: ReadonlyMap<string, FailedPull>;
  /** 這份組裝沒掛軌跡投影（`not_supported`）：不再試。 */
  readonly unsupported: boolean;
}

export interface FailedPull {
  /** 伺服器的錯誤碼（`turn_not_found`…）；連線出問題是 {@link NETWORK_CODE}。 */
  readonly code: string;
  readonly message: string;
}

export const NETWORK_CODE = 'network';
export const NETWORK_MESSAGE = '連線出了問題';

export type PullOutcome = { readonly ok: true } | ({ readonly ok: false } & FailedPull);

export interface TrajectoryPuller {
  getSnapshot(): PullSnapshot;
  subscribe(listener: () => void): () => void;
  /**
   * 拉一個邏輯輪。同一個錨點進行中就回同一個承諾（不重送）。已經拉過成功的**也照拉**：要不要拉由呼叫端看快取決定。
   * 不會拋：失敗是 `{ ok: false }`，也記進快照的 `failed`。
   */
  pull(anchor: PullAnchor): Promise<PullOutcome>;
  /** 把推送窗口裡已定案的輪收進快取。 */
  seed(turns: readonly TrajectoryTurn[]): void;
  /** 清掉快取與失敗（軌跡投影不可用、換版本時）。進行中的請求照走，但回來的不收。 */
  reset(): void;
  /** 中止進行中的請求（換對話時）。之後仍可 `pull`。 */
  dispose(): void;
}

/** 最多留幾個實體輪。超過就丟最早進來的；丟掉的輪回到摘要，要看再拉。 */
export const PULLED_TURNS_MAX = 80;

const EMPTY: PullSnapshot = {
  turns: new Map(),
  pending: new Set(),
  failed: new Map(),
  unsupported: false,
};

/** 一輪定案了嗎：收了尾、沒有還在跑的工具、沒有還沒有結局的核准問題。 */
export function isFinalTurn(turn: TrajectoryTurn): boolean {
  if (turn.end === undefined) return false;
  for (const call of turn.calls) {
    if (call.tools.some((tool) => tool.status === 'running')) return false;
  }
  if (turn.looseTools.some((tool) => tool.status === 'running')) return false;
  return !turn.decisions.some(
    (decision) =>
      decision.kind === 'interrupt' &&
      decision.approval !== undefined &&
      decision.approval.outcome === undefined,
  );
}

export function createTrajectoryPuller(
  client: Pick<WireClient, 'trajectoryTurn'>,
  threadId: string,
): TrajectoryPuller {
  let snapshot: PullSnapshot = EMPTY;
  /** 換代：`reset` 之後回來的舊請求不收。 */
  let epoch = 0;
  const listeners = new Set<() => void>();
  interface Inflight {
    promise: Promise<PullOutcome>;
    abort: AbortController;
  }
  const inflight = new Map<string, Inflight>();

  const publish = (next: PullSnapshot) => {
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };

  const store = (
    turns: ReadonlyMap<number, PulledTurn>,
    incoming: readonly TrajectoryTurn[],
    through: number,
  ): ReadonlyMap<number, PulledTurn> => {
    const next = new Map(turns);
    for (const turn of incoming) {
      const old = next.get(turn.seq);
      if (old !== undefined && old.through > through) continue;
      // 重新放進去讓它排到最後（最近用到的最後被丟）。
      next.delete(turn.seq);
      next.set(turn.seq, { turn, final: isFinalTurn(turn), through });
    }
    while (next.size > PULLED_TURNS_MAX) {
      const oldest = next.keys().next();
      if (oldest.done === true) break;
      next.delete(oldest.value);
    }
    return next;
  };

  const run = async (anchor: PullAnchor, signal: AbortSignal): Promise<PullOutcome> => {
    const query: TrajectoryTurnQuery =
      anchor.seq !== undefined ? { seq: anchor.seq } : { messageId: anchor.messageId };
    const started = epoch;
    try {
      const outcome = await client.trajectoryTurn(threadId, query, signal);
      if (started !== epoch) return { ok: true };
      if (outcome.kind === 'ok') {
        const { turns, seq } = outcome.result;
        const failed = new Map(snapshot.failed);
        failed.delete(anchorKey(anchor));
        publish({ ...snapshot, turns: store(snapshot.turns, turns, seq), failed });
        return { ok: true };
      }
      return { ok: false, code: outcome.code, message: outcome.message };
    } catch {
      return signal.aborted
        ? { ok: false, code: 'aborted', message: '已取消' }
        : { ok: false, code: NETWORK_CODE, message: NETWORK_MESSAGE };
    }
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    pull(anchor) {
      const key = anchorKey(anchor);
      const existing = inflight.get(key);
      if (existing !== undefined) return existing.promise;
      const abort = new AbortController();
      const failed = new Map(snapshot.failed);
      failed.delete(key);
      publish({ ...snapshot, pending: new Set(snapshot.pending).add(key), failed });
      const started = epoch;
      const entry = { abort } as Inflight;
      entry.promise = run(anchor, abort.signal).then((outcome) => {
        // `reset` 之後同一個錨點可能已經有新的請求占著位置：只收自己的。
        if (inflight.get(key) === entry) inflight.delete(key);
        if (started !== epoch) return outcome;
        const pending = new Set(snapshot.pending);
        pending.delete(key);
        if (outcome.ok) {
          publish({ ...snapshot, pending });
        } else if (outcome.code === 'aborted') {
          publish({ ...snapshot, pending });
        } else {
          publish({
            ...snapshot,
            pending,
            failed: new Map(snapshot.failed).set(key, {
              code: outcome.code,
              message: outcome.message,
            }),
            unsupported: snapshot.unsupported || outcome.code === 'not_supported',
          });
        }
        return outcome;
      });
      inflight.set(key, entry);
      return entry.promise;
    },
    seed(turns) {
      const fresh = turns.filter((turn) => {
        const old = snapshot.turns.get(turn.seq);
        return old === undefined && isFinalTurn(turn);
      });
      if (fresh.length === 0) return;
      publish({ ...snapshot, turns: store(snapshot.turns, fresh, SEEDED) });
    },
    reset() {
      epoch += 1;
      for (const { abort } of inflight.values()) abort.abort();
      inflight.clear();
      if (snapshot !== EMPTY) publish(EMPTY);
    },
    dispose() {
      for (const { abort } of inflight.values()) abort.abort();
    },
  };
}

/** 摘要補成一個沒有逐呼叫結構的輪（只有計數），畫成「只有摘要」的一組。 */
function placeholderOf(digest: TrajectoryDigest): TrajectoryTurn {
  return {
    ...digest,
    inputs: [],
    calls: [],
    looseTools: [],
    decisions: [],
    unattributed: 0,
  };
}

export interface MergedTrajectory {
  readonly view: TrajectoryView;
  /** 補出來的、只有摘要的輪的 `seq`（要畫「載入這一輪的細節」）。 */
  readonly placeholders: ReadonlySet<number>;
}

const NO_PLACEHOLDERS: ReadonlySet<number> = new Set();

/**
 * 把拉到的輪併進推送的 view。
 *
 * 窗口外的摘要若拉過了，就換成完整的輪。**順序是時間順序**：`digests` 都在 `turns` 之前，所以從第一個換成完整輪的那一列起，
 * 後面還沒拉的摘要改成「只有摘要」的輪（{@link MergedTrajectory.placeholders}）跟在它後面，不然較新的摘要會畫在較舊的完整輪上面。
 * 窗口裡的輪照推送的。沒有任何一列換得上時，回的是**原來那個 view 物件**（參照不變，下游的 `memo` 才擋得住）。
 */
export function mergePulled(
  view: TrajectoryView,
  pulled: ReadonlyMap<number, PulledTurn>,
): MergedTrajectory {
  const first = view.digests.findIndex((digest) => pulled.has(digest.seq));
  if (first === -1) return { view, placeholders: NO_PLACEHOLDERS };
  const placeholders = new Set<number>();
  const promoted: TrajectoryTurn[] = [];
  for (const digest of view.digests.slice(first)) {
    const got = pulled.get(digest.seq);
    if (got !== undefined) {
      promoted.push(got.turn);
    } else {
      promoted.push(placeholderOf(digest));
      placeholders.add(digest.seq);
    }
  }
  return {
    view: {
      digests: view.digests.slice(0, first),
      omitted: view.omitted,
      turns: [...promoted, ...view.turns],
    },
    placeholders,
  };
}

/**
 * 該預先拉哪些錨點：窗口前面最近的 {@link PREFETCH_LOGICAL} 個邏輯輪，與窗口第一輪若是 `resume`（它接著的那一輪在窗口外）。
 * 已經拉到的（含從推送收進來的）、進行中的、失敗過的不再排；`unsupported` 一個都不排。
 */
export const PREFETCH_LOGICAL = 2;

export function prefetchAnchors(view: TrajectoryView, snapshot: PullSnapshot): PullAnchor[] {
  if (snapshot.unsupported) return [];
  const skip = (seq: number) => {
    const key = anchorKey({ seq });
    return snapshot.pending.has(key) || snapshot.failed.has(key);
  };
  const anchors: PullAnchor[] = [];
  const first = view.turns[0];
  if (
    first !== undefined &&
    !first.logical &&
    view.digests.length > 0 &&
    !snapshot.turns.has(view.digests[view.digests.length - 1]!.seq) &&
    !skip(first.seq)
  ) {
    anchors.push({ seq: first.seq });
  }
  let logical = 0;
  for (let i = view.digests.length - 1; i >= 0 && logical < PREFETCH_LOGICAL; i -= 1) {
    const digest = view.digests[i]!;
    if (!digest.logical) continue;
    logical += 1;
    // 這個邏輯輪的實體輪都拉到了就不用再問；錨點若已在清單裡（resume 邊界那一個）也不重複。
    const next = view.digests[i + 1];
    const group = [digest, ...(next !== undefined && !next.logical ? [next] : [])];
    if (group.every((d) => snapshot.turns.has(d.seq))) continue;
    if (skip(digest.seq) || anchors.some((a) => a.seq === digest.seq)) continue;
    anchors.push({ seq: digest.seq });
  }
  return anchors;
}

/** 拉過、但還會變的輪（窗口外的）：推送的 view 往前走時要重拉的錨點。同一個邏輯輪只問一次，錨點取它第一個實體輪。 */
export function staleAnchors(view: TrajectoryView, snapshot: PullSnapshot): PullAnchor[] {
  if (snapshot.unsupported) return [];
  const starts = new Set<number>();
  let start: number | undefined;
  for (const digest of view.digests) {
    if (digest.logical || start === undefined) start = digest.seq;
    const got = snapshot.turns.get(digest.seq);
    if (got === undefined || got.final) continue;
    if (!snapshot.pending.has(anchorKey({ seq: start }))) starts.add(start);
  }
  return [...starts].map((seq) => ({ seq }));
}

/** 這一列摘要（或只有摘要的組）現在能不能拉、拉到哪一步：給畫面決定顯示什麼。 */
export type PullStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | ({ readonly kind: 'failed' } & FailedPull);

export function statusOf(snapshot: PullSnapshot, seq: number): PullStatus {
  const key = anchorKey({ seq });
  if (snapshot.pending.has(key)) return { kind: 'loading' };
  const failed = snapshot.failed.get(key);
  return failed === undefined ? { kind: 'idle' } : { kind: 'failed', ...failed };
}
