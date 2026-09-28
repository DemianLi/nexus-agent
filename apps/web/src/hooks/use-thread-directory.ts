import type { ThreadListResult, ThreadSummary, WireClient } from '@nexus/wire';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import { reconnectDelay } from '@/lib/reconnect';
import { initialThreadStatus, reduceThreadStatus, rowStatus } from '@/lib/thread-status';
import type { RowStatus } from '@/lib/thread-status';

/**
 * 以前的會話那份清單，加上每一列的即時狀態（[#632](https://github.com/DemianLi/nexus-agent/issues/632)）。
 *
 * **掛在 `App`，不掛在側欄**：換 thread 會把整個對話畫面連同側欄重掛（`App.tsx` 的 `key`），掛在那裡的話每換一條
 * 全域下行就重開一次，「跑完沒看」也跟著歸零。
 *
 * - **全域下行**（`WireClient.openThreadFeed`）：一個分頁一條。斷了照 `lib/reconnect.ts` 的退避重接，不放棄。
 * - **列表**：全域下行**每次接上**（含第一次）重抓一次，當「在跑」的起點——那條線不補送狀態（`THREAD_FEED_PATH`）。
 *   側欄打開時也重抓（`refresh`，#302 的理由：清單會變，會話增減不走那條線）。**只有這兩個時機**：線開不起來又沒打開
 *   側欄，就一次都不抓。晚送出的那一次回來之後，早送出、晚回來的那一份丟掉。
 *
 * @module
 */

export type Listing =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ok'; readonly result: ThreadListResult }
  | { readonly kind: 'failed'; readonly message: string };

export interface ThreadDirectory {
  readonly listing: Listing;
  readonly statusOf: (item: ThreadSummary) => RowStatus;
  /** 重抓一次列表。 */
  readonly refresh: () => void;
}

export function useThreadDirectory(client: WireClient, currentThreadId: string): ThreadDirectory {
  const [listing, setListing] = useState<Listing>({ kind: 'loading' });
  const [status, dispatch] = useReducer(reduceThreadStatus, currentThreadId, initialThreadStatus);
  const ticket = useRef(0);

  const refresh = useCallback(() => {
    ticket.current += 1;
    const mine = ticket.current;
    client.listThreads().then(
      (outcome) => {
        if (mine !== ticket.current) return;
        if (outcome.kind === 'ok') {
          setListing({ kind: 'ok', result: outcome.result });
          dispatch({ type: 'listed', items: outcome.result.items });
        } else {
          setListing({ kind: 'failed', message: outcome.message });
        }
      },
      (error: unknown) => {
        if (mine !== ticket.current) return;
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
  return { listing, statusOf, refresh };
}
