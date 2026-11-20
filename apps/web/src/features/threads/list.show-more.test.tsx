import type { ThreadSummary } from '@nexus/wire';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ThreadList } from '@/features/threads/list';
import { SidebarProvider } from '@/components/ui/sidebar';
import type { ThreadDirectory } from '@/features/threads/use-directory';
import type { ThreadManagement } from '@/features/threads/management';
import type { RowStatus } from '@/features/threads/status';

/**
 * 側欄每組先畫幾條（#2960）接上畫面：組尾按鈕、焦點、一定要看得到的列、搜尋與封存照同一套、釘選不設上限、重開回到起點。
 * 條數的規則驗在 `show-more.test.ts`；這裡的列都放在「今天」同一組，數的是組裡畫出來的列。
 */

const NOW = Date.now();
const pad = (n: number) => String(n).padStart(2, '0');
/** 第 n 條（從 1 數），由新到舊。 */
function thread(n: number): ThreadSummary {
  return {
    threadId: `t${n}`,
    updatedAt: NOW - n,
    running: false,
    blank: false,
    title: `會話 ${pad(n)}`,
  };
}
const threads = (count: number) => Array.from({ length: count }, (_, index) => thread(index + 1));

function directory(
  items: readonly ThreadSummary[],
  statuses: ReadonlyMap<string, RowStatus> = new Map(),
): ThreadDirectory {
  return {
    listing: { kind: 'ok', result: { items, unreadable: 0 } },
    statusOf: (item) => statuses.get(item.threadId),
    blankOf: (item) => item.blank,
    refresh: () => undefined,
    placeholders: [],
    addPlaceholder: () => undefined,
    pushedSets: {},
    loadMore: () => undefined,
    loadingMore: false,
    ensureRows: () => undefined,
    findTitles: () => Promise.resolve(undefined),
    removals: 0,
  };
}

function management(overrides: Partial<ThreadManagement> = {}): ThreadManagement {
  return {
    pinnedIds: [],
    archivedIds: new Set(),
    titles: new Map(),
    onPin: async () => undefined,
    onUnpin: async () => undefined,
    onArchive: async () => undefined,
    onUnarchive: async () => undefined,
    onRename: async () => undefined,
    ...overrides,
  };
}

function renderList({
  items,
  statuses,
  current = 'none',
  manage,
}: {
  readonly items: readonly ThreadSummary[];
  readonly statuses?: ReadonlyMap<string, RowStatus>;
  readonly current?: string;
  readonly manage?: ThreadManagement;
}) {
  return render(
    <SidebarProvider>
      <ThreadList
        directory={directory(items, statuses)}
        currentThreadId={current}
        currentTitle={null}
        onPick={() => undefined}
        {...(manage === undefined ? {} : { management: manage })}
      />
    </SidebarProvider>,
  );
}

/** 一組裡畫出來的列，照畫面順序回它們的標題。 */
function titlesIn(group: HTMLElement): string[] {
  return within(group)
    .queryAllByTestId('thread-title-text')
    .map((node) => node.textContent ?? '');
}
const today = () => screen.getByTestId('thread-bucket');
const moreIn = (group: HTMLElement) => within(group).queryByRole('button', { name: /^顯示更多/ });

afterEach(cleanup);

describe('時間組', () => {
  it('35 條：先 10 條，按一次 30 條，再按一次 35 條、按鈕消失', () => {
    renderList({ items: threads(35) });
    expect(titlesIn(today())).toHaveLength(10);
    expect(moreIn(today())?.textContent).toBe('顯示更多（還有 25 條）');

    fireEvent.click(moreIn(today())!);
    expect(titlesIn(today())).toHaveLength(30);
    expect(moreIn(today())?.textContent).toBe('顯示更多（還有 5 條）');

    fireEvent.click(moreIn(today())!);
    expect(titlesIn(today())).toHaveLength(35);
    expect(moreIn(today())).toBeNull();
  });

  it('按下後焦點在新露出的第一列', () => {
    renderList({ items: threads(35) });
    fireEvent.click(moreIn(today())!);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^會話 11/ }));
  });

  it('新露出的第一列是目前這條（按不了）：焦點落在它的「⋯」', () => {
    // 排在 50 條以內的目前這條會被自動延伸包住，不會在新露出的那一批開頭；第 51 條不會，10 → 30 → 50 → 70 的第三次就露出它。
    renderList({ items: threads(80), current: 't51', manage: management() });
    fireEvent.click(moreIn(today())!);
    fireEvent.click(moreIn(today())!);
    fireEvent.click(moreIn(today())!);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('「會話 51」的選項');
  });

  it('第 40 條在執行中：不用按就看得到；第 60 條在執行中：要按才看得到', () => {
    renderList({
      items: threads(80),
      statuses: new Map<string, RowStatus>([
        ['t40', 'running'],
        ['t60', 'running'],
      ]),
    });
    const shown = titlesIn(today());
    expect(shown).toHaveLength(40);
    expect(shown).toContain('會話 40');
    expect(shown).not.toContain('會話 60');

    fireEvent.click(moreIn(today())!);
    expect(titlesIn(today())).toContain('會話 60');
  });

  it('等核准、跑完沒看也算一定要看得到', () => {
    renderList({
      items: threads(80),
      statuses: new Map<string, RowStatus>([
        ['t20', 'approval'],
        ['t25', 'completed'],
      ]),
    });
    expect(titlesIn(today())).toHaveLength(25);
  });

  it('目前這條排在第 30 條：不用按就看得到', () => {
    renderList({ items: threads(80), current: 't30' });
    expect(titlesIn(today())).toContain('會話 30');
  });

  it('關掉再打開（清單卸掉再掛上）：回到每組 10 條', () => {
    const first = renderList({ items: threads(35) });
    fireEvent.click(moreIn(today())!);
    expect(titlesIn(today())).toHaveLength(30);
    first.unmount();

    renderList({ items: threads(35) });
    expect(titlesIn(today())).toHaveLength(10);
  });
});

