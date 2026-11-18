import type { ThreadListResult, ThreadSummary, WireClient } from '@nexus/wire';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import { reconnectDelay } from '@/shared/connection/reconnect';
import {
  effectiveBlank,
  initialThreadStatus,
  reduceThreadStatus,
  rowStatus,
  unlistedRows,
} from '@/features/threads/status';
import type { RowStatus } from '@/features/threads/status';

/**
 * 以前的會話那份清單，加上每一列的即時狀態（[#632](https://github.com/DemianLi/nexus-agent/issues/632)）。
 *
 * **掛在 `App`，不掛在側欄**：換 thread 會把整個對話畫面連同側欄重掛（`app/App.tsx` 的 `key`），掛在那裡的話每換一條
 * 全域下行就重開一次，「跑完沒看」也跟著歸零。
 *
 * - **全域下行**（`WireClient.openThreadFeed`）：一個分頁一條。斷了照 `shared/connection/reconnect.ts` 的退避重接，不放棄。
 * - **列表**：全域下行**每次接上**（含第一次）重抓一次，當「在跑」的起點——那條線不補送狀態（`THREAD_FEED_PATH`）。
 *   側欄打開時也重抓（`refresh`，#302 的理由：清單會變，會話刪除不走那條線；新增走那條線，見 `features/threads/status.ts`）。**平常只有這兩個時機**：線開不起來又沒打開
 *   側欄，就一次都不抓。另外在動作之後由呼叫端叫 `refresh`：側欄的封存、刪除、復原成功之後，打開的這條被拒說已刪除時，以及打開的這條講過話、清單上卻沒有它時（`app/App.tsx`）。晚送出的那一次回來之後，早送出、晚回來的那一份丟掉。送出前記 `list-requested`，途中的
 *   frame 在回應到了之後重放（#1600，見 `features/threads/status.ts`）。
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

export interface ThreadDirectory {
  readonly listing: Listing;
  readonly statusOf: (item: ThreadSummary) => RowStatus;
  /** 這一列算不算空白：清單說空白、而且沒有人說它在跑過（#1600，`effectiveBlank`）。 */
  readonly blankOf: (item: ThreadSummary) => boolean;
  /** 重抓一次列表。 */
  readonly refresh: () => void;
  /** 清單之外的列：分叉的佔位（#1581）與推來的新增（#2988），各自最新的在前；畫清單時用 `withPlaceholders` 合進 `listing` 的列。 */
  readonly placeholders: readonly ThreadSummary[];
  /** 分叉成功：把子 thread 先放進清單，不等下一次刷新（規則見 `features/threads/status.ts`）。 */
  readonly addPlaceholder: (summary: ThreadSummary) => void;
}

export function useThreadDirectory(client: WireClient, currentThreadId: string): ThreadDirectory {
  const [listing, setListing] = useState<Listing>({ kind: 'loading' });
  const [status, dispatch] = useReducer(reduceThreadStatus, currentThreadId, initialThreadStatus);
  const ticket = useRef(0);

  const refresh = useCallback(() => {
    ticket.current += 1;
    const mine = ticket.current;
    dispatch({ type: 'list-requested' });
    client.listThreads().then(
      (outcome) => {
        if (mine !== ticket.current) return;
        if (outcome.kind === 'ok') {
          setListing({ kind: 'ok', result: outcome.result });
          dispatch({ type: 'listed', items: outcome.result.items });
        } else {
          setListing({
            kind: 'failed',
            message: outcome.message,
            ...(outcome.code === undefined ? {} : { code: outcome.code }),
          });
          dispatch({ type: 'list-failed' });
        }
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
  }, [client]);

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
    placeholders: unlistedRows(status),
    addPlaceholder,
  };
}
