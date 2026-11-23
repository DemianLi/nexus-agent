/**
 * 壓縮的 `custom` frame 怎麼折（[#896](https://github.com/DemianLi/nexus-agent/issues/896)）。
 *
 * 兩條路產出同一種 frame 的那一半在 `apps/harness/src/compaction-wire.test.ts`；這裡只管折疊器：每一顆長一格、
 * 落在串流裡的位置、同一個 `seq` 只長一格、形狀不對整顆不收、往前翻頁原樣接上。
 */

import { describe, expect, it } from 'vitest';

import { COMPACTION } from './compaction.js';
import { emptyConversation, prependEntries, reduceAll } from './conversation.js';
import type { CompactionEntry } from './conversation.js';
import type { Event } from './protocol.js';

const frame = (data: unknown): Event =>
  ({
    type: 'event',
    method: 'custom',
    params: { namespace: [], timestamp: 0, data },
  }) as Event;

const compaction = (payload: unknown, name: string = COMPACTION): Event => frame({ name, payload });

const fold = (...frames: Event[]) => reduceAll(emptyConversation(), frames).entries;

describe('compaction', () => {
  it('一顆長一格，帶著前 N 則、有沒有存檔與摘要', () => {
    expect(fold(compaction({ seq: 12, cutoff: 5, saved: true, summary: '摘要' }))).toEqual([
      { kind: 'compaction', id: 'compaction:12', seq: 12, cutoff: 5, saved: true, summary: '摘要' },
    ]);
  });

  it('沒有摘要的就沒有這一欄；摘要不是字串也不拿它擋整顆', () => {
    for (const summary of [undefined, 3, null]) {
      const [entry] = fold(compaction({ seq: 1, cutoff: 2, saved: false, summary }));
      expect(entry).toEqual({
        kind: 'compaction',
        id: 'compaction:1',
        seq: 1,
        cutoff: 2,
        saved: false,
      });
      expect('summary' in (entry as CompactionEntry)).toBe(false);
    }
  });

  it('多顆照收到的先後排，同一個 seq 只長一格', () => {
    const entries = fold(
      compaction({ seq: 4, cutoff: 3, saved: true }),
      compaction({ seq: 9, cutoff: 8, saved: true }),
      compaction({ seq: 4, cutoff: 3, saved: true }),
    );
    expect(entries.map((entry) => entry.id)).toEqual(['compaction:4', 'compaction:9']);
  });

  it('形狀不對整顆不收', () => {
    const bad = [
      {},
      { seq: -1, cutoff: 1, saved: true },
      { seq: 1.5, cutoff: 1, saved: true },
      { seq: 1, cutoff: -1, saved: true },
      { seq: 1, cutoff: '3', saved: true },
      { seq: 1, cutoff: 3, saved: 'yes' },
      { seq: 1, cutoff: 3 },
    ];
    for (const payload of bad) expect(fold(compaction(payload))).toEqual([]);
  });

  it('別的名字不進來', () => {
    expect(fold(compaction({ seq: 1, cutoff: 1, saved: true }, 'compaction/summary'))).toEqual([]);
  });

  it('往前翻頁原樣接在更早的格後面', () => {
    const later = reduceAll(emptyConversation(), [compaction({ seq: 9, cutoff: 8, saved: true })]);
    const earlier = reduceAll(emptyConversation(), [
      compaction({ seq: 4, cutoff: 3, saved: true }),
    ]);
    expect(prependEntries(later, earlier).entries.map((entry) => entry.id)).toEqual([
      'compaction:4',
      'compaction:9',
    ]);
  });
});
