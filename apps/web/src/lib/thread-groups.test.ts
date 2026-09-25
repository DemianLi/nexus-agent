// @vitest-environment node
import type { ThreadSummary } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { bucketOf, filterThreads, groupThreads } from '@/lib/thread-groups';

/** 以前的會話的分組與搜尋（inventory 列 6）。分界是當地的日曆日，所以時間都用當地的 `Date` 建。 */

const at = (y: number, m: number, d: number, h = 12, min = 0) =>
  new Date(y, m - 1, d, h, min).getTime();
const NOW = at(2026, 9, 25, 9, 30);

function thread(
  threadId: string,
  updatedAt: number,
  extra: Partial<ThreadSummary> = {},
): ThreadSummary {
  return { threadId, updatedAt, running: false, blank: false, title: threadId, ...extra };
}

describe('bucketOf', () => {
  it.each([
    ['今天零點', at(2026, 9, 25, 0, 0), 'today'],
    ['比現在晚（時鐘比列表舊）', at(2026, 9, 25, 23, 0), 'today'],
    ['昨天最後一分鐘', at(2026, 9, 24, 23, 59), 'yesterday'],
    ['昨天零點', at(2026, 9, 24, 0, 0), 'yesterday'],
    ['前天', at(2026, 9, 23, 23, 59), 'week'],
    ['第 7 天', at(2026, 9, 18, 0, 0), 'week'],
    ['第 8 天', at(2026, 9, 17, 23, 59), 'older'],
  ] as const)('%s → %s', (_, updatedAt, bucket) => {
    expect(bucketOf(updatedAt, NOW)).toBe(bucket);
  });

  it('跨月、跨年照日曆日算', () => {
    expect(bucketOf(at(2026, 2, 28, 23), at(2026, 3, 1, 1))).toBe('yesterday');
    expect(bucketOf(at(2025, 12, 31, 23), at(2026, 1, 1, 0, 5))).toBe('yesterday');
  });
});

describe('groupThreads', () => {
  it('空白那一列排在最前面、不進分組；組照今天到更早，組內保持原順序；沒有列的組不出現', () => {
    const items = [
      thread('新的', at(2026, 9, 25, 9), { blank: true, title: undefined }),
      thread('今天 B', at(2026, 9, 25, 8)),
      thread('今天 A', at(2026, 9, 25, 7)),
      thread('上週', at(2026, 9, 20)),
      thread('很久以前', at(2026, 1, 1)),
    ];
    const { blank, groups } = groupThreads(items, NOW);
    expect(blank.map((item) => item.threadId)).toEqual(['新的']);
    expect(groups.map((group) => [group.bucket, group.items.map((item) => item.threadId)])).toEqual(
      [
        ['today', ['今天 B', '今天 A']],
        ['week', ['上週']],
        ['older', ['很久以前']],
      ],
    );
  });
});

describe('filterThreads', () => {
  const items = [
    thread('a', 3, { title: '幫我改 Login 頁' }),
    thread('b', 2, { title: undefined }),
    thread('c', 1, { blank: true, title: undefined }),
  ];

  it('空字串或只有空白時原樣回', () => {
    expect(filterThreads(items, '')).toBe(items);
    expect(filterThreads(items, '   ')).toBe(items);
  });

  it('不分大小寫、比子字串、前後空白不算', () => {
    expect(filterThreads(items, ' login ').map((item) => item.threadId)).toEqual(['a']);
    expect(filterThreads(items, '改').map((item) => item.threadId)).toEqual(['a']);
  });

  it('沒有標題的列搜尋時不列：畫面上那一句是說明，不是標題', () => {
    expect(filterThreads(items, '新會話')).toEqual([]);
    expect(filterThreads(items, '目標')).toEqual([]);
  });
});
