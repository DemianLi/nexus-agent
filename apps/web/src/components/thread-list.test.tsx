import type { ThreadSearchOutcome, ThreadSummary } from '@nexus/wire';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThreadList } from '@/components/thread-list';
import { SidebarProvider } from '@/components/ui/sidebar';
import type { ThreadDirectory } from '@/hooks/use-thread-directory';
import { SEARCH_DEBOUNCE_MS } from '@/lib/thread-search';
import { axeViolations } from '@/test/axe';

/**
 * 側欄按內容搜（[#760](https://github.com/DemianLi/nexus-agent/issues/760)）。合併與標亮的規則驗在
 * `lib/thread-search.test.ts`；這裡驗接上畫面：什麼時候問、取消、骨架、退回只比標題。
 */

const NOW = Date.now();
function thread(threadId: string, title: string): ThreadSummary {
  return { threadId, updatedAt: NOW, running: false, blank: false, title };
}
const ITEMS = [
  thread('a', '幫我改登入頁'),
  thread('b', '讀規格'),
  thread('c', '整理部署腳本'),
];
const DIRECTORY: ThreadDirectory = {
  listing: { kind: 'ok', result: { items: ITEMS, unreadable: 0 } },
  statusOf: () => undefined,
  refresh: () => undefined,
};

function searcher() {
  const calls: {
    readonly query: string;
    readonly signal: AbortSignal;
    readonly resolve: (outcome: ThreadSearchOutcome) => void;
    readonly reject: (error: unknown) => void;
  }[] = [];
  const search = (query: string, signal: AbortSignal) =>
    new Promise<ThreadSearchOutcome>((resolve, reject) =>
      calls.push({ query, signal, resolve, reject }),
    );
  return {
    search,
    calls,
    answer: (index: number, hits: readonly [string, string][], hasMore = false) =>
      act(async () =>
        calls[index]!.resolve({
          kind: 'ok',
          result: { items: hits.map(([threadId, snippet]) => ({ threadId, snippet })), hasMore },
        }),
      ),
  };
}

function renderList(search?: ReturnType<typeof searcher>['search']) {
  render(
    <SidebarProvider>
      {/* `App` 裡側欄住在地標裡；只畫這一塊時補一個，axe 才不會報頁面內容沒有地標。 */}
      <nav aria-label="以前的會話">
        <ThreadList
          directory={DIRECTORY}
          currentThreadId="now"
          currentTitle={null}
          onPick={() => undefined}
          {...(search === undefined ? {} : { search })}
        />
      </nav>
    </SidebarProvider>,
  );
}

const box = () => screen.getByRole('searchbox', { name: '搜尋以前的會話' }) as HTMLInputElement;
const type = (value: string) => fireEvent.change(box(), { target: { value } });
const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const rows = () => screen.queryAllByRole('button').map((button) => button.textContent);
const skeleton = () => screen.queryByRole('status', { name: '正在搜內容' });
const snippetOf = (name: RegExp) =>
  within(screen.getByRole('button', { name })).queryByTestId('thread-snippet');

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('什麼時候問', () => {
  it(`打完停 ${SEARCH_DEBOUNCE_MS}ms 才問，問的是去掉頭尾空白的字`, async () => {
    const fake = searcher();
    renderList(fake.search);
    type('  規格 ');
    await wait(SEARCH_DEBOUNCE_MS - 1);
    expect(fake.calls).toHaveLength(0);
    await wait(1);
    expect(fake.calls.map((call) => call.query)).toEqual(['規格']);
  });

  it('下一個字一到就取消上一次', async () => {
    const fake = searcher();
    renderList(fake.search);
    type('登');
    await wait(SEARCH_DEBOUNCE_MS);
    type('登入');
    expect(fake.calls[0]!.signal.aborted).toBe(true);
    await wait(SEARCH_DEBOUNCE_MS);
    expect(fake.calls.map((call) => call.query)).toEqual(['登', '登入']);
  });

  it('被取消的那一次晚到的失敗不畫：打回同一個字也一樣', async () => {
    const fake = searcher();
    renderList(fake.search);
    type('登');
    await wait(SEARCH_DEBOUNCE_MS);
    type('登入');
    type('登');
    // 第一次被取消之後才拋（真的 fetch 被取消時就是這樣），這時搜尋框又是同一個字。
    await act(async () => fake.calls[0]!.reject(new DOMException('aborted', 'AbortError')));
    expect(screen.queryByText('內容搜尋失敗，這一次只比了標題。')).toBeNull();
  });

  it('Esc 清掉搜尋框，還在問的那一次取消', async () => {
    const fake = searcher();
    renderList(fake.search);
    type('規格');
    await wait(SEARCH_DEBOUNCE_MS);
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(box().value).toBe('');
    expect(fake.calls[0]!.signal.aborted).toBe(true);
    expect(rows()).toHaveLength(3);
  });

  it('沒接搜尋：只比標題，提示字寫「搜尋標題」', () => {
    renderList();
    expect(box().placeholder).toBe('搜尋標題');
    type('登入');
    expect(rows()).toEqual([expect.stringContaining('幫我改登入頁')]);
  });
});

