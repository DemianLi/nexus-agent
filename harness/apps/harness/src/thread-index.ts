/**
 * serve 的會話列表索引（[#725](https://github.com/DemianLi/nexus-agent/issues/725)）：`GET /threads` 讀記憶體裡的索引，只在某一列可能變了時重讀那一份。
 *
 * 每一列怎麼算（可見規則、標題、`updatedAt`、讀不懂的怎麼數）跟冷讀的 {@link listStoredThreads} 是同一支
 * {@link summarizeStoredThread}，這裡只管**什麼時候重算哪一列**：
 *
 * - **建置**：serve 起來就開始（{@link ThreadIndex.warm}），整個行程一次；第一個請求等它。失敗就丟掉，下一個請求重建。
 * - **標起來的**：存放處寫完（`JsonlSessionStoreOptions.onWritten`）、刪除與復原（{@link touchingIndex}）、per-thread 前台聽到
 *   那條 thread 接上、有動靜或轉送完一個請求，都叫 {@link ThreadIndex.touch}。下一個請求先把這幾條重讀完才回；同一條正有一次重讀在跑，
 *   等它跑完還被標著（重讀開始之後又寫過）就再讀一次。所以標起來的改動，下一次列表一定看得到。
 * - **沒標到的**（同一格的另一台 serve、手動搬檔、對話行程落盤但沒在線上講的）：請求進來時，離上一次重掃開始已經
 *   `revalidateAfterMs`，就在背景重掃一次，**這個請求不等它**。重掃只重讀 revision 變了、或重讀後沒記 revision 的那幾份。
 *   所以最晚是「寫入之後才開始的那一次重掃跑完」之後的第一個請求才看得到。
 *
 * @module
 */

import {
  SessionCorruptionError,
  SessionFormatUnsupportedError,
  SessionNotFoundError,
} from '@nexus/core';
import type { SessionStore, StoredSessionHeader } from '@nexus/core';

import {
  isListedThread,
  sortThreadSummaries,
  summarizeStoredThread,
  tooLargeSummary,
} from './session-list.js';
import type { StoredThreadList, StoredThreadSummary } from './session-list.js';
import { assertThreadTitleLimits } from './session-title.js';
import type { ThreadTitleLimits } from './session-title.js';

export interface ThreadIndex {
  /**
   * 現在的列表。建好之前等建置；`signal` 中止只放棄這一次的等待，建置照跑。
   *
   * @throws 建置或重讀失敗（下一次再試）；`signal` 中止時拋它的 `reason`。
   */
  list(signal?: AbortSignal): Promise<StoredThreadList>;
  /** 這一條寫過了（或被刪、被復原了）：下一次 {@link list} 回之前重讀它。不讀檔，叫幾次都一樣。 */
  touch(threadId: string): void;
  /** 開始建置（已經在建或建好就什麼都不做）。失敗交給 `warn`，下一次 {@link list} 重建。 */
  warm(): void;
  /** 停掉還在跑的建置或重掃，等它們停下來。之後的 {@link list} 拋錯。不 reject。 */
  close(): Promise<void>;
}

export interface ThreadIndexOptions {
  readonly cwd: string;
  readonly title: ThreadTitleLimits;
  /** 上一次重掃開始多久之後，下一個請求要在背景再掃一次。 */
  readonly revalidateAfterMs: number;
  /** 背景的建置或重掃失敗時講一行。 */
  readonly warn: (message: string, error: unknown) => void;
  readonly now?: () => number;
  /**
   * 重讀標起來的那幾條之前叫一次。per-thread 的前台用它請對話行程把批次窗口裡的日誌排空，不然讀到的是還沒落盤之前的那一份。
   * 不拋；`signal` 是那一次請求的。
   */
  readonly beforeReread?: (signal?: AbortSignal) => Promise<void>;
}

type Row = StoredThreadSummary | 'unreadable';

interface Entry {
  /** 讀這一列時那一份的 revision；重讀 touch 過的那條時拿不到，留空，下一次重掃一定重讀。 */
  readonly revision: string | undefined;
  readonly row: Row;
}

