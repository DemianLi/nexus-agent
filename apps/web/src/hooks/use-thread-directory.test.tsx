import type { ThreadListOutcome, WireClient } from '@nexus/wire';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useThreadDirectory } from '@/hooks/use-thread-directory';
import type { ThreadStatusAction, ThreadStatusState } from '@/lib/thread-status';

/**
 * 清單刷新的接線（#1600 `N1362`）：送出前記 `list-requested`，失敗時記 `list-failed` 把紀錄清掉。
 * 紀錄沒清的後果是一路長到下一次成功的刷新，重放結果相同、畫面看不出來，所以這裡直接看 reducer 收到什麼、留下什麼。
 */

const seen = vi.hoisted(() => ({
  actions: [] as ThreadStatusAction[],
  last: undefined as ThreadStatusState | undefined,
}));

vi.mock('@/lib/thread-status', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/thread-status')>();
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
