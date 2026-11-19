import type { ThreadListOutcome, ThreadListResult, ThreadSummary, WireClient } from '@nexus/wire';
import { THREAD_LIST_IDS_MAX } from '@nexus/wire';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';

import { reconnectDelay } from '@/shared/connection/reconnect';
import {
  effectiveBlank,
  initialThreadStatus,
  reduceThreadStatus,
  rowStatus,
  unlistedRows,
} from '@/features/threads/status';
import type { RowStatus, ThreadStatusState } from '@/features/threads/status';

/**
 * 以前的會話那份清單，加上每一列的即時狀態（[#632](https://github.com/DemianLi/nexus-agent/issues/632)）。
 *
 * **掛在 `App`，不掛在側欄**：換 thread 會把整個對話畫面連同側欄重掛（`app/App.tsx` 的 `key`），掛在那裡的話每換一條
 * 全域下行就重開一次，「跑完沒看」也跟著歸零。
 *
 * - **全域下行**（`WireClient.openThreadFeed`）：一個分頁一條。斷了照 `shared/connection/reconnect.ts` 的退避重接，不放棄。
 * - **列表**：全域下行**每次接上**（含第一次）重抓一次，當「在跑」的起點——那條線不補送狀態（`THREAD_FEED_PATH`）。
 *   側欄打開時也重抓（`refresh`，#302 的理由：清單會變，復原與改名不走那條線；新增、刪除與釘選、封存走那條線，見 `features/threads/status.ts`）。**平常只有這兩個時機**：線開不起來又沒打開
 *   側欄，就一次都不抓。另外在動作之後由呼叫端叫 `refresh`：側欄的封存、刪除、復原成功之後，打開的這條被拒說已刪除時，以及打開的這條講過話、清單上卻沒有它時（`app/App.tsx`）。晚送出的那一次回來之後，早送出、晚回來的那一份丟掉。送出前記 `list-requested`，途中的
 *   frame 在回應到了之後重放（#1600，見 `features/threads/status.ts`）。
 * - **一次一頁**（[#725](https://github.com/DemianLi/nexus-agent/issues/725)）：先載 {@link THREAD_PAGE_SIZE} 條，`loadMore` 再多一頁；重抓載回跟現在一樣多條。
 *   一定要在清單上的（目前這條、釘選的、有狀態的、內容搜尋命中的、打開的已封存）沒載到就照 id 補，所以「清單上沒有」仍然是「server 上沒有」。
 *   還有沒載的頁時，列表回來不清掉沒列到的那幾條的狀態（`listed` 的 `complete`）。
 *
 * @module
 */

export type Listing =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ok'; readonly result: ThreadListResult }
  | {
      readonly kind: 'failed';
      readonly message: string;
      /** server 回的錯誤碼；網路層拋的錯沒有。`not_supported` 是這台 server 沒接落盤（#1964 用它藏分支鈕）。 */
      readonly code?: string;
    };

/** 一次載幾條（#725）。 */
export const THREAD_PAGE_SIZE = 50;

