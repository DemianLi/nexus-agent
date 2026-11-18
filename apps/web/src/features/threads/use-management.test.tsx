import type { ThreadListResult, WireClient } from '@nexus/wire';
import {
  THREAD_AT_CAPACITY,
  THREAD_HISTORY_TOO_DEEP,
  THREAD_LOG_BUSY,
  THREAD_LOG_TOO_LARGE,
  THREAD_ROOT_MISMATCH,
  THREAD_WRITER_HELD,
} from '@nexus/wire';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAcceptedTitles, useThreadManagement } from '@/features/threads/use-management';
import type { Listing, ThreadDirectory } from '@/features/threads/use-directory';
import {
  THREAD_AT_CAPACITY_TEXT,
  THREAD_HISTORY_TOO_DEEP_TEXT,
  THREAD_LOG_BUSY_TEXT,
  THREAD_LOG_TOO_LARGE_TEXT,
  THREAD_ROOT_MISMATCH_TEXT,
  THREAD_WRITER_HELD_TEXT,
} from '@/shared/connection/refusal-text';

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

/** 一次重畫給 directory 的：列表，加上全域下行推來的集合與刪除數（#2990）。 */
interface Props {
  readonly listing: Listing;
  readonly pushedSets?: ThreadDirectory['pushedSets'];
  readonly removals?: number;
}
const NOTHING_PUSHED: ThreadDirectory['pushedSets'] = {};

