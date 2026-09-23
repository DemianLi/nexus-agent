import { describe, expect, it } from 'vitest';

import {
  LONG_LINE_CHARS,
  ROW_CHARS,
  SEGMENT_CHARS,
  columnsOf,
  layoutOf,
  rowsOf,
  segmentsOf,
} from '@/lib/line-segments';

/**
 * 長行在畫面上怎麼切（#555）。**接起來等於原行**與**不切在字素中間**是承重的兩條：前者壞了，複製出來的就不是
 * 原檔；後者壞了，一個 emoji 會畫成兩半。
 */

/** 整條字串的字素邊界（真的整條切一次，不是窗口）。 */
function boundaries(text: string): Set<number> {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return new Set([...segmenter.segment(text)].map(({ index }) => index));
}

/** 每一段的起點（第一段是 0）。 */
function cuts(segments: readonly string[]): number[] {
  const at: number[] = [];
  let offset = 0;
  for (const segment of segments) {
    at.push(offset);
    offset += segment.length;
  }
  return at;
}

describe('segmentsOf', () => {
  it('不超過門檻的行原樣一段', () => {
    const line = 'x'.repeat(LONG_LINE_CHARS);
    expect(segmentsOf(line)).toEqual([line]);
    expect(segmentsOf('')).toEqual(['']);
  });

  it.each([
    ['minified（沒有空白）', '{"a":1}'.repeat(3000)],
    ['一般文字', 'lorem ipsum dolor sit amet '.repeat(1000)],
    ['中文', '這是一段很長的中文，沒有空白但有標點。'.repeat(1200)],
    ['裸 🏳 與旗子序列', ('abc🏳' + '🏳️‍🌈' + '👨‍👩‍👧‍👦' + '🇹🇼').repeat(1500)],
    ['組合字元', 'e\u0301'.repeat(9000)],
    ['全是 emoji、沒有任何軟斷點', '👩🏽‍💻'.repeat(3000)],
  ])('%s：接起來等於原行，而且每個切點都是字素邊界', (_, line) => {
    const segments = segmentsOf(line);
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.join('')).toBe(line);
    const legal = boundaries(line);
    for (const cut of cuts(segments)) expect(legal.has(cut)).toBe(true);
    for (const segment of segments) {
      expect(segment.length).toBeGreaterThan(0);
      expect(segment.length).toBeLessThanOrEqual(SEGMENT_CHARS + 64);
    }
  });

  it('有空白時切在空白後面，看起來像一次提早換行', () => {
    const segments = segmentsOf('word '.repeat(2000));
    for (const segment of segments.slice(0, -1)) expect(segment.endsWith(' ')).toBe(true);
  });
});

describe('rowsOf', () => {
  it('每列不超過 ROW_CHARS 字；只有一列時是一個元素', () => {
    const segment = 'x'.repeat(SEGMENT_CHARS);
    expect(rowsOf([segment, segment])).toEqual([[segment, segment]]);
    const many = Array(Math.ceil((ROW_CHARS * 2.5) / SEGMENT_CHARS)).fill(segment) as string[];
    const rows = rowsOf(many);
    expect(rows.length).toBe(3);
    for (const row of rows) expect(row.join('').length).toBeLessThanOrEqual(ROW_CHARS);
    expect(rows.flat()).toEqual(many);
  });
});

describe('columnsOf', () => {
  it.each([
    ['ascii', 'abc', 3],
    ['中文與全形標點', '中文，', 6],
    ['韓文', '한글', 4],
    ['代理對（emoji）', '🏳🙂', 4],
    ['混合', 'a中🙂', 5],
  ])('%s', (_, text, columns) => {
    expect(columnsOf(text)).toBe(columns);
  });
});

describe('layoutOf', () => {
  it('每段帶著自己的欄數；接起來等於原行', () => {
    const line = '中文 '.repeat(3000);
    const layout = layoutOf(line);
    expect(
      layout
        .flat()
        .map((segment) => segment.text)
        .join(''),
    ).toBe(line);
    for (const segment of layout.flat()) expect(segment.columns).toBe(columnsOf(segment.text));
  });
});
