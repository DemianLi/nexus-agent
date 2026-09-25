import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PANEL_WIDTH,
  EMPTY_LAYOUT,
  LAYOUT_KEY_PREFIX,
  MAX_REMEMBERED_THREADS,
  MIN_PANEL_WIDTH,
  RECENT_KEY,
  WIDTH_KEY,
  clampPanelWidth,
  closeTab,
  openTab,
  parseLayout,
  readLayout,
  readWidth,
  selectTab,
  setChangesIndex,
  tabKey,
  writeLayout,
  writeWidth,
} from '@/lib/right-sidebar';
import type { SidebarLayout, SidebarTab } from '@/lib/right-sidebar';
import { memoryStorage } from '@/test/right-sidebar';

const changes = (seq: number, index = 0): SidebarTab => ({ kind: 'changes', seq, index });
const deliverable = (seq: number, index: number, path = 'out/a.md'): SidebarTab => ({
  kind: 'deliverable',
  file: { path, seq, index },
});

const keys = (layout: SidebarLayout) => layout.tabs.map(tabKey);

describe('開分頁', () => {
  it('沒開過就接在最後、選中它、面板展開', () => {
    const layout = openTab(openTab(EMPTY_LAYOUT, changes(7)), deliverable(9, 0));
    expect(keys(layout)).toEqual(['changes:7', 'deliverable:9:0']);
    expect(layout.active).toBe('deliverable:9:0');
    expect(layout.open).toBe(true);
  });

  it('同一輪的改動再開是同一個分頁，換成新的檔（#640 決定 8）', () => {
    const layout = openTab(
      openTab(openTab(EMPTY_LAYOUT, changes(7, 0)), changes(8)),
      changes(7, 3),
    );
    expect(keys(layout)).toEqual(['changes:7', 'changes:8']);
    expect(layout.tabs[0]).toEqual(changes(7, 3));
    expect(layout.active).toBe('changes:7');
  });

  it('交付按 (seq, index) 去重：不同輪的同名檔是兩個分頁（決定 9）', () => {
    const layout = [
      deliverable(9, 0),
      deliverable(9, 0),
      deliverable(12, 0),
      deliverable(9, 1),
    ].reduce(openTab, EMPTY_LAYOUT);
    expect(keys(layout)).toEqual(['deliverable:9:0', 'deliverable:12:0', 'deliverable:9:1']);
  });

  it('收起時開分頁會展開', () => {
    const layout = openTab({ ...openTab(EMPTY_LAYOUT, changes(1)), open: false }, changes(1));
    expect(layout.open).toBe(true);
  });
});

describe('關分頁', () => {
  const three = [changes(1), changes(2), changes(3)].reduce(openTab, EMPTY_LAYOUT);

  it('關掉選中的那個，選它右邊那個；沒有右邊就選左邊', () => {
    const middle = closeTab(selectTab(three, 'changes:2'), 'changes:2');
    expect(keys(middle)).toEqual(['changes:1', 'changes:3']);
    expect(middle.active).toBe('changes:3');
    const last = closeTab(three, 'changes:3');
    expect(last.active).toBe('changes:2');
  });

  it('關掉沒選中的那個，選中的不變', () => {
    expect(closeTab(three, 'changes:1').active).toBe('changes:3');
  });

  it('最後一個關掉之後沒有選中的，面板不跟著收（顯示空狀態）', () => {
    const empty = closeTab(openTab(EMPTY_LAYOUT, changes(1)), 'changes:1');
    expect(empty.tabs).toEqual([]);
    expect(empty.active).toBeUndefined();
    expect(empty.open).toBe(true);
  });

  it('改動分頁換檔只動那一輪', () => {
    const layout = setChangesIndex(three, 2, 5);
    expect(layout.tabs.map((tab) => (tab.kind === 'changes' ? tab.index : -1))).toEqual([0, 5, 0]);
  });
});

