import type { ThreadSummary } from '@nexus/wire';
import { act, cleanup, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ThreadList } from '@/features/threads/list';
import { SidebarProvider } from '@/components/ui/sidebar';
import type { ThreadDirectory } from '@/features/threads/use-directory';
import type { ThreadManagement } from '@/features/threads/management';

/**
 * 下面兩件事任一件發生，會話一多，串流每一格都要重畫整張清單：每一列各掛一份選單與確認框、外層重畫時列跟著重畫。
 * 兩條測試各釘一件。數的是確定的次數，不量毫秒：毫秒在 jsdom 與 CI 上都不穩。
 */

const counts = vi.hoisted(() => ({ roots: 0, triggers: 0 }));

vi.mock('@/components/ui/dropdown-menu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/dropdown-menu')>();
  return {
    ...actual,
    DropdownMenu: (props: Parameters<typeof actual.DropdownMenu>[0]) => {
      counts.roots += 1;
      return <actual.DropdownMenu {...props} />;
    },
    DropdownMenuRoot: (props: Parameters<typeof actual.DropdownMenuRoot>[0]) => {
      counts.roots += 1;
      return <actual.DropdownMenuRoot {...props} />;
    },
    DropdownMenuTrigger: (props: Parameters<typeof actual.DropdownMenuTrigger>[0]) => {
      counts.triggers += 1;
      return <actual.DropdownMenuTrigger {...props} />;
    },
  };
});

const COUNT = 30;
const NOW = Date.now();
const ITEMS: ThreadSummary[] = Array.from({ length: COUNT }, (_, index) => ({
  threadId: `t${index}`,
  updatedAt: NOW - index * 3_600_000,
  running: false,
  blank: false,
  title: `會話 ${index}`,
}));
const DIRECTORY: ThreadDirectory = {
  listing: { kind: 'ok', result: { items: ITEMS, unreadable: 0 } },
  statusOf: () => undefined,
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
const settled = async () => undefined;
const MANAGEMENT: ThreadManagement = {
  pinnedIds: [],
  archivedIds: new Set(),
  titles: new Map(),
  onPin: settled,
  onUnpin: settled,
  onArchive: settled,
  onUnarchive: settled,
  onRename: settled,
};

let rerenderParent: () => void = () => undefined;

/** 跟 `ConversationView` 一樣：每一格串流都重畫，傳進側欄的回呼每次都是新的。 */
function Parent() {
  const [tick, setTick] = useState(0);
  rerenderParent = () => setTick((value) => value + 1);
  return (
    <div data-tick={tick}>
      <ThreadList
        directory={DIRECTORY}
        currentThreadId="t0"
        currentTitle={null}
        onPick={() => undefined}
        management={MANAGEMENT}
      />
    </div>
  );
}

beforeEach(() => {
  counts.roots = 0;
  counts.triggers = 0;
});
afterEach(cleanup);

it('整張清單只掛一份選單，不是每一列一份', () => {
  render(
    <SidebarProvider>
      <Parent />
    </SidebarProvider>,
  );
  // 每組只先畫前幾條（#2960），所以比的是畫出來的列數，不是 `COUNT`。
  const rows = screen.getAllByTestId('thread-title-text').length;
  expect(rows).toBeGreaterThan(1);
  expect(screen.getAllByRole('button', { name: /的選項$/ })).toHaveLength(rows);
  expect(counts.roots).toBe(1);
});

it('側欄的資料沒變：外層重畫時列不跟著重畫', () => {
  render(
    <SidebarProvider>
      <Parent />
    </SidebarProvider>,
  );
  counts.triggers = 0;
  for (let index = 0; index < 5; index += 1) act(() => rerenderParent());
  expect(counts.triggers).toBe(0);
});
