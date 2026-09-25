import type { WorkspaceChangesSummary } from '@nexus/wire';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChangesCard } from '@/components/changes-card';
import { DeliverablesCard } from '@/components/deliverables-card';
import {
  RIGHT_SIDEBAR_EMPTY_TEXT,
  RightSidebarPanel,
  RightSidebarProvider,
  RightSidebarToggle,
  changesTabTitle,
} from '@/components/right-sidebar';
import { createChangesStores } from '@/lib/changes-diff';
import { createDeliverableFileStore } from '@/lib/deliverable-file';
import type { LocatedFile } from '@/lib/deliverables-view';
import { LAYOUT_KEY_PREFIX, WIDTH_KEY, openTab, EMPTY_LAYOUT } from '@/lib/right-sidebar';
import type { SidebarLayout } from '@/lib/right-sidebar';
import { axeViolations } from '@/test/axe';
import { memoryStorage } from '@/test/right-sidebar';

/** 預覽捲到底才接下一段；這裡只讀第一段，觀察器什麼都不做。 */
class IdleObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('IntersectionObserver', IdleObserver);
});

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
  vi.unstubAllGlobals();
});

/** 第 7 輪改 2 個檔、第 8 輪改 3 個：兩張卡的區塊名稱才不撞（axe `landmark-unique`）。 */
const summaryOf = (seq: number): WorkspaceChangesSummary => {
  const files = Array.from({ length: seq - 5 }, (_, at) => ({
    path: `src/${at === 0 ? 's' : 't'}${seq}${at > 1 ? `-${at}` : ''}.ts`,
    display: `src/${at === 0 ? 's' : 't'}${seq}${at > 1 ? `-${at}` : ''}.ts`,
    added: at + 1,
    deleted: at,
  }));
  return { files, total: files.length, added: 3, deleted: 1 };
};

const REPORT: LocatedFile = { path: 'out/report.md', seq: 11, index: 0 };

const diffBody = (seq: number, index: number) =>
  JSON.stringify({
    kind: 'text',
    path: `src/f${seq}-${index}.ts`,
    display: `src/f${seq}-${index}.ts`,
    before: true,
    after: true,
    coarse: false,
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
  });