export interface ThreadDirectory {
  /** 載入了的列：前面幾頁，加上照 id 補的（目前這條、釘選的、有狀態的、內容搜尋命中的、打開的已封存）。`nextCursor` 在就是還有沒載的。 */
  readonly listing: Listing;
  readonly statusOf: (item: ThreadSummary) => RowStatus;
  /** 這一列算不算空白：清單說空白、而且沒有人說它在跑過（#1600，`effectiveBlank`）。 */
  readonly blankOf: (item: ThreadSummary) => boolean;
  /** 重抓一次列表：載回跟現在一樣多條（至少一頁）。 */
  readonly refresh: () => void;
  /** 多載一頁；已經在載或沒有下一頁就什麼都不做。 */
  readonly loadMore: () => void;
  /** 正在多載一頁。 */
  readonly loadingMore: boolean;
  /** 要這幾條在清單上：沒載到的照 id 補（內容搜尋的命中、打開的已封存）。不存在的不再問。 */
  readonly ensureRows: (threadIds: readonly string[]) => void;
  /** 只比標題，問 server（還有沒載的頁時用）：回比到的前 {@link THREAD_PAGE_SIZE} 條。失敗回 `undefined`。 */
  readonly findTitles: (
    query: string,
    signal: AbortSignal,
  ) => Promise<readonly ThreadSummary[] | undefined>;
  /** 清單之外的列：分叉的佔位（#1581）與推來的新增（#2988），各自最新的在前；畫清單時用 `withPlaceholders` 合進 `listing` 的列。 */
  readonly placeholders: readonly ThreadSummary[];
  /** 分叉成功：把子 thread 先放進清單，不等下一次刷新（規則見 `features/threads/status.ts`）。 */
  readonly addPlaceholder: (summary: ThreadSummary) => void;
  /** 全域下行推來的整份釘選、封存集合（#2990），下一份清單回來之前以它為準；沒推過的那一個不在。 */
  readonly pushedSets: ThreadStatusState['pushed'];
  /** 全域下行推來過幾顆刪除（#2990）：變了就重讀已刪除清單。 */
  readonly removals: number;
}

/** 列表的順序：`updatedAt` 由新到舊，一樣時照 id。 */
function byListOrder(left: ThreadSummary, right: ThreadSummary): number {
  return (
    right.updatedAt - left.updatedAt ||
    (left.threadId < right.threadId ? -1 : left.threadId > right.threadId ? 1 : 0)
  );
}

interface Loaded {
  /** 照頁載的，列表順序。 */
  readonly pages: readonly ThreadSummary[];
  /** 照 id 補的、不在 `pages` 裡的。 */
  readonly extras: ReadonlyMap<string, ThreadSummary>;
  readonly nextCursor: string | undefined;
  /** 最近一份回應：`unreadable` 與兩個集合照它。 */
  readonly head: ThreadListResult;
}

function listingOf(loaded: Loaded): ThreadListResult {
  const { nextCursor: _ignored, ...head } = loaded.head;
  const items =
    loaded.extras.size === 0
      ? loaded.pages
      : [...loaded.pages, ...loaded.extras.values()].sort(byListOrder);
  return {
    ...head,
    items,
    ...(loaded.nextCursor !== undefined && { nextCursor: loaded.nextCursor }),
  };
}

/** 照 id 補，一次最多 `THREAD_LIST_IDS_MAX` 條。 */
async function rowsById(
  client: WireClient,
  threadIds: readonly string[],
): Promise<readonly ThreadSummary[]> {
  const rows: ThreadSummary[] = [];
  for (let at = 0; at < threadIds.length; at += THREAD_LIST_IDS_MAX) {
    const outcome = await client.listThreads({
      ids: threadIds.slice(at, at + THREAD_LIST_IDS_MAX),
    });
    if (outcome.kind !== 'ok') throw new Error(outcome.message);
    rows.push(...outcome.result.items);
  }
  return rows;
}

