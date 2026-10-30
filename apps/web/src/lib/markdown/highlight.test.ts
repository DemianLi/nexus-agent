import { describe, expect, it } from 'vitest';

import {
  HIGHLIGHT_BUDGET_MS,
  HIGHLIGHT_LINE_MAX_CHARS,
  highlightLines,
  highlightToHtml,
  StreamingHighlightSession,
} from '@/lib/markdown/highlight';

const longLine = (extra = 0) => `var s="${'x'.repeat(HIGHLIGHT_LINE_MAX_CHARS + extra)}";`;
// 每 4 行一段：註解從第 4 行跨到第 5 行、樣板字串從第 8 行跨到第 9 行，兩個都跨過段的邊界。
const sample = [
  'const a = 1;',
  'const b = 2;',
  'const c = 3;',
  '/* 跨行',
  '註解 */',
  'const x = 1;',
  'const y = 2;',
  'const d = `一',
  '二`;',
  'function f(b) { return b + 1; }',
  '',
].join('\n');

describe('highlightLines 的長行上限與時間預算（#992）', () => {
  it('分段高亮的結果與整段一次高亮相同（含跨行的註解與樣板字串）', () => {
    const whole = new StreamingHighlightSession().update(sample, 'ts');
    // 預算傳無限大：這條比分段的結果，真時鐘在負載高時可能超過預算、回傳的行數變少，斷言就紅。超過預算的行為由下面注入時鐘的那條釘。
    expect(highlightLines(sample, 'ts', { budgetMs: Number.POSITIVE_INFINITY })).toEqual(
      whole?.slice(0, -1),
    );
  });

  it('一行達到上限：那一行畫成沒有顏色的一段，前後的行照常上色', () => {
    const lines = highlightLines(`const a = 1;\n${longLine()}\nconst b = 2;`, 'ts');
    expect(lines).toHaveLength(3);
    expect(lines?.[1]).toHaveLength(1);
    expect(lines?.[1]?.[0]?.style.color).toBe('');
    expect(lines?.[0]?.length).toBeGreaterThan(1);
    expect(lines?.[2]).toEqual(highlightLines('const b = 2;', 'ts')?.[0]);
  });

  it('剛好少一個字元的行仍然上色', () => {
    const body = 'x'.repeat(HIGHLIGHT_LINE_MAX_CHARS - 'var s="";'.length - 1);
    const line = `var s="${body}";`;
    expect(line.length).toBe(HIGHLIGHT_LINE_MAX_CHARS - 1);
    expect(highlightLines(line, 'ts')?.[0]?.length).toBeGreaterThan(1);
  });

  it('超過預算就停：回傳的陣列比行數短，沒輪到的行沒有那一筆', () => {
    const source = Array.from({ length: 40 }, (_, at) => `const v${at} = ${at};`);
    let clock = 0;
    const lines = highlightLines(source.join('\n'), 'ts', {
      budgetMs: 10,
      now: () => (clock += 6),
    });
    // 每次檢查過 6 ms：畫完 4 行累計 6、畫完 8 行累計 12 超過預算 10，第三段沒輪到。
    expect(lines).toEqual(
      highlightLines(source.slice(0, 8).join('\n'), 'ts', { budgetMs: Number.POSITIVE_INFINITY }),
    );
  });

  it('累計剛好等於預算還不算超過', () => {
    const code = Array.from({ length: 40 }, (_, at) => `const v${at} = ${at};`).join('\n');
    let clock = 0;
    const lines = highlightLines(code, 'ts', { budgetMs: 10, now: () => (clock += 5) });
    expect(lines).toHaveLength(12);
  });

  it('預算夠就全部上色；第一段不受預算影響', () => {
    const code = Array.from({ length: 40 }, (_, at) => `const v${at} = ${at};`).join('\n');
    expect(highlightLines(code, 'ts', { budgetMs: Number.POSITIVE_INFINITY })).toHaveLength(40);
    expect(highlightLines(code, 'ts', { budgetMs: -1 })?.length).toBeGreaterThan(0);
  });

  describe('預算的預設值', () => {
    const code = Array.from(
      { length: 1250 },
      (_, at) => `  const value${at} = compute(${at});`,
    ).join('\n');
    /** 每 4 行檢查一次，第一段不檢查：1,250 行檢查 312 次。 */
    const CHECKS = 312;
    /** 時鐘把 `totalMs` 平均分給每次檢查。 */
    const clockSpending = (totalMs: number) => {
      let clock = 0;
      return () => (clock += totalMs / CHECKS);
    };

    it('夠一頁普通程式碼（1,250 行實測約 134 ms）上色', () => {
      expect(highlightLines(code, 'ts', { now: clockSpending(134) })).toHaveLength(1250);
    });

    it('超過預設值就停', () => {
      // 平均分攤 151 ms：第 310 次檢查才過 150 ms，那時畫完 1,240 行。
      const now = clockSpending(HIGHLIGHT_BUDGET_MS + 1);
      expect(highlightLines(code, 'ts', { now })).toHaveLength(1240);
    });
  });
});

describe('另外兩條高亮路徑也有長行上限（#992）', () => {
  it('fence：超長的一行不上色，HTML 的段數不隨字數成長', () => {
    const html = highlightToHtml(longLine(4_000), 'ts') ?? '';
    expect(html.length).toBeLessThan(HIGHLIGHT_LINE_MAX_CHARS * 6);
    expect((html.match(/<span/g) ?? []).length).toBeLessThanOrEqual(3);
  });

  it('串流：超長的一行不上色，其他行不受影響', () => {
    const lines = new StreamingHighlightSession().update(
      `const a = 1;\n${longLine()}\nconst b = 2;\n`,
      'ts',
    );
    expect(lines?.[1]).toHaveLength(1);
    expect(lines?.[0]?.length).toBeGreaterThan(1);
  });
});
