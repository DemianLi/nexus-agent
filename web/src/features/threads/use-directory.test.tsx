import type { ThreadListOutcome, ThreadListQuery, ThreadSummary, WireClient } from '@nexus/wire';
import { pageThreadList } from '@nexus/wire';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useThreadDirectory } from '@/features/threads/use-directory';
import type { Listing } from '@/features/threads/use-directory';
import type { ThreadStatusAction, ThreadStatusState } from '@/features/threads/status';

/**
 * 清單刷新的接線（#1600 `N1362`）：送出前記 `list-requested`，失敗時記 `list-failed` 把紀錄清掉。
 * 紀錄沒清的後果是一路長到下一次成功的刷新，重放結果相同、畫面看不出來，所以這裡直接看 reducer 收到什麼、留下什麼。
 */

const seen = vi.hoisted(() => ({
  actions: [] as ThreadStatusAction[],
  last: undefined as ThreadStatusState | undefined,
}));

vi.mock('@/features/threads/status', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/features/threads/status')>();
  return {
    ...original,
    reduceThreadStatus: (state: ThreadStatusState, action: ThreadStatusAction) => {
      seen.actions.push(action);
      seen.last = original.reduceThreadStatus(state, action);
      return seen.last;
    },
  };
});

afterEach(() => {
  cleanup();
  seen.actions = [];
  seen.last = undefined;
});

/** 全域下行一直不開：只剩手動的 `refresh`。 */
function client(listThreads: WireClient['listThreads']): WireClient {
  return {
    listThreads,
    openThreadFeed: () => new Promise<never>(() => undefined),
  } as unknown as WireClient;
}

const types = () => seen.actions.map((action) => action.type);

describe('清單刷新失敗時清掉紀錄（#1600）', () => {
  it.each([
    [
      '伺服器回 rejected',
      async (): Promise<ThreadListOutcome> => ({ kind: 'rejected', message: '關掉落盤' }),
    ],
    [
      '請求本身拋錯',
      async (): Promise<ThreadListOutcome> => {
        throw new Error('network error');
      },
    ],
  ])('%s：記 list-requested、再記 list-failed，紀錄是空的', async (_case, listThreads) => {
    const hook = renderHook(() => useThreadDirectory(client(listThreads), '目前'));

    act(() => hook.result.current.refresh());

    await waitFor(() => expect(hook.result.current.listing.kind).toBe('failed'));
    expect(types()).toContain('list-requested');
    expect(types().indexOf('list-failed')).toBeGreaterThan(types().indexOf('list-requested'));
    expect(seen.last?.mutations).toBeUndefined();
  });
});

describe('一次一頁（#725）', () => {
  const NOW = 1_000_000;
  const rows: ThreadSummary[] = Array.from({ length: 120 }, (_, index) => ({
    threadId: `t${String(index + 1).padStart(3, '0')}`,
    updatedAt: NOW - index,
    running: false,
    blank: false,
  }));

  /** 照真的 server 切：同一個 `pageThreadList`。記下每一次的查詢。 */
  function pagedClient(queries: (ThreadListQuery | undefined)[]): WireClient {
    return client(async (query) => {
      queries.push(query);
      return {
        kind: 'ok',
        result: { ...pageThreadList(rows, query ?? {}, new Set()), unreadable: 0 },
      };
    });
  }
  const ids = (listing: Listing) =>
    listing.kind === 'ok' ? listing.result.items.map((item) => item.threadId) : [];

  it('先 50 條；loadMore 再 50 條；重抓載回 100 條；最後一頁沒有游標', async () => {
    const queries: (ThreadListQuery | undefined)[] = [];
    const hook = renderHook(() => useThreadDirectory(pagedClient(queries), 't001'));
    act(() => hook.result.current.refresh());
    await waitFor(() => expect(ids(hook.result.current.listing)).toHaveLength(50));
    expect(queries[0]).toEqual({ limit: 50 });
    // 還有下一頁：列表回來不當成整份，沒列到的狀態不清。
    expect(seen.actions.find((action) => action.type === 'listed')).toMatchObject({
      complete: false,
    });

    act(() => hook.result.current.loadMore());
    await waitFor(() => expect(ids(hook.result.current.listing)).toHaveLength(100));
    expect(ids(hook.result.current.listing)).toEqual(rows.slice(0, 100).map((r) => r.threadId));

    act(() => hook.result.current.refresh());
    await waitFor(() => expect(queries.filter((q) => q?.limit === 50)).toHaveLength(4));
    await waitFor(() => expect(ids(hook.result.current.listing)).toHaveLength(100));

    act(() => hook.result.current.loadMore());
    await waitFor(() => expect(ids(hook.result.current.listing)).toHaveLength(120));
    act(() => hook.result.current.refresh());
    await waitFor(() =>
      expect(seen.actions.filter((action) => action.type === 'listed').at(-1)).toMatchObject({
        complete: true,
      }),
    );
    const last = hook.result.current.listing;
    expect(last.kind === 'ok' && 'nextCursor' in last.result).toBe(false);
  });

  it('一定要在的沒載到就照 id 補：目前這條、呼叫端要的；不存在的只問一次', async () => {
    const queries: (ThreadListQuery | undefined)[] = [];
    const hook = renderHook(() => useThreadDirectory(pagedClient(queries), 't080'));
    act(() => hook.result.current.refresh());
    await waitFor(() => expect(ids(hook.result.current.listing)).toContain('t080'));
    expect(ids(hook.result.current.listing)).toHaveLength(51);

    act(() => hook.result.current.ensureRows(['t110', 'nope']));
    await waitFor(() => expect(ids(hook.result.current.listing)).toContain('t110'));
    // 照列表順序合進去：t080 在 t110 前面，兩條都在第 50 條之後。
    expect(ids(hook.result.current.listing).slice(50)).toEqual(['t080', 't110']);
    act(() => hook.result.current.ensureRows(['nope']));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(queries.filter((q) => q?.ids?.includes('nope'))).toHaveLength(1);

    // 補過的那一條之後被翻到：不重複。
    act(() => hook.result.current.loadMore());
    await waitFor(() => expect(ids(hook.result.current.listing)).toHaveLength(101));
    expect(new Set(ids(hook.result.current.listing)).size).toBe(101);
  });
});