export function useThreadDirectory(client: WireClient, currentThreadId: string): ThreadDirectory {
  const [listing, setListing] = useState<Listing>({ kind: 'loading' });
  const [status, dispatch] = useReducer(reduceThreadStatus, currentThreadId, initialThreadStatus);
  const [loadingMore, setLoadingMore] = useState(false);
  const ticket = useRef(0);
  const loaded = useRef<Loaded | undefined>(undefined);
  /** 不必再照 id 問的：正在問的、問過說沒有的、翻到底也沒列到的。重抓時重算。 */
  const absent = useRef(new Set<string>());
  /** 呼叫端要的（{@link ThreadDirectory.ensureRows}）。 */
  const [requested, setRequested] = useState<ReadonlySet<string>>(new Set());
  const wanted = useRef<readonly string[]>([]);

  const publish = useCallback((next: Loaded) => {
    loaded.current = next;
    setListing({ kind: 'ok', result: listingOf(next) });
  }, []);

  const refresh = useCallback(() => {
    ticket.current += 1;
    const mine = ticket.current;
    const depth = Math.max(THREAD_PAGE_SIZE, loaded.current?.pages.length ?? 0);
    dispatch({ type: 'list-requested' });
    const read = async (): Promise<Loaded | { readonly failed: ThreadListOutcome }> => {
      const pages: ThreadSummary[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      let head: ThreadListResult | undefined;
      // 重抓跟現在一樣多頁：全域下行重接一次，按「載入更多」載到的不會被收回去。
      do {
        const outcome = await client.listThreads({
          limit: THREAD_PAGE_SIZE,
          ...(cursor !== undefined && { cursor }),
        });
        if (outcome.kind !== 'ok') return { failed: outcome };
        head = outcome.result;
        for (const item of outcome.result.items) {
          if (seen.has(item.threadId)) continue;
          seen.add(item.threadId);
          pages.push(item);
        }
        cursor = outcome.result.nextCursor;
      } while (cursor !== undefined && pages.length < depth);
      absent.current = new Set();
      const missing = wanted.current.filter((id) => !seen.has(id));
      const extras = new Map<string, ThreadSummary>();
      // 翻到底了：沒列到的就是 server 上沒有，不必照 id 再問。
      if (missing.length > 0 && cursor !== undefined) {
        const found = await rowsById(client, missing);
        for (const item of found) if (!seen.has(item.threadId)) extras.set(item.threadId, item);
      }
      for (const id of missing) if (!extras.has(id)) absent.current.add(id);
      return { pages, extras, nextCursor: cursor, head: head! };
    };
    read().then(
      (outcome) => {
        if (mine !== ticket.current) return;
        if ('failed' in outcome) {
          const failed = outcome.failed as Extract<ThreadListOutcome, { kind: 'rejected' }>;
          setListing({
            kind: 'failed',
            message: failed.message,
            ...(failed.code === undefined ? {} : { code: failed.code }),
          });
          dispatch({ type: 'list-failed' });
          return;
        }
        publish(outcome);
        dispatch({
          type: 'listed',
          items: listingOf(outcome).items,
          complete: outcome.nextCursor === undefined,
        });
      },
      (error: unknown) => {
        if (mine !== ticket.current) return;
        dispatch({ type: 'list-failed' });
        setListing({
          kind: 'failed',
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }, [client, publish]);

  const loadMore = useCallback(() => {
    const at = loaded.current;
    if (at?.nextCursor === undefined || loadingMore) return;
    const mine = ticket.current;
    setLoadingMore(true);
    client
      .listThreads({ limit: THREAD_PAGE_SIZE, cursor: at.nextCursor })
      .then(
        (outcome) => {
          const now = loaded.current;
          // 途中重抓過：那一份已經是最新的，這一頁丟掉。
          if (mine !== ticket.current || now === undefined || outcome.kind !== 'ok') return;
          const have = new Set(now.pages.map((item) => item.threadId));
          const fresh = outcome.result.items.filter((item) => !have.has(item.threadId));
          const extras = new Map(now.extras);
          for (const item of fresh) extras.delete(item.threadId);
          publish({
            pages: [...now.pages, ...fresh],
            extras,
            nextCursor: outcome.result.nextCursor,
            head: outcome.result,
          });
          dispatch({ type: 'paged', items: fresh });
        },
        () => undefined,
      )
      .finally(() => setLoadingMore(false));
  }, [client, loadingMore, publish]);

  const ensureRows = useCallback((threadIds: readonly string[]) => {
    setRequested((before) => {
      const missing = threadIds.filter((id) => !before.has(id));
      return missing.length === 0 ? before : new Set([...before, ...missing]);
    });
  }, []);

  const findTitles = useCallback(
    async (query: string, signal: AbortSignal) => {
      try {
        const outcome = await client.listThreads({ q: query, limit: THREAD_PAGE_SIZE });
        if (signal.aborted || outcome.kind !== 'ok') return undefined;
        return outcome.result.items;
      } catch {
        return undefined;
      }
    },
    [client],
  );

  // 一定要在清單上的：目前這條、釘選的、有狀態的（在跑、等人回答、跑完沒看），加上呼叫端要的。沒載到的照 id 補。
  const pinned = listing.kind === 'ok' ? listing.result.pinnedThreadIds : undefined;
  const mustHave = useMemo(() => {
    const ids = new Set<string>([currentThreadId, ...requested]);
    for (const id of pinned ?? []) ids.add(id);
    for (const id of status.pushed.pinned ?? []) ids.add(id);
    for (const [id, running] of status.running) if (running) ids.add(id);
    for (const id of status.pending.keys()) ids.add(id);
    for (const id of status.unread) ids.add(id);
    return [...ids].sort();
  }, [currentThreadId, requested, pinned, status]);
  useLayoutEffect(() => {
    wanted.current = mustHave;
  });
  useEffect(() => {
    const at = loaded.current;
    if (listing.kind !== 'ok' || at?.nextCursor === undefined) return;
    const have = new Set([...at.pages.map((item) => item.threadId), ...at.extras.keys()]);
    const missing = mustHave.filter((id) => !have.has(id) && !absent.current.has(id));
    if (missing.length === 0) return;
    for (const id of missing) absent.current.add(id);
    const mine = ticket.current;
    rowsById(client, missing).then(
      (rows) => {
        const now = loaded.current;
        if (mine !== ticket.current || now === undefined || rows.length === 0) return;
        const inPages = new Set(now.pages.map((item) => item.threadId));
        const extras = new Map(now.extras);
        for (const item of rows) if (!inPages.has(item.threadId)) extras.set(item.threadId, item);
        // 補到的不算「沒有」：之後被刪了，重抓時再判。
        for (const item of rows) absent.current.delete(item.threadId);
        publish({ ...now, extras });
        dispatch({ type: 'paged', items: rows });
      },
      () => {
        for (const id of missing) absent.current.delete(id);
      },
    );
  }, [client, listing, mustHave, publish]);

  useEffect(() => {
    dispatch({ type: 'current', threadId: currentThreadId });
  }, [currentThreadId]);

  useEffect(() => {
    const controller = new AbortController();
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = async (): Promise<void> => {
      try {
        const frames = await client.openThreadFeed(controller.signal);
        if (controller.signal.aborted) return;
        attempt = 0;
        // 清空排在補送的第一顆之前：同一個 reducer、同一個佇列，順序就是這裡寫的順序。
        dispatch({ type: 'connected' });
        refresh();
        for await (const frame of frames) {
          if (controller.signal.aborted) return;
          dispatch({ type: 'frame', frame });
        }
      } catch {
        // 開不起來與中途斷掉一樣處理：照退避重接。原因不上畫面——側欄的標記是輔助，對話本身有自己的連線狀態。
      }
      if (controller.signal.aborted) return;
      attempt += 1;
      timer = setTimeout(() => void connect(), reconnectDelay(attempt));
    };
    void connect();
    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client, refresh]);

  const statusOf = useCallback((item: ThreadSummary) => rowStatus(status, item), [status]);
  const blankOf = useCallback((item: ThreadSummary) => effectiveBlank(status, item), [status]);
  const addPlaceholder = useCallback((summary: ThreadSummary) => {
    dispatch({ type: 'placeholder', summary });
  }, []);
  return {
    listing,
    statusOf,
    blankOf,
    refresh,
    loadMore,
    loadingMore,
    ensureRows,
    findTitles,
    placeholders: unlistedRows(status),
    addPlaceholder,
    pushedSets: status.pushed,
    removals: status.removals,
  };
}