describe('有開內容搜尋', () => {
  it('標題對得上的先畫；內容命中回來之後接在後面，掛上片段、標亮', async () => {
    const fake = searcher();
    renderList(fake.search);
    expect(box().placeholder).toBe('搜尋會話');
    type('部署');
    expect(rows()).toEqual([expect.stringContaining('整理部署腳本')]);
    await wait(SEARCH_DEBOUNCE_MS);
    await fake.answer(0, [['b', '…規格裡講部署的那一段…']]);
    expect(rows()).toEqual([
      expect.stringContaining('整理部署腳本'),
      expect.stringContaining('讀規格'),
    ]);
    const snippet = snippetOf(/讀規格/)!;
    expect(snippet.textContent).toBe('…規格裡講部署的那一段…');
    expect([...snippet.querySelectorAll('mark')].map((mark) => mark.textContent)).toEqual(['部署']);
    expect(snippetOf(/整理部署腳本/)).toBeNull();
  });

  it('第一次回來之前不畫骨架；知道有開之後，還在問就畫', async () => {
    const fake = searcher();
    renderList(fake.search);
    type('部署');
    await wait(SEARCH_DEBOUNCE_MS);
    expect(skeleton()).toBeNull();
    await fake.answer(0, []);
    type('規格');
    expect(skeleton()).not.toBeNull();
    await wait(SEARCH_DEBOUNCE_MS);
    await fake.answer(1, []);
    expect(skeleton()).toBeNull();
  });

  it('兩邊都沒有：講「標題或內容」', async () => {
    const fake = searcher();
    renderList(fake.search);
    type('沒這個字');
    await wait(SEARCH_DEBOUNCE_MS);
    await fake.answer(0, []);
    expect(screen.getByRole('status').textContent).toBe('沒有標題或內容含「沒這個字」的會話。');
  });

  it('伺服器說還有：講一聲', async () => {
    const fake = searcher();
    renderList(fake.search);
    type('規格');
    await wait(SEARCH_DEBOUNCE_MS);
    await fake.answer(0, [], true);
    expect(screen.getByText('還有更多沒列出來，多打幾個字可以縮小範圍。')).toBeTruthy();
  });

  it('過 axe', async () => {
    vi.useRealTimers();
    const fake = searcher();
    renderList(fake.search);
    type('部署');
    await act(() => new Promise((resolve) => setTimeout(resolve, SEARCH_DEBOUNCE_MS + 10)));
    await fake.answer(0, [['b', '…規格裡講部署的那一段…']]);
    expect(await axeViolations(document.body)).toEqual([]);
  });
});

describe('退回只比標題', () => {
  it('伺服器說沒開：照印原因、記住，之後不再問，提示字換成「搜尋標題」', async () => {
    const fake = searcher();
    renderList(fake.search);
    type('部署');
    await wait(SEARCH_DEBOUNCE_MS);
    await act(async () => fake.calls[0]!.resolve({ kind: 'rejected', message: '這個部署沒開' }));
    expect(screen.getByText('這個部署沒開')).toBeTruthy();
    expect(rows()).toEqual([expect.stringContaining('整理部署腳本')]);
    expect(box().placeholder).toBe('搜尋標題');
    type('沒這個字');
    await wait(SEARCH_DEBOUNCE_MS * 2);
    expect(fake.calls).toHaveLength(1);
    expect(skeleton()).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('沒有標題含「沒這個字」的會話。');
  });

  it('搜尋失敗：這一次只比標題，下一次照樣問', async () => {
    const fake = searcher();
    renderList(fake.search);
    type('部署');
    await wait(SEARCH_DEBOUNCE_MS);
    await act(async () => fake.calls[0]!.reject(new Error('搜尋被載體層擋下：500')));
    expect(screen.getByText('內容搜尋失敗，這一次只比了標題。')).toBeTruthy();
    expect(rows()).toEqual([expect.stringContaining('整理部署腳本')]);
    type('規格');
    await wait(SEARCH_DEBOUNCE_MS);
    expect(fake.calls).toHaveLength(2);
    expect(screen.queryByText('內容搜尋失敗，這一次只比了標題。')).toBeNull();
  });
});
