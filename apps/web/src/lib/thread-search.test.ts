// @vitest-environment node
import { THREAD_SEARCH_QUERY_MAX_LENGTH, THREAD_SEARCH_RESULT_LIMIT } from '@nexus/wire';
import type { ThreadSummary } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { highlightMatches, mergeThreadSearch, sanitizeSearchQuery } from '@/lib/thread-search';

/** 側欄按內容搜（#760），合併照 dsh `deriveSearchResults`、查詢照 `sanitizeSearchQuery`。 */

function thread(threadId: string, extra: Partial<ThreadSummary> = {}): ThreadSummary {
  return { threadId, updatedAt: 0, running: false, blank: false, title: threadId, ...extra };
}
const hit = (threadId: string, snippet = `…${threadId} 的片段…`) => ({ threadId, snippet });
const ids = (items: readonly ThreadSummary[]) => items.map((item) => item.threadId);

describe('查詢', () => {
  it('拿掉 NUL', () => {
    expect(sanitizeSearchQuery('登\0入')).toBe('登入');
  });

  it('截在線上的長度上限，不切開一對代理字元', () => {
    expect(sanitizeSearchQuery('a'.repeat(THREAD_SEARCH_QUERY_MAX_LENGTH + 5))).toHaveLength(
      THREAD_SEARCH_QUERY_MAX_LENGTH,
    );
    const split = `${'a'.repeat(THREAD_SEARCH_QUERY_MAX_LENGTH - 1)}😀`;
    expect(sanitizeSearchQuery(split)).toBe('a'.repeat(THREAD_SEARCH_QUERY_MAX_LENGTH - 1));
  });
});

describe('合併', () => {
  // 由新到舊。
  const visible = [
    thread('登入頁改版'),
    thread('讀規格'),
    thread('空白的目前這條', { blank: true, title: undefined }),
    thread('目標排的', { title: undefined }),
    thread('登入流程的測試'),
  ];

  it('沒有內容命中：只比標題，就是 #610 的樣子，不設上限', () => {
    const many = Array.from({ length: THREAD_SEARCH_RESULT_LIMIT + 3 }, (_, i) =>
      thread(`登入 ${i}`),
    );
    const view = mergeThreadSearch(many, '登入', undefined);
    expect(view.items).toHaveLength(THREAD_SEARCH_RESULT_LIMIT + 3);
    expect(view.hasMore).toBe(false);
    expect(view.snippets.size).toBe(0);
  });

  it('標題對得上的在前、由新到舊；只有內容對得上的照伺服器的順序接在後面', () => {
    const view = mergeThreadSearch(visible, '登入', {
      items: [hit('目標排的'), hit('讀規格'), hit('登入流程的測試')],
      hasMore: false,
    });
    expect(ids(view.items)).toEqual(['登入頁改版', '登入流程的測試', '目標排的', '讀規格']);
  });

  it('兩邊都有的那一列掛上片段', () => {
    const view = mergeThreadSearch(visible, '登入', {
      items: [hit('登入流程的測試', '…改登入的測試…')],
      hasMore: false,
    });
    expect(view.snippets.get('登入流程的測試')).toBe('…改登入的測試…');
    expect(view.snippets.has('登入頁改版')).toBe(false);
  });

  it('不在清單上的、空白的，不列', () => {
    const view = mergeThreadSearch(visible, '沒這個字', {
      items: [hit('別台的'), hit('空白的目前這條'), hit('讀規格')],
      hasMore: false,
    });
    expect(ids(view.items)).toEqual(['讀規格']);
    expect([...view.snippets.keys()]).toEqual(['讀規格']);
  });

  it(`合起來最多 ${THREAD_SEARCH_RESULT_LIMIT} 列；超過或伺服器說還有，就講還有`, () => {
    const many = Array.from({ length: THREAD_SEARCH_RESULT_LIMIT }, (_, i) => thread(`登入 ${i}`));
    const extra = thread('內容才有');
    const over = mergeThreadSearch([...many, extra], '登入', {
      items: [hit('內容才有')],
      hasMore: false,
    });
    expect(over.items).toHaveLength(THREAD_SEARCH_RESULT_LIMIT);
    expect(over.hasMore).toBe(true);
    expect(mergeThreadSearch(visible, '登入', { items: [], hasMore: true }).hasMore).toBe(true);
    expect(mergeThreadSearch(visible, '登入', { items: [], hasMore: false }).hasMore).toBe(false);
  });
});

describe('標亮', () => {
  const marked = (text: string, query: string) =>
    highlightMatches(text, query)
      .map((part) => (part.hit ? `[${part.text}]` : part.text))
      .join('');

  it('每一處都標；英文不分大小寫', () => {
    expect(marked('Login 頁的 login 按鈕', 'LOGIN')).toBe('[Login] 頁的 [login] 按鈕');
  });

  it('連續的空白算一個，同伺服器', () => {
    expect(marked('改 登入   頁', '登入 頁')).toBe('改 [登入   頁]');
  });

  it('正則的特殊字元照字面比', () => {
    expect(marked('用 a.b(c) 呼叫，不是 axb', 'a.b(c)')).toBe('用 [a.b(c)] 呼叫，不是 axb');
  });

  it('標在原字串上：轉小寫會變長的字也不錯位', () => {
    // U+0130 轉小寫變成兩個 code unit；拿轉過的位置去切會把後面的字切錯。
    expect(marked('İstanbul 的 login', 'login')).toBe('İstanbul 的 [login]');
  });

  it('查詢只有空白：整段不標', () => {
    expect(highlightMatches('片段', '  ')).toEqual([{ text: '片段', hit: false }]);
  });
});