function setup(client: Partial<Record<keyof WireClient, unknown>>, first: Listing) {
  const refresh = vi.fn();
  const directory = ({
    listing,
    pushedSets = NOTHING_PUSHED,
    removals = 0,
  }: Props): ThreadDirectory => ({
    listing,
    refresh,
    statusOf: () => 'idle' as never,
    blankOf: (item) => item.blank,
    placeholders: [],
    addPlaceholder: () => {},
    pushedSets,
    removals,
  });
  const hook = renderHook(
    (props: Props) =>
      useThreadManagement(client as unknown as WireClient, directory(props), useAcceptedTitles()),
    { initialProps: { listing: first } as Props },
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
    let first!: ReturnType<NonNullable<typeof hook.result.current>['onArchive']>;
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
  it('送出正規化後的標題，用 server 受理的標題頂著、不重抓列表（落盤是非同步的，重抓回來是舊標題）', async () => {
    const client = { threadRename: vi.fn(async () => ok({ title: '受理後的', seq: 3 })) };
    const { hook, refresh } = setup(client, okListing(listed([], [])));
    await act(async () => {
      expect(await hook.result.current!.onRename('t1', '  登入頁   重做 ')).toBeUndefined();
    });
    expect(client.threadRename).toHaveBeenCalledWith('t1', '登入頁 重做');
    expect(hook.result.current?.titles.get('t1')).toBe('受理後的');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('落盤前來的列表還是舊標題：頂著的標題不被蓋回去；列表追上之後才放手', async () => {
    const client = { threadRename: vi.fn(async () => ok({ title: '新標題', seq: 3 })) };
    const stale = (title: string) =>
      okListing({
        ...listed([], []),
        items: [{ threadId: 't1', updatedAt: 1, running: false, blank: false, title }],
      });
    const { hook } = setup(client, stale('舊標題'));
    await act(async () => {
      await hook.result.current!.onRename('t1', '新標題');
    });
    hook.rerender({ listing: stale('舊標題') });
    expect(hook.result.current?.titles.get('t1')).toBe('新標題');
    hook.rerender({ listing: stale('新標題') });
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

  it('thread 數滿了（#1483，冷會話改名經 `threadFor`）：講給使用者看的那一句，不接 server 的原文', async () => {
    const client = {
      threadRename: vi.fn(async () => ({
        kind: 'rejected' as const,
        code: THREAD_AT_CAPACITY,
        message: 'thread 數已到上限 1／1；重啟 serve 才會釋放',
      })),
    };
    const { hook } = setup(client, okListing(listed([], [])));
    await act(async () => {
      expect(await hook.result.current!.onRename('t1', '標題')).toBe(THREAD_AT_CAPACITY_TEXT);
    });
    expect(hook.result.current?.titles.size).toBe(0);
  });

  it('歷史太深（#1753，冷會話改名經 `threadFor`）：講給使用者看的那一句，不接 server 的原文', async () => {
    const client = {
      threadRename: vi.fn(async () => ({
        kind: 'rejected' as const,
        code: THREAD_HISTORY_TOO_DEEP,
        message: '這條 thread 建不起來：日誌第 3 顆事件巢狀 3000 層，超過上限 600',
      })),
    };
    const { hook } = setup(client, okListing(listed([], [])));
    await act(async () => {
      expect(await hook.result.current!.onRename('t1', '標題')).toBe(THREAD_HISTORY_TOO_DEEP_TEXT);
    });
    expect(hook.result.current?.titles.size).toBe(0);
  });
});

describe('日誌超過額度與開在別的 home（#2203、#2222，冷會話改名經 `threadFor`）', () => {
  it.each([
    [THREAD_LOG_TOO_LARGE, THREAD_LOG_TOO_LARGE_TEXT],
    [THREAD_LOG_BUSY, THREAD_LOG_BUSY_TEXT],
    [THREAD_ROOT_MISMATCH, THREAD_ROOT_MISMATCH_TEXT],
  ])('%s：講給使用者看的那一句，不接 server 的原文', async (code, text) => {
    const client = {
      threadRename: vi.fn(async () => ({
        kind: 'rejected' as const,
        code,
        message: '會話日誌 115 MiB 超過額度 109 MiB',
      })),
    };
    const { hook } = setup(client, okListing(listed([], [])));
    await act(async () => {
      expect(await hook.result.current!.onRename('t1', '標題')).toBe(text);
    });
    expect(hook.result.current?.titles.size).toBe(0);
  });
});

describe('被別的寫入者握著（#2214，冷會話改名經 `threadFor`）', () => {
  it('講給使用者看的那一句，不接 server 的原文', async () => {
    const client = {
      threadRename: vi.fn(async () => ({
        kind: 'rejected' as const,
        code: THREAD_WRITER_HELD,
        message: '會話 "t1" 正由另一個寫入者握著',
      })),
    };
    const { hook } = setup(client, okListing(listed([], [])));
    await act(async () => {
      expect(await hook.result.current!.onRename('t1', '標題')).toBe(THREAD_WRITER_HELD_TEXT);
    });
    expect(hook.result.current?.titles.size).toBe(0);
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

  it.each([
    ['帶活動', { code: 'thread_active', activity: ['turn', 'subagent'] }, ['turn', 'subagent']],
    ['舊 server 沒帶活動', { code: 'thread_active' }, []],
  ])(
    '封存還在跑的：%s，回「要先問」而不是錯誤文字；不重抓、集合不變',
    async (_case, error, activity) => {
      const client = {
        threadArchive: vi.fn(async () => ({
          kind: 'ok' as const,
          result: { ok: false as const, error },
        })),
      };
      const { hook, refresh } = setup(client, okListing(listed([], [])));
      await act(async () => {
        expect(await hook.result.current!.onArchive('t')).toEqual({ needsStop: activity });
      });
      expect(refresh).not.toHaveBeenCalled();
      expect(hook.result.current?.archivedIds.size).toBe(0);
    },
  );

  it('封存帶 stopActivity：原樣交給 client，成功就更新集合並重抓', async () => {
    const client = { threadArchive: vi.fn(async () => ok({ archivedThreadIds: ['t'] })) };
    const { hook, refresh } = setup(client, okListing(listed([], [])));
    await act(async () => {
      expect(await hook.result.current!.onArchive('t', { stopActivity: true })).toBeUndefined();
    });
    expect(client.threadArchive).toHaveBeenCalledWith('t', { stopActivity: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect([...hook.result.current!.archivedIds]).toEqual(['t']);
  });

  it('沒要停掉時不帶 options（舊 server 看得懂的原樣）', async () => {
    const client = { threadArchive: vi.fn(async () => ok({ archivedThreadIds: ['t'] })) };
    const { hook } = setup(client, okListing(listed([], [])));
    await act(async () => {
      await hook.result.current!.onArchive('t');
    });
    expect(client.threadArchive).toHaveBeenCalledWith('t', undefined);
  });
});

describe('刪除與最近刪除（#2958）', () => {
  const DELETED = {
    threadId: 'x',
    title: '舊的',
    deletedAt: 1,
    expiresAt: Date.now() + 86_400_000,
  };
  const deletedList = (items: readonly unknown[]) => ({ kind: 'ok' as const, result: { items } });
  const failed = (code: string) => ({
    kind: 'ok' as const,
    result: { ok: false as const, error: { code } },
  });

  it.each([
    [
      '回 rejected（沒接已刪除存放區）',
      async () => ({ kind: 'rejected', code: 'not_supported', message: '沒接' }),
    ],
    ['拋錯', async () => Promise.reject(new Error('斷線'))],
  ])('已刪除清單%s：沒有刪除這一項', async (_case, deletedThreads) => {
    const { hook } = setup({ deletedThreads }, okListing(listed([], [])));
    await act(async () => undefined);
    expect(hook.result.current).toBeDefined();
    expect(hook.result.current?.deletion).toBeUndefined();
  });

  it('接了：掛上時讀一次已刪除清單；列表來了新的一份就跟著重讀（別的頁籤刪的、復原的才看得到）', async () => {
    let items: unknown[] = [];
    const deletedThreads = vi.fn(async () => deletedList(items));
    const { hook } = setup({ deletedThreads }, okListing(listed([], [])));
    await waitFor(() => expect(hook.result.current?.deletion?.deleted).toEqual([]));
    items = [DELETED];
    hook.rerender({ listing: okListing(listed(['a'], [])) });
    await waitFor(() => expect(hook.result.current?.deletion?.deleted).toEqual([DELETED]));
    expect(deletedThreads).toHaveBeenCalledTimes(2);
  });

  it('掛上時讀不到：列表下一份來時再讀，讀到了刪除就回來', async () => {
    let fail = true;
    const deletedThreads = vi.fn(async () =>
      fail ? Promise.reject(new Error('斷線')) : deletedList([]),
    );
    const { hook } = setup({ deletedThreads }, okListing(listed([], [])));
    await act(async () => undefined);
    expect(hook.result.current?.deletion).toBeUndefined();
    fail = false;
    hook.rerender({ listing: okListing(listed(['a'], [])) });
    await waitFor(() => expect(hook.result.current?.deletion?.deleted).toEqual([]));
  });

  it('刪除成功：重抓列表、重讀已刪除清單', async () => {
    let items: unknown[] = [];
    const deletedThreads = vi.fn(async () => deletedList(items));
    const threadDelete = vi.fn(async () => {
      items = [DELETED];
      return { kind: 'ok' as const, result: { ok: true as const, value: { threadId: 'x' } } };
    });
    const { hook, refresh } = setup({ deletedThreads, threadDelete }, okListing(listed([], [])));
    await waitFor(() => expect(hook.result.current?.deletion?.deleted).toEqual([]));
    await act(async () => {
      expect(await hook.result.current!.deletion!.onDelete('x')).toBeUndefined();
    });
    expect(threadDelete).toHaveBeenCalledWith('x');
    expect(refresh).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(hook.result.current?.deletion?.deleted).toEqual([DELETED]));
  });

  it('刪除失敗：講原因，不重抓', async () => {
    const deletedThreads = vi.fn(async () => deletedList([]));
    const threadDelete = vi.fn(async () => failed('thread_busy'));
    const { hook, refresh } = setup({ deletedThreads, threadDelete }, okListing(listed([], [])));
    await waitFor(() => expect(hook.result.current?.deletion).toBeDefined());
    await act(async () => {
      expect(await hook.result.current!.deletion!.onDelete('x')).toBe(
        '這條會話另一件事還沒做完，稍後再試。',
      );
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(deletedThreads).toHaveBeenCalledTimes(1);
  });

  it('復原成功：重抓列表、重讀已刪除清單', async () => {
    let items: unknown[] = [DELETED];
    const deletedThreads = vi.fn(async () => deletedList(items));
    const threadRestore = vi.fn(async () => {
      items = [];
      return { kind: 'ok' as const, result: { ok: true as const, value: { threadId: 'x' } } };
    });
    const { hook, refresh } = setup({ deletedThreads, threadRestore }, okListing(listed([], [])));
    await waitFor(() => expect(hook.result.current?.deletion?.deleted).toEqual([DELETED]));
    await act(async () => {
      expect(await hook.result.current!.deletion!.onRestore('x')).toBeUndefined();
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(hook.result.current?.deletion?.deleted).toEqual([]));
  });

  it('復原失敗（已經復原過）：講原因，並重讀已刪除清單讓那一列消失', async () => {
    let items: unknown[] = [DELETED];
    const deletedThreads = vi.fn(async () => deletedList(items));
    const threadRestore = vi.fn(async () => {
      items = [];
      return failed('thread_not_deleted');
    });
    const { hook, refresh } = setup({ deletedThreads, threadRestore }, okListing(listed([], [])));
    await waitFor(() => expect(hook.result.current?.deletion?.deleted).toEqual([DELETED]));
    await act(async () => {
      expect(await hook.result.current!.deletion!.onRestore('x')).toBeTypeOf('string');
    });
    expect(refresh).not.toHaveBeenCalled();
    await waitFor(() => expect(hook.result.current?.deletion?.deleted).toEqual([]));
  });

  it('復原時已經過期：講原因；server 的清單照樣帶著它，過期的由側欄用 expiresAt 濾掉', async () => {
    const deletedThreads = vi.fn(async () => deletedList([DELETED]));
    const threadRestore = vi.fn(async () => failed('restore_expired'));
    const { hook } = setup({ deletedThreads, threadRestore }, okListing(listed([], [])));
    await waitFor(() => expect(hook.result.current?.deletion?.deleted).toEqual([DELETED]));
    await act(async () => {
      expect(await hook.result.current!.deletion!.onRestore('x')).toBe(
        '已經過了寬限期，不能復原。',
      );
    });
    expect(deletedThreads).toHaveBeenCalledTimes(2);
  });
});

describe('全域下行推來的（#2990）', () => {
  it('推來的集合蓋過列表上的；誰後到聽誰：自己的回應與推來的互相蓋', async () => {
    const client = { threadPin: vi.fn(async () => ok({ pinnedThreadIds: ['自己釘的'] })) };
    const listing = okListing(listed(['a'], ['c']));
    const { hook } = setup(client, listing);
    hook.rerender({ listing, pushedSets: { pinned: ['b'], archived: ['c', 'd'] } });
    expect(hook.result.current?.pinnedIds).toEqual(['b']);
    expect([...hook.result.current!.archivedIds]).toEqual(['c', 'd']);

    await act(async () => {
      await hook.result.current!.onPin('自己釘的');
    });
    expect(hook.result.current?.pinnedIds).toEqual(['自己釘的']);
    hook.rerender({ listing, pushedSets: { pinned: ['別的分頁釘的'], archived: ['c', 'd'] } });
    expect(hook.result.current?.pinnedIds).toEqual(['別的分頁釘的']);
  });

  it('推來一顆刪除就重讀已刪除清單', async () => {
    const deletedThreads = vi.fn(async () => ({ kind: 'ok' as const, result: { items: [] } }));
    const listing = okListing(listed([], []));
    const { hook } = setup({ deletedThreads }, listing);
    await waitFor(() => expect(deletedThreads).toHaveBeenCalledTimes(1));
    hook.rerender({ listing, removals: 1 });
    await waitFor(() => expect(deletedThreads).toHaveBeenCalledTimes(2));
  });
});