/**
 * 建一個空的索引，不讀檔；建置由 {@link ThreadIndex.warm} 或第一次 {@link ThreadIndex.list} 開始。
 *
 * @throws `options.title` 不合法（`assertThreadTitleLimits`）。
 */
export function createThreadIndex(store: SessionStore, options: ThreadIndexOptions): ThreadIndex {
  assertThreadTitleLimits(options.title);
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();
  /** `store.list` 自己數的讀不懂（header 那一層）。 */
  let headerUnreadable = 0;
  const dirty = new Set<string>();
  const rereading = new Map<string, Promise<void>>();
  /** 每條最後一次被 touch 的序號：重掃開始之後 touch 過的，重掃的結果不蓋它。 */
  const touchedAt = new Map<string, number>();
  let tick = 0;
  let built: Promise<void> | undefined;
  let scanning: Promise<void> | undefined;
  let lastScanAt = Number.NEGATIVE_INFINITY;
  const stopped = new AbortController();

  async function scan(): Promise<void> {
    const signal = stopped.signal;
    const startTick = tick;
    lastScanAt = now();
    const listing = await store.list({ signal });
    const fresh = (id: string) => (touchedAt.get(id) ?? 0) <= startTick;
    const seen = new Set<string>();
    for (const { header, revision } of listing.sessions) {
      if (!isListedThread(header, options.cwd)) continue;
      seen.add(header.id);
      if (entries.get(header.id)?.revision === revision) continue;
      signal.throwIfAborted();
      const row = await summarizeStoredThread(store, header, options.title);
      if (!fresh(header.id)) continue;
      settle(header, row, revision);
    }
    for (const id of entries.keys()) {
      if (!seen.has(id) && fresh(id)) entries.delete(id);
    }
    headerUnreadable = listing.unreadable;
  }

  async function reread(id: string): Promise<void> {
    let header: StoredSessionHeader;
    try {
      ({ header } = await store.open(id, 'read'));
    } catch (error: unknown) {
      const row = rowAfterOpenFailure(error);
      if (row === 'gone') entries.delete(id);
      else entries.set(id, { revision: undefined, row });
      return;
    }
    if (!isListedThread(header, options.cwd)) {
      entries.delete(id);
      return;
    }
    const row = await summarizeStoredThread(store, header, options.title);
    settle(header, row, undefined);
    // 讀不進來是暫時的（額度被佔著）：下一次列表再試。
    if (row === 'too-large') dirty.add(id);
  }

  /**
   * 記下讀到的那一列。讀不進來的那一份留著上一次讀到的（沒有才用 {@link tooLargeSummary}），revision 留空，下一次重掃一定重讀。
   */
  function settle(
    header: StoredSessionHeader,
    row: Awaited<ReturnType<typeof summarizeStoredThread>>,
    revision: string | undefined,
  ): void {
    if (row === 'gone') {
      entries.delete(header.id);
    } else if (row === 'too-large') {
      const kept = entries.get(header.id)?.row;
      entries.set(header.id, { revision: undefined, row: kept ?? tooLargeSummary(header) });
    } else {
      entries.set(header.id, { revision, row });
    }
  }

  function build(): Promise<void> {
    if (built === undefined) {
      const attempt = scan();
      built = attempt;
      attempt.catch(() => {
        if (built === attempt) built = undefined;
      });
    }
    return built;
  }

  function revalidate(): void {
    if (scanning !== undefined || now() - lastScanAt < options.revalidateAfterMs) return;
    scanning = scan()
      .catch((error: unknown) => {
        if (!stopped.signal.aborted) options.warn('背景重掃會話列表失敗', error);
      })
      .finally(() => {
        scanning = undefined;
      });
  }

  /**
   * 這一次請求開始時標著的每一條，回之前都有一次**在這次請求開始之後才起跑**的重讀：別的請求早先起的那一次可能早於最後一次寫入，
   * 等它完、還被標著就自己再讀一次。每條最多等一次、讀一次：一直在寫的那一條不會把請求卡住。
   * 開始時正被別的請求重讀、標記已經被拿走的那幾條也等它讀完；不等的話，這一次回的列表少了那一條，而它比那個請求晚送出、可能先回（#3022）。
   */
  async function drainDirty(signal: AbortSignal | undefined): Promise<void> {
    if (dirty.size === 0 && rereading.size === 0) return;
    if (dirty.size > 0) await options.beforeReread?.(signal);
    for (const id of new Set([...dirty, ...rereading.keys()])) {
      signal?.throwIfAborted();
      await rereading.get(id)?.catch(() => {});
      if (!dirty.has(id)) continue;
      const started = rereading.get(id);
      if (started !== undefined) {
        // 等的時候另一個請求先起了一次：它也是在這次請求開始之後才起跑的。
        await started;
        continue;
      }
      dirty.delete(id);
      const pending = reread(id).finally(() => rereading.delete(id));
      pending.catch(() => dirty.add(id));
      rereading.set(id, pending);
      await pending;
    }
  }

  return {
    async list(signal) {
      stopped.signal.throwIfAborted();
      await abandonable(build(), signal);
      revalidate();
      await drainDirty(signal);
      const items: StoredThreadSummary[] = [];
      let unreadable = headerUnreadable;
      for (const { row } of entries.values()) {
        if (row === 'unreadable') unreadable += 1;
        else items.push(row);
      }
      sortThreadSummaries(items);
      return { items, unreadable };
    },
    touch(threadId) {
      // 還沒開始建：建置本身會讀到現在的磁碟，不用記（對話行程永遠不建，標記也就不會一直長）。
      if (built === undefined) return;
      tick += 1;
      touchedAt.set(threadId, tick);
      dirty.add(threadId);
    },
    warm() {
      build().catch((error: unknown) => {
        if (!stopped.signal.aborted) options.warn('建會話列表索引失敗', error);
      });
    },
    async close() {
      stopped.abort(new Error('會話列表索引已關閉'));
      await Promise.allSettled([built, scanning, ...rereading.values()]);
    },
  };
}

