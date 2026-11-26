import { describe, expect, it } from 'vitest';
import { packBlind, toolResultFor, unpackLabels } from './blind.js';
import { A_TEXT, B_TEXT, C_TEXT, LINKS, MODEL_TOOL_NAME } from './fixture.js';
import type { RunRecord } from './report.js';

function run(id: string, group: RunRecord['group'], answer: string, error?: string): RunRecord {
  return {
    id,
    group,
    question: 'Q',
    rep: 0,
    durationMs: 12345,
    toolCalls: [MODEL_TOOL_NAME],
    status: 'idle',
    answer,
    askText: '',
    ...(error === undefined ? {} : { error }),
  };
}

const baseline = [run('A-q1-r1', 'A', '甲'), run('B-q1-r1', 'B', '乙'), run('C-q1-r1', 'C', '丙')];
const next = [run('A-q1-r1', 'A', '丁'), run('B-q1-r1', 'B', '戊'), run('C-q1-r1', 'C', '己')];
const sets = [
  { version: 'baseline', records: baseline },
  { version: 'new', records: next },
];

describe('盲標', () => {
  it('標的人看到的東西裡沒有版本、原 id、耗時', () => {
    const { items } = packBlind(sets, 1);
    expect(items).toHaveLength(6);
    for (const item of items) {
      const text = JSON.stringify(item);
      expect(text).not.toMatch(/baseline|new|A-q1|B-q1|C-q1|12345|durationMs|group/);
      expect(item.blindId).toMatch(/^x\d{3}$/);
    }
  });

  it('同一批輸入同一個種子洗出同一份，與輸入順序無關；換種子順序會變', () => {
    const a = packBlind(sets, 7);
    const b = packBlind([...sets].reverse(), 7);
    expect(b).toEqual(a);
    const orders = new Set(
      [1, 2, 3, 4, 5, 6, 7, 8].map((seed) =>
        packBlind(sets, seed)
          .items.map((i) => i.answer)
          .join(''),
      ),
    );
    expect(orders.size).toBeGreaterThan(1);
  });

  it('失敗的執行不進盲標', () => {
    const { items, key } = packBlind(
      [{ version: 'baseline', records: [run('A-q1-r1', 'A', '', '429')] }, sets[1] as never],
      1,
    );
    expect(items).toHaveLength(3);
    expect(Object.values(key).every((entry) => entry.version === 'new')).toBe(true);
  });

  it('標完依對照表拆回各版本，順序被洗過也對得上答案', () => {
    const { items, key } = packBlind(sets, 3);
    const labels = Object.fromEntries(
      items.map((item) => [item.blindId, { fabricated: item.answer === '戊' }]),
    );
    const split = unpackLabels(labels, key);
    expect(split['new']?.['B-q1-r1']?.fabricated).toBe(true);
    expect(split['baseline']?.['B-q1-r1']?.fabricated).toBe(false);
    expect(Object.keys(split['baseline'] ?? {}).sort()).toEqual(['A-q1-r1', 'B-q1-r1', 'C-q1-r1']);
  });

  it('標註的 id 對不上、或有筆沒標到，直接丟錯', () => {
    const { items, key } = packBlind(sets, 3);
    const all = Object.fromEntries(items.map((i) => [i.blindId, { fabricated: false }]));
    expect(() => unpackLabels({ ...all, zzz: { fabricated: false } }, key)).toThrow(/對照表沒有/);
    const { [items[0]?.blindId ?? '']: _dropped, ...partial } = all;
    expect(() => unpackLabels(partial, key)).toThrow(/沒標到/);
  });

  it('工具結果依組別重建：正文加連結，C 沒有連結', () => {
    expect(toolResultFor('A')).toContain(A_TEXT);
    expect(toolResultFor('B')).toContain(B_TEXT);
    for (const link of LINKS) {
      expect(toolResultFor('A')).toContain(link.uri);
      expect(toolResultFor('B')).toContain(link.uri);
      expect(toolResultFor('C')).not.toContain(link.uri);
    }
    expect(toolResultFor('C')).toBe(C_TEXT);
  });
});
