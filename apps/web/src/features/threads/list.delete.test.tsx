import type { DeletedThread, ThreadSummary } from '@nexus/wire';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { SidebarProvider } from '@/components/ui/sidebar';
import { ThreadList } from '@/features/threads/list';
import type { ThreadDeletion, ThreadManagement } from '@/features/threads/management';
import type { RowStatus } from '@/features/threads/status';
import type { ThreadDirectory } from '@/features/threads/use-directory';

/** 側欄的刪除與「最近刪除」（[#2958](https://github.com/DemianLi/nexus-agent/issues/2958) 第二、三項）。 */

afterEach(cleanup);

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
function thread(threadId: string, title: string): ThreadSummary {
  return { threadId, updatedAt: NOW, running: false, blank: false, title };
}
const ITEMS = [thread('a', '幫我改登入頁'), thread('b', '讀規格'), thread('c', '整理部署腳本')];

function directory(
  items: readonly ThreadSummary[] = ITEMS,
  statuses: Readonly<Record<string, RowStatus>> = {},
): ThreadDirectory {
  return {
    listing: { kind: 'ok', result: { items, unreadable: 0 } },
    statusOf: (item) => statuses[item.threadId],
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

function managed(deletion: Partial<ThreadDeletion> | undefined, archived: string[] = []) {
  const calls: string[] = [];
  const management: ThreadManagement = {
    pinnedIds: [],
    archivedIds: new Set(archived),
    titles: new Map(),
    onPin: async () => undefined,
    onUnpin: async () => undefined,
    onArchive: async () => undefined,
    onUnarchive: async () => undefined,
    onRename: async () => undefined,
    ...(deletion === undefined
      ? {}
      : {
          deletion: {
            deleted: [],
            onDelete: async (id) => void calls.push(`delete ${id}`),
            onRestore: async (id) => void calls.push(`restore ${id}`),
            ...deletion,
          },
        }),
  };
  return { management, calls };
}

function renderList(
  management: ThreadManagement,
  options: {
    readonly directory?: ThreadDirectory;
    readonly current?: string;
    readonly picked?: string[];
  } = {},
) {
  render(
    <SidebarProvider>
      <nav aria-label="以前的會話">
        <ThreadList
          directory={options.directory ?? directory()}
          currentThreadId={options.current ?? 'now'}
          currentTitle={null}
          onPick={(id) => options.picked?.push(id)}
          management={management}
        />
      </nav>
    </SidebarProvider>,
  );
}

const openMenu = (title: string) =>
  fireEvent.click(screen.getByRole('button', { name: `「${title}」的選項` }));
const menuItems = () => screen.getAllByRole('menuitem').map((item) => item.textContent);
const removed = (threadId: string, title: string | undefined, daysLeft: number): DeletedThread => ({
  threadId,
  ...(title === undefined ? {} : { title }),
  deletedAt: NOW - DAY,
  expiresAt: NOW + daysLeft * DAY,
});

describe('刪除（#2958 第二項）', () => {
  it('server 沒接已刪除存放區：選單沒有刪除，也沒有最近刪除', () => {
    renderList(managed(undefined).management);
    openMenu('讀規格');
    expect(menuItems()).toEqual(['釘選', '重新命名', '封存']);
    expect(screen.queryByTestId('thread-deleted')).toBeNull();
  });

  it('接了：一般的列、目前這條、已封存的列都能刪', () => {
    renderList(managed({}, ['c']).management, { current: 'a' });
    openMenu('讀規格');
    expect(menuItems()).toEqual(['釘選', '重新命名', '封存', '刪除']);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    openMenu('幫我改登入頁');
    expect(menuItems()).toEqual(['釘選', '重新命名', '封存', '刪除']);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: '已封存（1）' }));
    openMenu('整理部署腳本');
    expect(menuItems()).toEqual(['重新命名', '取消封存', '刪除']);
  });

  it('按刪除先問；確認才送，先不要就不送', async () => {
    const { management, calls } = managed({});
    renderList(management);
    openMenu('讀規格');
    fireEvent.click(screen.getByRole('menuitem', { name: '刪除' }));
    let dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('刪除「讀規格」？')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '先不要' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(calls).toEqual([]);

    openMenu('讀規格');
    fireEvent.click(screen.getByRole('menuitem', { name: '刪除' }));
    dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).queryByRole('button', { name: '停掉並刪除' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: '刪除' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(calls).toEqual(['delete b']);
  });

  it.each<[string, RowStatus]>([
    ['執行中', 'running'],
    ['等待核准', 'approval'],
    ['等待回答', 'question'],
    ['計劃待審', 'plan-review'],
  ])('%s的會話：確認鈕寫「停掉並刪除」', async (_case, status) => {
    const { management, calls } = managed({});
    renderList(management, { directory: directory(ITEMS, { b: status }) });
    openMenu('讀規格');
    fireEvent.click(screen.getByRole('menuitem', { name: '刪除' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).queryByRole('button', { name: /^刪除$/u })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: '停掉並刪除' }));
    await waitFor(() => expect(calls).toEqual(['delete b']));
  });

  it('跑完沒看的不算在跑：確認鈕寫「刪除」', async () => {
    renderList(managed({}).management, { directory: directory(ITEMS, { b: 'completed' }) });
    openMenu('讀規格');
    fireEvent.click(screen.getByRole('menuitem', { name: '刪除' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByRole('button', { name: '刪除' })).toBeTruthy();
  });

  it('刪掉的那一列不再出現在清單裡（已經在已刪除清單上的不列）', () => {
    renderList(managed({ deleted: [removed('b', '讀規格', 30)] }).management);
    expect(screen.queryByRole('button', { name: '「讀規格」的選項' })).toBeNull();
    expect(screen.getByRole('button', { name: '「幫我改登入頁」的選項' })).toBeTruthy();
  });
});

describe('最近刪除（#2958 第三項）', () => {
  const DELETED = [removed('x', '舊的報告', 3), removed('y', undefined, 29.5)];

  it('在最下面、已封存之後，預設收著，標題帶數量', () => {
    renderList(managed({ deleted: DELETED }, ['c']).management);
    const section = screen.getByTestId('thread-deleted');
    const archived = screen.getByTestId('thread-archived');
    expect(
      archived.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const toggle = within(section).getByRole('button', { name: '最近刪除（2）' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('舊的報告')).toBeNull();
  });

  it('每列寫還剩幾天，唯一的動作是復原；點列不會打開', async () => {
    const picked: string[] = [];
    const { management, calls } = managed({ deleted: DELETED });
    renderList(management, { picked });
    fireEvent.click(screen.getByRole('button', { name: '最近刪除（2）' }));
    const section = screen.getByTestId('thread-deleted');
    expect(within(section).getByText('舊的報告')).toBeTruthy();
    expect(within(section).getByText('還剩 3 天')).toBeTruthy();
    expect(within(section).getByText('還剩 30 天')).toBeTruthy();
    const buttons = within(section)
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label') ?? button.textContent);
    expect(buttons).toEqual(['最近刪除（2）', '復原「舊的報告」', '復原「新會話」']);
    fireEvent.click(within(section).getByText('舊的報告'));
    expect(picked).toEqual([]);
    fireEvent.click(within(section).getByRole('button', { name: '復原「舊的報告」' }));
    await act(async () => undefined);
    expect(calls).toEqual(['restore x']);
  });

  it('過了寬限期的不列，也就不能復原', () => {
    renderList(managed({ deleted: [...DELETED, removed('z', '過期的', -0.1)] }).management);
    fireEvent.click(screen.getByRole('button', { name: '最近刪除（2）' }));
    expect(screen.queryByText('過期的')).toBeNull();
  });

  it('沒有已刪除的：不畫這一區', () => {
    renderList(managed({ deleted: [] }).management);
    expect(screen.queryByTestId('thread-deleted')).toBeNull();
  });

  it('清單一條都不剩時照樣看得到最近刪除', () => {
    renderList(managed({ deleted: DELETED }).management, { directory: directory([]) });
    expect(screen.getByText('這個專案還沒有以前的會話。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '最近刪除（2）' })).toBeTruthy();
  });
});
