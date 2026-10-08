import type { ThreadListResult, WireClient } from '@nexus/wire';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useThreadManagement } from '@/hooks/use-thread-management';
import type { Listing, ThreadDirectory } from '@/hooks/use-thread-directory';

/** 側欄會話管理的接線（#633）：集合以 server 回的為準、舊回應不蓋新的、列表一來蓋在上面的就作廢。 */

afterEach(cleanup);

const listed = (pinned: string[], archived: string[]): ThreadListResult => ({
  items: [],
  unreadable: 0,
  pinnedThreadIds: pinned,
  archivedThreadIds: archived,
});
const ok = <V,>(value: V) => ({ kind: 'ok' as const, result: { ok: true as const, value } });

/** 一個可以從外面兌現的 promise。 */
function deferred<V>() {
  let resolve!: (value: V) => void;
  const promise = new Promise<V>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(client: Partial<Record<keyof WireClient, unknown>>, first: Listing) {
  const refresh = vi.fn();
  const directory = (listing: Listing): ThreadDirectory => ({
    listing,
    refresh,
    statusOf: () => 'idle' as never,
  });
  const hook = renderHook(
    ({ listing }: { listing: Listing }) =>
      useThreadManagement(client as unknown as WireClient, directory(listing)),
    { initialProps: { listing: first } },
  );
  return { hook, refresh };
}
const okListing = (result: ThreadListResult): Listing => ({ kind: 'ok', result });

describe('支不支援', () => {
  it.each([
    ['列表還在讀', { kind: 'loading' } as Listing],
    ['列表讀失敗', { kind: 'failed', message: '讀不到' } as Listing],
    ['列表沒帶集合', okListing({ items: [], unreadable: 0 })],
  ])('%s：回 undefined', (_case, listing) => {
    const { hook } = setup({}, listing);
    expect(hook.result.current).toBeUndefined();
  });

  it('列表帶了兩個集合：照列表給，封存換成 Set', () => {
    const { hook } = setup({}, okListing(listed(['b', 'a'], ['c'])));
    expect(hook.result.current?.pinnedIds).toEqual(['b', 'a']);
    expect([...hook.result.current!.archivedIds]).toEqual(['c']);
    expect(hook.result.current?.titles.size).toBe(0);
  });
});

describe('動作成功', () => {
  it('釘選：整份集合取代列表上的；封存同理，且不碰釘選集合', async () => {
    const client = {
      threadPin: vi.fn(async () => ok({ pinnedThreadIds: ['x', 'a'] })),
      threadArchive: vi.fn(async () => ok({ archivedThreadIds: ['c', 'd'] })),
    };
    const { hook, refresh } = setup(client, okListing(listed(['a'], ['c'])));
    await act(async () => {
      expect(await hook.result.current!.onPin('x')).toBeUndefined();
    });
    expect(hook.result.current?.pinnedIds).toEqual(['x', 'a']);
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => {
      expect(await hook.result.current!.onArchive('d')).toBeUndefined();
    });
    expect([...hook.result.current!.archivedIds]).toEqual(['c', 'd']);
    // 本機不推：回應沒帶釘選集合，釘選維持上一份；封存之後重抓列表去拿 server 的。
    expect(hook.result.current?.pinnedIds).toEqual(['x', 'a']);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('取消釘選與取消封存也是整份取代，而且不重抓', async () => {
    const client = {
      threadUnpin: vi.fn(async () => ok({ pinnedThreadIds: [] })),
      threadUnarchive: vi.fn(async () => ok({ archivedThreadIds: [] })),
    };
    const { hook, refresh } = setup(client, okListing(listed(['a'], ['c'])));
    await act(async () => {
      await hook.result.current!.onUnpin('a');
      await hook.result.current!.onUnarchive('c');
    });
    expect(hook.result.current?.pinnedIds).toEqual([]);
    expect(hook.result.current?.archivedIds.size).toBe(0);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('新一份列表來了，蓋在上面的整份作廢：以列表為準', async () => {
    const client = { threadPin: vi.fn(async () => ok({ pinnedThreadIds: ['x'] })) };
    const { hook } = setup(client, okListing(listed([], [])));
    await act(async () => {
      await hook.result.current!.onPin('x');
    });
    expect(hook.result.current?.pinnedIds).toEqual(['x']);
    hook.rerender({ listing: okListing(listed(['別的分頁釘的'], [])) });
    expect(hook.result.current?.pinnedIds).toEqual(['別的分頁釘的']);
  });

  it('列表沒換的重畫不丟掉蓋在上面的', async () => {
    const client = { threadPin: vi.fn(async () => ok({ pinnedThreadIds: ['x'] })) };
    const listing = okListing(listed([], []));
    const { hook } = setup(client, listing);
    await act(async () => {
      await hook.result.current!.onPin('x');
    });
    hook.rerender({ listing });
    expect(hook.result.current?.pinnedIds).toEqual(['x']);
  });
});

describe('回得慢的舊回應不蓋新的', () => {
  it('釘選集合：先送的後回來，不蓋掉後送的結果', async () => {
    const slow = deferred<ReturnType<typeof ok>>();
    const client = {
      threadPin: vi
        .fn()
        .mockReturnValueOnce(slow.promise)
        .mockResolvedValueOnce(ok({ pinnedThreadIds: ['b', 'a'] })),
    };
    const { hook } = setup(client, okListing(listed([], [])));
    let first!: Promise<string | undefined>;
    act(() => {
      first = hook.result.current!.onPin('a');
    });
    await act(async () => {
      await hook.result.current!.onPin('b');
    });
    expect(hook.result.current?.pinnedIds).toEqual(['b', 'a']);
    await act(async () => {
      slow.resolve(ok({ pinnedThreadIds: ['a'] }));
      await first;
    });
    expect(hook.result.current?.pinnedIds).toEqual(['b', 'a']);
  });

  it('封存集合：同理', async () => {
    const slow = deferred<ReturnType<typeof ok>>();
    const client = {
      threadArchive: vi
        .fn()
        .mockReturnValueOnce(slow.promise)
        .mockResolvedValueOnce(ok({ archivedThreadIds: ['a', 'b'] })),
    };
    const { hook } = setup(client, okListing(listed([], [])));
    let first!: Promise<string | undefined>;
    act(() => {
      first = hook.result.current!.onArchive('a');
    });
    await act(async () => {
      await hook.result.current!.onArchive('b');
    });
    await act(async () => {
      slow.resolve(ok({ archivedThreadIds: ['a'] }));
      await first;
    });
    expect([...hook.result.current!.archivedIds]).toEqual(['a', 'b']);
  });

  it('釘選與封存是兩個集合，各算各的：封存的回應不擋釘選的', async () => {
    const slowPin = deferred<ReturnType<typeof ok>>();
    const client = {
      threadPin: vi.fn().mockReturnValueOnce(slowPin.promise),
      threadArchive: vi.fn(async () => ok({ archivedThreadIds: ['z'] })),
    };
    const { hook } = setup(client, okListing(listed([], [])));
    let pinning!: Promise<string | undefined>;
    act(() => {
      pinning = hook.result.current!.onPin('a');
    });
    await act(async () => {
      await hook.result.current!.onArchive('z');
    });
    await act(async () => {
      slowPin.resolve(ok({ pinnedThreadIds: ['a'] }));
      await pinning;
    });
    expect(hook.result.current?.pinnedIds).toEqual(['a']);
  });
});

describe('改名', () => {
  it('送出正規化後的標題，先用 server 受理的標題頂著並重抓列表；列表來了就換成列表上的', async () => {
    const client = { threadRename: vi.fn(async () => ok({ title: '受理後的', seq: 3 })) };
    const { hook, refresh } = setup(client, okListing(listed([], [])));
    await act(async () => {
      expect(await hook.result.current!.onRename('t1', '  登入頁   重做 ')).toBeUndefined();
    });
    expect(client.threadRename).toHaveBeenCalledWith('t1', '登入頁 重做');
    expect(hook.result.current?.titles.get('t1')).toBe('受理後的');
    expect(refresh).toHaveBeenCalledTimes(1);
    hook.rerender({ listing: okListing(listed([], [])) });
    expect(hook.result.current?.titles.size).toBe(0);
  });

  it('空標題在本機就擋下，不打 server', async () => {
    const client = { threadRename: vi.fn() };
    const { hook, refresh } = setup(client, okListing(listed([], [])));
    await act(async () => {
      expect(await hook.result.current!.onRename('t1', '   ')).toBe('標題不能是空的。');
    });
    expect(client.threadRename).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('被拒：說出原因，不改標題也不重抓', async () => {
    const client = {
      threadRename: vi.fn(async () => ({
        kind: 'ok' as const,
        result: { ok: false as const, error: { code: 'title_invalid', message: '太長了' } },
      })),
    };
    const { hook, refresh } = setup(client, okListing(listed([], [])));
    await act(async () => {
      expect(await hook.result.current!.onRename('t1', '標題')).toBe('太長了');
    });
    expect(hook.result.current?.titles.size).toBe(0);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('失敗', () => {
  it('這條線收不了：not_supported 說還不支援，別的碼用 server 的訊息；拋錯用錯誤訊息；集合不變', async () => {
    const client = {
      threadPin: vi
        .fn()
        .mockResolvedValueOnce({ kind: 'rejected', code: 'not_supported', message: '沒接' })
        .mockResolvedValueOnce({ kind: 'rejected', code: 'internal', message: '壞了' })
        .mockRejectedValueOnce(new Error('斷線')),
    };
    const { hook } = setup(client, okListing(listed(['a'], [])));
    await act(async () => {
      expect(await hook.result.current!.onPin('x')).toBe('這個伺服器還不支援這個動作。');
      expect(await hook.result.current!.onPin('x')).toBe('壞了');
      expect(await hook.result.current!.onPin('x')).toBe('斷線');
    });
    expect(hook.result.current?.pinnedIds).toEqual(['a']);
  });

  it('封存失敗不重抓、集合不變', async () => {
    const client = {
      threadArchive: vi.fn(async () => ({
        kind: 'ok' as const,
        result: { ok: false as const, error: { code: 'thread_active' } },
      })),
    };
    const { hook, refresh } = setup(client, okListing(listed([], [])));
    await act(async () => {
      expect(await hook.result.current!.onArchive('t')).toContain('還在跑');
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(hook.result.current?.archivedIds.size).toBe(0);
  });
});