describe('存下來的版面', () => {
  const layout: SidebarLayout = {
    open: true,
    tabs: [
      changes(7, 2),
      { kind: 'deliverable', file: { path: 'a.md', description: '報告', seq: 9, index: 1 } },
    ],
    active: 'deliverable:9:1',
  };

  it('寫進去讀得回來', () => {
    expect(parseLayout(JSON.parse(JSON.stringify(layout)))).toEqual(layout);
  });

  it.each([
    ['不是物件', 'x'],
    ['少了 open', { tabs: [], active: undefined }],
    ['認不得的 kind', { open: true, tabs: [{ kind: 'terminal' }], active: 'terminal' }],
    [
      '座標不是非負整數',
      { open: true, tabs: [{ kind: 'changes', seq: -1, index: 0 }], active: 'changes:-1' },
    ],
    [
      '說明不是字串',
      {
        ...layout,
        tabs: [{ kind: 'deliverable', file: { path: 'a', description: 3, seq: 1, index: 0 } }],
        active: 'deliverable:1:0',
      },
    ],
    ['同一個分頁兩次', { open: true, tabs: [changes(1), changes(1)], active: 'changes:1' }],
    ['選中的不在分頁裡', { open: true, tabs: [changes(1)], active: 'changes:2' }],
    ['有分頁卻沒有選中的', { open: true, tabs: [changes(1)] }],
  ])('%s：整份不信', (_name, value) => {
    expect(parseLayout(value)).toBeUndefined();
  });
});

describe('localStorage', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('一條會話一個鍵；沒記過是空的', () => {
    const layout = openTab(EMPTY_LAYOUT, changes(3));
    writeLayout('a', layout);
    expect(readLayout('a')).toEqual(layout);
    expect(readLayout('b')).toEqual(EMPTY_LAYOUT);
    expect(localStorage.getItem(LAYOUT_KEY_PREFIX + 'a')).not.toBeNull();
  });

  it(`只記最近用過的 ${MAX_REMEMBERED_THREADS} 條，超過就清掉最舊的`, () => {
    const layout = openTab(EMPTY_LAYOUT, changes(1));
    for (let at = 0; at <= MAX_REMEMBERED_THREADS; at += 1) writeLayout(`t${at}`, layout);
    expect(readLayout('t0')).toEqual(EMPTY_LAYOUT);
    expect(localStorage.getItem(LAYOUT_KEY_PREFIX + 't0')).toBeNull();
    expect(readLayout('t1')).toEqual(layout);
    const recent = JSON.parse(localStorage.getItem(RECENT_KEY)!) as string[];
    expect(recent).toHaveLength(MAX_REMEMBERED_THREADS);
    expect(recent[0]).toBe(`t${MAX_REMEMBERED_THREADS}`);
  });

  it('再用一次舊的那條，它排回最前面，不會被清掉', () => {
    const layout = openTab(EMPTY_LAYOUT, changes(1));
    for (let at = 0; at < MAX_REMEMBERED_THREADS; at += 1) writeLayout(`t${at}`, layout);
    writeLayout('t0', layout);
    writeLayout('new', layout);
    expect(readLayout('t0')).toEqual(layout);
    expect(readLayout('t1')).toEqual(EMPTY_LAYOUT);
  });

  it('存的東西壞了就當沒有', () => {
    localStorage.setItem(LAYOUT_KEY_PREFIX + 'a', '{not json');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(readLayout('a')).toEqual(EMPTY_LAYOUT);
  });

  it('瀏覽器擋掉：讀是空的、寫不拋', () => {
    const blocked = memoryStorage();
    blocked.getItem = () => {
      throw new Error('SecurityError');
    };
    blocked.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    vi.stubGlobal('localStorage', blocked);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(readLayout('a')).toEqual(EMPTY_LAYOUT);
    expect(() => writeLayout('a', openTab(EMPTY_LAYOUT, changes(1)))).not.toThrow();
    expect(readWidth()).toBe(DEFAULT_PANEL_WIDTH);
    expect(() => writeWidth(400)).not.toThrow();
  });

  it('寬度：記得住；比下限還窄或不是數字就用預設值', () => {
    writeWidth(612);
    expect(readWidth()).toBe(612);
    localStorage.setItem(WIDTH_KEY, JSON.stringify(MIN_PANEL_WIDTH - 1));
    expect(readWidth()).toBe(DEFAULT_PANEL_WIDTH);
    localStorage.setItem(WIDTH_KEY, '"wide"');
    expect(readWidth()).toBe(DEFAULT_PANEL_WIDTH);
  });
});

describe('拖寬的夾限', () => {
  it('面板至少 320、會話區至少留 480', () => {
    expect(clampPanelWidth(100, 1400)).toBe(MIN_PANEL_WIDTH);
    expect(clampPanelWidth(1200, 1400)).toBe(920);
    expect(clampPanelWidth(600, 1400)).toBe(600);
  });

  it('兩個下限放不下時面板的下限優先', () => {
    // 1024 寬、左側欄展開：會話區加面板只有 768。
    expect(clampPanelWidth(560, 768)).toBe(MIN_PANEL_WIDTH);
  });
});