describe('搜尋、封存、釘選', () => {
  const search = (value: string) =>
    fireEvent.change(screen.getByRole('searchbox', { name: '搜尋以前的會話' }), {
      target: { value },
    });

  it('搜尋結果照同一套：先 10 條、組尾有顯示更多；換了搜尋字回到 10 條', () => {
    renderList({ items: threads(35) });
    search('會話');
    expect(titlesIn(today())).toHaveLength(10);
    fireEvent.click(moreIn(today())!);
    expect(titlesIn(today())).toHaveLength(30);

    search('會');
    expect(titlesIn(today())).toHaveLength(10);
  });

  it('展開後的已封存照同一套', () => {
    const items = threads(35);
    renderList({
      items,
      manage: management({ archivedIds: new Set(items.map((item) => item.threadId)) }),
    });
    const archived = screen.getByTestId('thread-archived');
    fireEvent.click(within(archived).getByRole('button', { name: /已封存/ }));
    expect(titlesIn(archived)).toHaveLength(10);
    expect(moreIn(archived)?.textContent).toBe('顯示更多（還有 25 條）');
    fireEvent.click(moreIn(archived)!);
    expect(titlesIn(archived)).toHaveLength(30);
  });

  it('釘選區全部顯示', () => {
    const items = threads(35);
    renderList({ items, manage: management({ pinnedIds: items.map((item) => item.threadId) }) });
    const pinned = screen.getByTestId('thread-pinned');
    expect(titlesIn(pinned)).toHaveLength(35);
    expect(moreIn(pinned)).toBeNull();
  });
});

describe('server 上還有沒載的（#725）', () => {
  function renderPaged(overrides: Partial<ThreadDirectory>) {
    const items = threads(5);
    return render(
      <SidebarProvider>
        <ThreadList
          directory={{
            ...directory(items),
            listing: { kind: 'ok', result: { items, unreadable: 0, nextCursor: 'c' } },
            ...overrides,
          }}
          currentThreadId="none"
          currentTitle={null}
          onPick={() => undefined}
        />
      </SidebarProvider>,
    );
  }
  const loadMore = () => screen.queryByTestId('thread-load-more');

  it('時間組最後有「載入更多」，按了叫 loadMore；載入中字不換、按不了、旁邊畫點', () => {
    let calls = 0;
    const first = renderPaged({ loadMore: () => void (calls += 1) });
    fireEvent.click(loadMore()!);
    expect(calls).toBe(1);
    first.unmount();

    renderPaged({ loadingMore: true });
    expect(loadMore()?.textContent).toBe('載入更多');
    expect(loadMore()!.querySelector('[style]')).not.toBeNull();
    expect(loadMore()).toHaveProperty('disabled', true);
  });

  it('搜尋時不畫按鈕，標題改問 server，問到的併進清單', async () => {
    const asked: string[] = [];
    renderPaged({
      findTitles: async (query) => {
        asked.push(query);
        return [{ ...thread(99), title: '很舊的會話 99' }];
      },
    });
    fireEvent.change(screen.getByRole('searchbox', { name: '搜尋以前的會話' }), {
      target: { value: '會話' },
    });
    expect(loadMore()).toBeNull();
    expect(await screen.findByText('很舊的會話 99')).toBeTruthy();
    expect(asked).toEqual(['會話']);
  });

  it('全部載完：沒有按鈕', () => {
    renderList({ items: threads(5) });
    expect(loadMore()).toBeNull();
  });
});
