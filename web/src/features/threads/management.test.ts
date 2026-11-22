import type { ThreadSummary } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import {
  daysLeft,
  explainArchiveStop,
  explainThreadFailure,
  normalizeTitle,
  readSets,
  splitThreads,
} from '@/features/threads/management';

const thread = (threadId: string): ThreadSummary => ({
  threadId,
  updatedAt: 0,
  running: false,
  blank: false,
  title: threadId,
});
const ITEMS = ['a', 'b', 'c', 'd'].map(thread);
const ids = (items: readonly ThreadSummary[]) => items.map((item) => item.threadId);

describe('readSets', () => {
  it('兩格都有才算 server 支援，回整份；順序不動', () => {
    expect(
      readSets({ items: [], unreadable: 0, pinnedThreadIds: ['b', 'a'], archivedThreadIds: ['c'] }),
    ).toEqual({
      pinned: ['b', 'a'],
      archived: ['c'],
    });
  });

  it('缺一格、都沒有、沒有列表：當沒有', () => {
    expect(readSets({ items: [], unreadable: 0, pinnedThreadIds: [] })).toBeUndefined();
    expect(readSets({ items: [], unreadable: 0, archivedThreadIds: [] })).toBeUndefined();
    expect(readSets({ items: [], unreadable: 0 })).toBeUndefined();
    expect(readSets(undefined)).toBeUndefined();
  });
});

describe('explainThreadFailure', () => {
  it('四個碼各一句人話；標題不合法優先用 server 的說明', () => {
    expect(explainThreadFailure({ code: 'thread_not_found' })).toContain('找不到');
    expect(explainThreadFailure({ code: 'thread_archived' })).toBe('封存的會話不能釘選。');
    expect(explainThreadFailure({ code: 'thread_active' })).toContain('還在跑');
    expect(explainThreadFailure({ code: 'title_invalid', message: '太長了' })).toBe('太長了');
    expect(explainThreadFailure({ code: 'title_invalid' })).toBe('這個標題不合法。');
    expect(explainThreadFailure({ code: '別的碼' })).toBe('這個動作沒成功。');
  });
});

describe('splitThreads', () => {
  it('釘選的照 pinnedIds 的順序（最近釘的在前），其餘保持清單的順序', () => {
    const sections = splitThreads(ITEMS, ['c', 'a'], new Set());
    expect(ids(sections.pinned)).toEqual(['c', 'a']);
    expect(ids(sections.rest)).toEqual(['b', 'd']);
    expect(sections.archived).toEqual([]);
  });

  it('封存的單獨一份；同時在釘選裡也算封存（封存的不能釘）', () => {
    const sections = splitThreads(ITEMS, ['a', 'b'], new Set(['b', 'd']));
    expect(ids(sections.pinned)).toEqual(['a']);
    expect(ids(sections.rest)).toEqual(['c']);
    expect(ids(sections.archived)).toEqual(['b', 'd']);
  });

  it('集合裡有、清單上沒有的 id 略過（別的瀏覽器釘過、這份清單被搜尋濾掉）', () => {
    const sections = splitThreads([thread('a')], ['ghost', 'a'], new Set(['ghost2']));
    expect(ids(sections.pinned)).toEqual(['a']);
    expect(sections.rest).toEqual([]);
    expect(sections.archived).toEqual([]);
  });

  it('什麼都沒設：全部在其餘', () => {
    const sections = splitThreads(ITEMS, [], new Set());
    expect(ids(sections.rest)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('normalizeTitle', () => {
  it('頭尾空白拿掉、連續空白併成一個；空的回 undefined', () => {
    expect(normalizeTitle('  改   登入頁 \n')).toBe('改 登入頁');
    expect(normalizeTitle('   ')).toBeUndefined();
    expect(normalizeTitle('')).toBeUndefined();
  });
});

describe('explainArchiveStop（#633）：封存還在跑的會話前，確認框講封存會停掉哪些事', () => {
  it.each([
    [['turn'], '正在回答。'],
    [['subagent'], '還有背景子代理在跑。'],
    [['turn', 'subagent'], '正在回答，背景子代理也還在跑。'],
    [[], '正在執行。'],
  ] as const)('%j', (activity, text) => {
    expect(explainArchiveStop(activity)).toBe(text);
  });
});

describe('刪除與復原的失敗（#2958）', () => {
  it.each([
    ['thread_busy', '這條會話另一件事還沒做完，稍後再試。'],
    ['thread_deleted', '這條會話已經刪掉了。'],
    ['thread_not_deleted', '這條會話不在最近刪除裡（可能已經復原了）。'],
    ['restore_expired', '已經過了寬限期，不能復原。'],
    ['restore_conflict', '原處已經有同一條會話，沒有復原。'],
  ])('%s', (code, text) => {
    expect(explainThreadFailure({ code })).toBe(text);
  });
});

describe('daysLeft（#2958）：最近刪除每列寫的「還剩 N 天」', () => {
  const DAY = 24 * 60 * 60 * 1000;
  it.each([
    ['剛好三天', 3 * DAY, 3],
    ['三天多一毫秒', 3 * DAY + 1, 4],
    ['只剩一毫秒', 1, 1],
    ['剛好到期', 0, 0],
    ['過期了', -DAY, 0],
  ])('%s', (_case, left, days) => {
    expect(daysLeft(1_000_000 + left, 1_000_000)).toBe(days);
  });
});
