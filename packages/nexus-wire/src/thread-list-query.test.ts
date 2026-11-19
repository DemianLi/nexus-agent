import { describe, expect, it } from 'vitest';

import type { ThreadSummary } from './protocol.js';
import {
  THREAD_LIST_PAGE_MAX,
  pageThreadList,
  parseThreadListQuery,
  threadListSearch,
} from './thread-list-query.js';
import type { ThreadListQuery } from './thread-list-query.js';

function row(threadId: string, updatedAt: number, title?: string): ThreadSummary {
  return { threadId, updatedAt, running: false, blank: false, ...(title && { title }) };
}

/** 照列表的順序排：新到舊，一樣時照 id。 */
function sorted(items: ThreadSummary[]): ThreadSummary[] {
  return items.sort(
    (a, b) =>
      b.updatedAt - a.updatedAt || (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0),
  );
}

function roundTrip(query: ThreadListQuery) {
  return parseThreadListQuery(new URLSearchParams(threadListSearch(query)));
}

describe('會話列表的查詢參數', () => {
  it('組出來的讀回去一樣；沒有參數是空字串', () => {
    expect(threadListSearch(undefined)).toBe('');
    expect(threadListSearch({})).toBe('');
    for (const query of [
      { limit: 50 },
      { limit: 1, cursor: '1000:a:b', q: ' 標題 ', archived: 'only' as const },
      { archived: 'exclude' as const },
      { ids: ['a', 'b,c', '中文'] },
    ]) {
      expect(roundTrip(query)).toEqual({ ok: true, query });
    }
  });

  it('不合法的講清楚', () => {
    const bad = (text: string) => {
      const parsed = parseThreadListQuery(new URLSearchParams(text));
      expect(parsed.ok, text).toBe(false);
    };
    bad('limit=0');
    bad(`limit=${THREAD_LIST_PAGE_MAX + 1}`);
    bad('limit=1.5');
    bad('limit=abc');
    bad('cursor=沒有冒號');
    bad('cursor=x:a');
    bad('cursor=1:');
    bad('archived=yes');
    bad('id=a&limit=2');
  });
});

describe('server 照查詢切一刀', () => {
  const items = sorted([
    row('a', 5, '第一條'),
    row('b', 4, '第二條'),
    row('c', 4, '第三條'),
    row('d', 2, 'Hello World'),
    row('e', 1),
  ]);

  it('一頁一頁翻到底：接起來就是整份，最後一頁沒有游標', () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = pageThreadList(items, { limit: 2, ...(cursor && { cursor }) }, new Set());
      seen.push(...page.items.map(({ threadId }) => threadId));
      if (page.nextCursor === undefined) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('翻頁之間有一條跳到最前面：後面的不重複也不漏', () => {
    const first = pageThreadList(items, { limit: 2 }, new Set());
    expect(first.items.map(({ threadId }) => threadId)).toEqual(['a', 'b']);
    // d 講了話：updatedAt 變成最新。照位置切的話，第二頁會從 c 之後少一條。
    const moved = sorted(items.map((item) => (item.threadId === 'd' ? row('d', 9) : item)));
    const second = pageThreadList(moved, { limit: 2, cursor: first.nextCursor! }, new Set());
    expect(second.items.map(({ threadId }) => threadId)).toEqual(['c', 'e']);
    expect(second.nextCursor).toBeUndefined();
  });

  it('游標指的那一條不見了：照位置接下去', () => {
    const first = pageThreadList(items, { limit: 2 }, new Set());
    const without = items.filter(({ threadId }) => threadId !== 'b');
    expect(
      pageThreadList(without, { cursor: first.nextCursor! }, new Set()).items.map(
        ({ threadId }) => threadId,
      ),
    ).toEqual(['c', 'd', 'e']);
  });

  it('只比標題：不分大小寫、去頭尾空白，沒標題的不列；跟分頁一起用', () => {
    expect(pageThreadList(items, { q: '  hello ' }, new Set()).items).toEqual([items[3]]);
    const page = pageThreadList(items, { q: '條', limit: 2 }, new Set());
    expect(page.items.map(({ threadId }) => threadId)).toEqual(['a', 'b']);
    expect(
      pageThreadList(items, { q: '條', cursor: page.nextCursor! }, new Set()).items.map(
        ({ threadId }) => threadId,
      ),
    ).toEqual(['c']);
    expect(pageThreadList(items, { q: '   ' }, new Set()).items).toHaveLength(5);
  });

  it('封存：exclude 不列、only 只列', () => {
    const archived = new Set(['b', 'd']);
    const ids = (query: ThreadListQuery) =>
      pageThreadList(items, query, archived).items.map(({ threadId }) => threadId);
    expect(ids({ archived: 'exclude' })).toEqual(['a', 'c', 'e']);
    expect(ids({ archived: 'only' })).toEqual(['b', 'd']);
    expect(ids({})).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('指定幾條：只回列得出來的，順序照列表', () => {
    expect(
      pageThreadList(items, { ids: ['e', 'zzz', 'a'] }, new Set()).items.map(
        ({ threadId }) => threadId,
      ),
    ).toEqual(['a', 'e']);
  });
});