/** `open` 就失敗的那一條，照 {@link summarizeStoredThread} 的分寸：沒了、讀不懂，其餘照拋。 */
function rowAfterOpenFailure(error: unknown): 'gone' | 'unreadable' {
  if (error instanceof SessionNotFoundError) return 'gone';
  if (error instanceof SessionCorruptionError || error instanceof SessionFormatUnsupportedError) {
    return 'unreadable';
  }
  throw error;
}

/** 等 `work`，但 `signal` 中止就先拋它的 `reason`；`work` 照跑。 */
function abandonable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * serve 的 {@link ThreadIndexOptions.revalidateAfterMs}：兩次背景重掃之間至少隔這麼久。重掃只是補漏（這個行程寫的與 per-thread 對話行程講過話的都會 touch），
 * 一次要讀過每一份的 header：10k 份約 2.4 秒 CPU（含讀檔執行緒），隔 2 秒的話持續有人列表時一直在掃（量測見 #725 的留言）。
 */
export const THREAD_INDEX_REVALIDATE_MS = 30_000;

/**
 * 刪除與復原不經存放處寫入（整個目錄搬進搬出），由這一層在它們之後 touch 那一條：成敗都 touch，失敗時可能搬了一半。
 */
export function touchingIndex<
  Port extends {
    delete(request: { readonly threadId: string }): Promise<unknown>;
    restore(request: { readonly threadId: string }): Promise<unknown>;
  },
>(port: Port, index: ThreadIndex | undefined): Port {
  if (index === undefined) return port;
  return {
    ...port,
    delete: async (request: Parameters<Port['delete']>[0]) => {
      try {
        return await port.delete(request);
      } finally {
        index.touch(request.threadId);
      }
    },
    restore: async (request: Parameters<Port['restore']>[0]) => {
      try {
        return await port.restore(request);
      } finally {
        index.touch(request.threadId);
      }
    },
  };
}
