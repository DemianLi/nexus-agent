import { THREAD_SEARCH_QUERY_MAX_LENGTH } from '@nexus/wire';
import type { ThreadSearchOutcome, ThreadSummary } from '@nexus/wire';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThreadList } from '@/components/sidebar/thread-list';
import { SidebarProvider } from '@/components/ui/sidebar';
import type { ThreadDirectory } from '@/hooks/use-thread-directory';
import { SEARCH_DEBOUNCE_MS } from '@/lib/thread-search';
import type { ThreadManagement } from '@/lib/thread-management';
import { axeViolations } from '@/test/axe';

/**
 * 側欄按內容搜（[#760](https://github.com/DemianLi/nexus-agent/issues/760)）。合併與標亮的規則驗在
 * `lib/thread-search.test.ts`；這裡驗接上畫面：什麼時候問、取消、骨架、退回只比標題。
 */

const NOW = Date.now();
function thread(threadId: string, title: string): ThreadSummary {
  return { threadId, updatedAt: NOW, running: false, blank: false, title };
}
const ITEMS = [thread('a', '幫我改登入頁'), thread('b', '讀規格'), thread('c', '整理部署腳本')];
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

  it('打得快：停下來之前的字都不問', async () => {
    const fake = searcher();
    renderList(fake.search);
    type('登');
    await wait(SEARCH_DEBOUNCE_MS - 1);
    type('登入');
    await wait(SEARCH_DEBOUNCE_MS);
    expect(fake.calls.map((call) => call.query)).toEqual(['登入']);
  });

  it('貼上超過線上的長度：搜尋框與送出的都截在上限', async () => {
    const fake = searcher();
    renderList(fake.search);
    type('規'.repeat(THREAD_SEARCH_QUERY_MAX_LENGTH + 20));
    expect(box().value).toHaveLength(THREAD_SEARCH_QUERY_MAX_LENGTH);
    await wait(SEARCH_DEBOUNCE_MS);
    expect(fake.calls[0]!.query).toHaveLength(THREAD_SEARCH_QUERY_MAX_LENGTH);
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
    // 還不知道伺服器有沒有開：提示字只講確定做得到的。
    expect(box().placeholder).toBe('搜尋標題');
    type('部署');
    expect(rows()).toEqual([expect.stringContaining('整理部署腳本')]);
    await wait(SEARCH_DEBOUNCE_MS);
    await fake.answer(0, [['b', '…規格裡講部署的那一段…']]);
    expect(box().placeholder).toBe('搜尋會話');
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
  it('伺服器拒絕：這一次只比標題，跟 #610 一樣不多講；不記住，下一次照樣問', async () => {
    const fake = searcher();
    renderList(fake.search);
    type('部署');
    await wait(SEARCH_DEBOUNCE_MS);
    await act(async () => fake.calls[0]!.resolve({ kind: 'rejected', message: '這個部署沒開' }));
    expect(screen.queryByText('這個部署沒開')).toBeNull();
    expect(rows()).toEqual([expect.stringContaining('整理部署腳本')]);
    expect(box().placeholder).toBe('搜尋標題');
    type('沒這個字');
    // 沒回過「有」：不畫骨架，「搜不到」照 #610 馬上講。
    expect(skeleton()).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('沒有標題含「沒這個字」的會話。');
    await wait(SEARCH_DEBOUNCE_MS);
    expect(fake.calls).toHaveLength(2);
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

describe('釘選、封存、改名（#633）', () => {
  // 外面的假計時器會讓 `findBy*` 與 axe 的非同步等不到；這一組不靠計時器。
  beforeEach(() => vi.useRealTimers());

  function managed(overrides: Partial<ThreadManagement> = {}) {
    const calls: string[] = [];
    const management: ThreadManagement = {
      pinnedIds: [],
      archivedIds: new Set(),
      titles: new Map(),
      onPin: async (id) => void calls.push(`pin ${id}`),
      onUnpin: async (id) => void calls.push(`unpin ${id}`),
      onArchive: async (id) => void calls.push(`archive ${id}`),
      onUnarchive: async (id) => void calls.push(`unarchive ${id}`),
      onRename: async (id, title) => void calls.push(`rename ${id} ${title}`),
      ...overrides,
    };
    return { management, calls };
  }

  function renderManaged(management: ThreadManagement | undefined, currentThreadId = 'now') {
    render(
      <SidebarProvider>
        <nav aria-label="以前的會話">
          <ThreadList
            directory={DIRECTORY}
            currentThreadId={currentThreadId}
            currentTitle={null}
            onPick={() => undefined}
            {...(management === undefined ? {} : { management })}
          />
        </nav>
      </SidebarProvider>,
    );
  }

  /** Radix 的選單在 jsdom 裡用鍵盤打開最穩。 */
  const openMenu = (title: string) => {
    fireEvent.keyDown(screen.getByRole('button', { name: `「${title}」的選項` }), { key: 'Enter' });
    return screen.getByRole('menu');
  };
  const menuItems = () => screen.getAllByRole('menuitem').map((item) => item.textContent);

  it('沒給 management：沒有選單、沒有釘選與封存兩區', () => {
    renderManaged(undefined);
    expect(screen.queryByRole('button', { name: /的選項/u })).toBeNull();
    expect(screen.queryByTestId('thread-pinned')).toBeNull();
    expect(screen.queryByTestId('thread-archived')).toBeNull();
  });

  it('每一列都有選單；一般的列可以釘選、改名、封存', () => {
    renderManaged(managed().management);
    expect(screen.getAllByRole('button', { name: /的選項/u })).toHaveLength(3);
    openMenu('幫我改登入頁');
    expect(menuItems()).toEqual(['釘選', '重新命名', '封存']);
  });

  it('點選項叫對應的動作，帶這一列的 id', async () => {
    const { management, calls } = managed();
    renderManaged(management);
    openMenu('讀規格');
    fireEvent.click(screen.getByRole('menuitem', { name: '釘選' }));
    openMenu('讀規格');
    fireEvent.click(screen.getByRole('menuitem', { name: '封存' }));
    await act(async () => undefined);
    expect(calls).toEqual(['pin b', 'archive b']);
  });

  it('釘選的在最前面的「已釘選」，順序是最近釘的在前，且不再出現在時間組裡；選項換成取消釘選', () => {
    renderManaged(managed({ pinnedIds: ['c', 'a'] }).management);
    const pinned = screen.getByTestId('thread-pinned');
    expect(within(pinned).getByText('已釘選')).toBeTruthy();
    expect(
      within(pinned)
        .getAllByRole('button', { name: /^(?!.*的選項)/u })
        .map((button) => button.textContent),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining('整理部署腳本'),
        expect.stringContaining('幫我改登入頁'),
      ]),
    );
    const order = within(pinned)
      .getAllByTestId('thread-title-text')
      .map((node) => node.textContent);
    expect(order).toEqual(['整理部署腳本', '幫我改登入頁']);
    const buckets = within(screen.getByTestId('thread-bucket'));
    expect(buckets.queryByText('整理部署腳本')).toBeNull();
    expect(buckets.getByText('讀規格')).toBeTruthy();
    openMenu('整理部署腳本');
    expect(menuItems()).toEqual(['取消釘選', '重新命名', '封存']);
  });

  it('封存的收在最後的「已封存（n）」，預設收著；展開才看得到，選項是取消封存（沒有釘選）', () => {
    renderManaged(managed({ archivedIds: new Set(['b']) }).management);
    const archived = screen.getByTestId('thread-archived');
    const toggle = within(archived).getByRole('button', { name: '已封存（1）' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('讀規格')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('讀規格')).toBeTruthy();
    openMenu('讀規格');
    expect(menuItems()).toEqual(['重新命名', '取消封存']);
  });

  it('搜尋時封存區自動展開，命中的封存會話看得到', () => {
    renderManaged(managed({ archivedIds: new Set(['b']) }).management);
    expect(screen.queryByText('讀規格')).toBeNull();
    type('規格');
    expect(screen.getByText('讀規格')).toBeTruthy();
  });

  it('目前這條不給封存', () => {
    renderManaged(managed().management, 'a');
    openMenu('幫我改登入頁');
    expect(menuItems()).toEqual(['釘選', '重新命名']);
  });

  it('動作失敗：說原因', async () => {
    const { management } = managed({ onPin: async () => '伺服器說不行' });
    renderManaged(management);
    openMenu('讀規格');
    fireEvent.click(screen.getByRole('menuitem', { name: '釘選' }));
    await act(async () => undefined);
    // toast 住在 `Toaster`，這裡沒掛；只驗不拋錯、選單收起。
    expect(screen.queryByRole('menu')).toBeNull();
  });

  describe('改名', () => {
    const startRename = (title: string) => {
      openMenu(title);
      fireEvent.click(screen.getByRole('menuitem', { name: '重新命名' }));
      return screen.getByRole('textbox', { name: '重新命名會話' }) as HTMLInputElement;
    };

    it('原地換成輸入框、帶現在的標題；Enter 送出標準化後的標題，輸入框收起', async () => {
      const { management, calls } = managed();
      renderManaged(management);
      const field = startRename('讀規格');
      expect(field.value).toBe('讀規格');
      fireEvent.change(field, { target: { value: '  讀   新規格 ' } });
      fireEvent.keyDown(field, { key: 'Enter' });
      await act(async () => undefined);
      expect(calls).toEqual(['rename b 讀 新規格']);
      expect(screen.queryByRole('textbox', { name: '重新命名會話' })).toBeNull();
    });

    it('Esc 放棄；沒改或清空也算放棄，都不叫動作', async () => {
      const { management, calls } = managed();
      renderManaged(management);
      let field = startRename('讀規格');
      fireEvent.change(field, { target: { value: '別的' } });
      fireEvent.keyDown(field, { key: 'Escape' });
      expect(screen.queryByRole('textbox', { name: '重新命名會話' })).toBeNull();
      field = startRename('讀規格');
      fireEvent.keyDown(field, { key: 'Enter' });
      expect(screen.queryByRole('textbox', { name: '重新命名會話' })).toBeNull();
      field = startRename('讀規格');
      fireEvent.change(field, { target: { value: '   ' } });
      fireEvent.keyDown(field, { key: 'Enter' });
      await act(async () => undefined);
      expect(calls).toEqual([]);
    });

    it('選字中的 Enter 不送出', async () => {
      const { management, calls } = managed();
      renderManaged(management);
      const field = startRename('讀規格');
      fireEvent.change(field, { target: { value: '新名' } });
      fireEvent.keyDown(field, { key: 'Enter', isComposing: true });
      await act(async () => undefined);
      expect(calls).toEqual([]);
    });

    it('失敗：輸入框和人打的字留著，說原因；改字之後原因消失，可以再送', async () => {
      let failing = true;
      const { management, calls } = managed({
        onRename: async (id, title) => {
          if (failing) return '標題太長了';
          calls.push(`rename ${id} ${title}`);
          return undefined;
        },
      });
      renderManaged(management);
      const field = startRename('讀規格');
      fireEvent.change(field, { target: { value: '很長的標題' } });
      fireEvent.keyDown(field, { key: 'Enter' });
      expect((await screen.findByRole('alert')).textContent).toBe('標題太長了');
      expect(field.value).toBe('很長的標題');
      failing = false;
      fireEvent.change(field, { target: { value: '短一點' } });
      expect(screen.queryByRole('alert')).toBeNull();
      fireEvent.keyDown(field, { key: 'Enter' });
      await act(async () => undefined);
      expect(calls).toEqual(['rename b 短一點']);
    });

    it('改過的標題蓋過清單上的', () => {
      renderManaged(managed({ titles: new Map([['b', '我取的名字']]) }).management);
      expect(screen.getByText('我取的名字')).toBeTruthy();
      expect(screen.queryByText('讀規格')).toBeNull();
    });
  });

  it('axe：選單關著與打開時沒有違規', async () => {
    renderManaged(managed({ pinnedIds: ['c'], archivedIds: new Set(['b']) }).management);
    expect(await axeViolations(document.body)).toEqual([]);
    // 選單住在 portal 裡、不在側欄的地標內（正式環境也一樣）：`region` 是整頁規則，單掃選單本身。
    expect(await axeViolations(openMenu('幫我改登入頁'))).toEqual([]);
  });
});