/** 摘要、比較、交付讀檔都走這一個假 fetch；記下每一個請求的路徑與參數。 */
function wire() {
  const requests: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://h');
    requests.push(`${url.pathname}?${url.searchParams.toString()}`);
    const seq = Number(url.searchParams.get('seq'));
    if (url.pathname.endsWith('/summary')) return new Response(JSON.stringify(summaryOf(seq)));
    if (url.pathname.includes('/deliverables/'))
      return new Response(
        JSON.stringify({
          path: REPORT.path,
          version: 'v1',
          bytes: 12,
          offset: 0,
          text: '報告內容',
          lines: 1,
          eof: true,
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    return new Response(diffBody(seq, Number(url.searchParams.get('index'))));
  }) as unknown as typeof globalThis.fetch;
  const wiring = { threadId: 't', baseUrl: 'http://h', fetch };
  return {
    requests,
    sources: {
      changes: createChangesStores(wiring),
      deliverableFiles: createDeliverableFileStore(wiring),
    },
  };
}

type Sources = ReturnType<typeof wire>['sources'];

function Screen({ sources, threadId = 't' }: { sources: Sources; threadId?: string }) {
  return (
    <RightSidebarProvider threadId={threadId} sources={sources}>
      <main>
        <RightSidebarToggle />
        <ChangesCard seq={7} changes={sources.changes} />
        <ChangesCard seq={8} changes={sources.changes} />
        <DeliverablesCard files={[REPORT]} />
      </main>
      <RightSidebarPanel />
    </RightSidebarProvider>
  );
}

async function mount(threadId = 't') {
  const setup = wire();
  const view = render(<Screen sources={setup.sources} threadId={threadId} />);
  await act(async () => {});
  return { ...setup, view };
}

async function click(element: Element) {
  fireEvent.click(element);
  await act(async () => {});
}

const panel = () => screen.getByTestId('right-sidebar');
const tabNames = () => screen.getAllByRole('tab').map((tab) => tab.textContent);
const cardHeader = (seq: number) =>
  within(screen.getAllByTestId('changes')[seq === 7 ? 0 : 1]!).getByRole('button', {
    name: /個檔案有改動/,
  });

function saved(threadId = 't'): SidebarLayout | undefined {
  const raw = localStorage.getItem(LAYOUT_KEY_PREFIX + threadId);
  return raw === null ? undefined : (JSON.parse(raw) as SidebarLayout);
}

describe('開關與空狀態', () => {
  it('一開始收著；按開關鈕展開，沒有分頁時講一句怎麼打開；收起鈕收回去', async () => {
    await mount();
    expect(panel().hidden).toBe(true);
    const toggle = screen.getByRole('button', { name: '打開右側欄' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe('right-sidebar');

    await click(toggle);
    expect(panel().hidden).toBe(false);
    expect(within(panel()).getByText(RIGHT_SIDEBAR_EMPTY_TEXT)).toBeTruthy();
    expect(screen.getByRole('button', { name: '收起右側欄', expanded: true })).toBeTruthy();

    await click(within(panel()).getByRole('button', { name: '收起右側欄' }));
    expect(panel().hidden).toBe(true);
    // 面板一藏焦點就沒地方去；交回標頭的開關鈕（實機量到掉在 body）。
    expect(document.activeElement).toBe(toggle);
  });

  it('停靠時 Esc 不做事：它是頁面的一欄', async () => {
    await mount();
    await click(cardHeader(7));
    fireEvent.keyDown(screen.getByRole('tab'), { key: 'Escape' });
    await act(async () => {});
    expect(panel().hidden).toBe(false);
  });
});

describe('從卡片打開', () => {
  it('改動與交付各開一個分頁；同一個目標再點只是選回它', async () => {
    await mount();
    await click(cardHeader(7));
    await click(screen.getByRole('button', { name: '預覽：out/report.md' }));
    expect(tabNames()).toEqual(['改動 · s7.ts 等 2 個', 'report.md']);
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe('report.md');
    expect(await screen.findByText('報告內容')).toBeTruthy();

    await click(cardHeader(7));
    expect(tabNames()).toHaveLength(2);
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe('改動 · s7.ts 等 2 個');
  });

  it('收起時從卡片打開會展開', async () => {
    await mount();
    await click(cardHeader(7));
    await click(within(panel()).getByRole('button', { name: '收起右側欄' }));
    await click(cardHeader(8));
    expect(panel().hidden).toBe(false);
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe('改動 · s8.ts 等 3 個');
  });

  it('切到別的分頁再回來，分頁裡的切換鈕留著', async () => {
    await mount();
    await click(cardHeader(7));
    await click(within(panel()).getByRole('button', { name: '左右對照' }));
    await click(cardHeader(8));
    await click(screen.getByRole('tab', { name: '改動 · s7.ts 等 2 個' }));
    const visible = screen.getByRole('tabpanel');
    expect(
      within(visible).getByRole('button', { name: '左右對照' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('改動分頁的標題：一個檔不寫「等」；滑鼠移上去列出全部', () => {
    expect(changesTabTitle(undefined)).toEqual({ label: '改動', detail: undefined });
    expect(changesTabTitle({ files: [{ display: 'a/b.ts' }], total: 1 })).toEqual({
      label: '改動 · b.ts',
      detail: 'a/b.ts',
    });
    expect(
      changesTabTitle({ files: [{ display: 'a/b.ts' }, { display: 'c.ts' }], total: 5 }).detail,
    ).toBe('a/b.ts\nc.ts\n另有 3 個檔沒有列出');
  });
});

describe('關分頁與鍵盤', () => {
  it('× 關掉；最後一個關掉之後是空狀態', async () => {
    await mount();
    await click(cardHeader(7));
    await click(screen.getByTestId('right-sidebar-tab-close'));
    expect(screen.queryByRole('tab')).toBeNull();
    expect(within(panel()).getByText(RIGHT_SIDEBAR_EMPTY_TEXT)).toBeTruthy();
    expect(panel().hidden).toBe(false);
  });

  it('左右鍵換分頁、焦點跟著走；Delete 關掉，焦點到下一個；都關掉了到收起鈕', async () => {
    await mount();
    await click(cardHeader(7));
    await click(cardHeader(8));
    const second = screen.getByRole('tab', { selected: true });
    expect(second.getAttribute('aria-keyshortcuts')).toBe('Delete');
    fireEvent.keyDown(second, { key: 'ArrowLeft' });
    await act(async () => {});
    const first = screen.getByRole('tab', { selected: true });
    expect(first.textContent).toBe('改動 · s7.ts 等 2 個');
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: 'Delete' });
    await act(async () => {});
    expect(tabNames()).toEqual(['改動 · s8.ts 等 3 個']);
    expect(document.activeElement).toBe(screen.getByRole('tab'));

    fireEvent.keyDown(screen.getByRole('tab'), { key: 'Delete' });
    await act(async () => {});
    expect(document.activeElement).toBe(
      within(panel()).getByRole('button', { name: '收起右側欄' }),
    );
  });

  it('只有選中的分頁在 Tab 順序裡', async () => {
    await mount();
    await click(cardHeader(7));
    await click(cardHeader(8));
    expect(screen.getAllByRole('tab').map((tab) => tab.tabIndex)).toEqual([-1, 0]);
  });
});

describe('記住版面', () => {
  it('打開看一眼不寫；人動過才寫', async () => {
    await mount();
    expect(saved()).toBeUndefined();
    await click(cardHeader(7));
    expect(saved()?.tabs).toEqual([{ kind: 'changes', seq: 7, index: 0 }]);
  });

  it('重新整理後恢復分頁；只掛選中的那一個，沒選過的不讀', async () => {
    const layout = [8, 7].reduce(
      (current, seq) => openTab(current, { kind: 'changes', seq, index: 1 }),
      openTab(EMPTY_LAYOUT, { kind: 'deliverable', file: REPORT }),
    );
    localStorage.setItem(LAYOUT_KEY_PREFIX + 't', JSON.stringify(layout));
    const { requests } = await mount();
    expect(panel().hidden).toBe(false);
    expect(tabNames()).toEqual(['report.md', '改動 · s8.ts 等 3 個', '改動 · s7.ts 等 2 個']);
    expect(screen.getAllByRole('tabpanel', { hidden: true })).toHaveLength(1);
    // 比較只讀了選中那一輪的那個檔；交付檔一段都沒讀。
    const diffs = requests.filter((url) => !url.includes('/summary'));
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toContain('index=1');
    expect(requests.some((url) => url.includes('/deliverables/'))).toBe(false);
  });

  it('每條會話各一套：換一條就是那條自己的', async () => {
    localStorage.setItem(
      LAYOUT_KEY_PREFIX + 'other',
      JSON.stringify(openTab(EMPTY_LAYOUT, { kind: 'changes', seq: 8, index: 0 })),
    );
    await mount('t');
    await click(cardHeader(7));
    cleanup();
    await mount('other');
    expect(tabNames()).toEqual(['改動 · s8.ts 等 3 個']);
    cleanup();
    await mount('t');
    expect(tabNames()).toEqual(['改動 · s7.ts 等 2 個']);
  });

  it('存的東西壞了：當成沒有，照常能用', async () => {
    localStorage.setItem(
      LAYOUT_KEY_PREFIX + 't',
      JSON.stringify({ open: true, tabs: [{ kind: '?' }] }),
    );
    await mount();
    expect(panel().hidden).toBe(true);
    await click(cardHeader(7));
    expect(tabNames()).toHaveLength(1);
  });
});

describe('拖寬的把手', () => {
  it('鍵盤：左鍵變寬、右鍵變窄、Home 到最窄；寬度記下來', async () => {
    await mount();
    await click(cardHeader(7));
    const handle = screen.getByRole('separator', { name: '調整右側欄寬度' });
    expect(handle.getAttribute('aria-valuenow')).toBe('560');
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(handle.getAttribute('aria-valuenow')).toBe('576');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(handle.getAttribute('aria-valuenow')).toBe('544');
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(handle.getAttribute('aria-valuenow')).toBe('320');
    expect(localStorage.getItem(WIDTH_KEY)).toBe('320');
  });
});

describe('窄螢幕：全螢幕覆蓋', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'matchMedia',
      (query: string) =>
        ({
          matches: true,
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    );
  });

  it('打開是一個對話框；Esc 關掉等同收起，分頁留著', async () => {
    await mount();
    expect(screen.queryByRole('dialog')).toBeNull();
    await click(cardHeader(7));
    const dialog = screen.getByRole('dialog', { name: '右側欄' });
    expect(within(dialog).getByRole('tab').textContent).toBe('改動 · s7.ts 等 2 個');
    // 窄螢幕沒有停靠的那一欄，開關鈕不指向它。
    expect(
      screen.getByRole('button', { name: '收起右側欄' }).getAttribute('aria-controls'),
    ).toBeNull();

    fireEvent.keyDown(dialog, { key: 'Escape' });
    await act(async () => {});
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(saved()?.open).toBe(false);

    await click(screen.getByRole('button', { name: '打開右側欄' }));
    expect(within(screen.getByRole('dialog')).getByRole('tab').textContent).toBe(
      '改動 · s7.ts 等 2 個',
    );
  });

  it('載入時一律從收起開始，不照存下來的「開著」蓋住對話', async () => {
    localStorage.setItem(
      LAYOUT_KEY_PREFIX + 't',
      JSON.stringify(openTab(EMPTY_LAYOUT, { kind: 'changes', seq: 7, index: 0 })),
    );
    await mount();
    expect(screen.queryByRole('dialog')).toBeNull();
    await click(screen.getByRole('button', { name: '打開右側欄' }));
    expect(within(screen.getByRole('dialog')).getByRole('tab')).toBeTruthy();
  });

  it('axe：覆蓋模式', async () => {
    await mount();
    await click(cardHeader(7));
    expect(await axeViolations(document.body)).toEqual([]);
  });
});

it('axe：停靠、兩種分頁、亮與暗', async () => {
  await mount();
  await click(cardHeader(7));
  await click(screen.getByRole('button', { name: '預覽：out/report.md' }));
  await screen.findByText('報告內容');
  expect(await axeViolations(document.body)).toEqual([]);
  document.documentElement.classList.add('dark');
  expect(await axeViolations(document.body)).toEqual([]);
});
