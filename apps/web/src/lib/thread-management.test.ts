import type { ThreadSummary } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { normalizeTitle, splitThreads, threadManagementEnabled } from '@/lib/thread-management';

const thread = (threadId: string): ThreadSummary => ({
  threadId,
  updatedAt: 0,
  running: false,
  blank: false,
  title: threadId,
});
const ITEMS = ['a', 'b', 'c', 'd'].map(thread);
const ids = (items: readonly ThreadSummary[]) => items.map((item) => item.threadId);

describe('開關', () => {
  it('今天是關的：伺服器端還沒接上（#633）', () => {
    expect(threadManagementEnabled()).toBe(false);
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
