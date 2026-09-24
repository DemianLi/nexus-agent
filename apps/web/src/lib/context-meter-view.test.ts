import type { WireContextMeasure } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { compact, contextMeterLabel, contextMeterView } from '@/lib/context-meter-view';

/**
 * 用量表的算法（#528）。數字刻意不用出廠的 100000／60：寫死預設值的話這裡要紅；兩道門檻的比例也刻意不同，
 * `approxTokens` 與 `messageCount` 對調的話這裡要紅。
 */

function measure(
  approxTokens: number,
  messageCount: number,
  thresholds: WireContextMeasure['thresholds'],
): WireContextMeasure {
  return { approxTokens, messageCount, thresholds };
}

describe('contextMeterView', () => {
  it('沒有 measure 就不畫：null，或只有供應商報的 inputTokens（摘要被關掉）', () => {
    expect(contextMeterView(null)).toBeNull();
    expect(contextMeterView({ inputTokens: 7 })).toBeNull();
  });

  it('tokens 比 approxTokens、messages 比 messageCount，環取比例最高的那道', () => {
    // tokens：5/10 = 50%；messages：3/4 = 75%。兩個分子對調的話是 3/10 與 5/4，百分比與兩行的字都會變。
    const view = contextMeterView({
      measure: measure(5, 3, [
        { type: 'tokens', value: 10 },
        { type: 'messages', value: 4 },
      ]),
    });
    expect(view?.percent).toBe(75);
    expect(view?.ratio).toBe(0.75);
    expect(view?.rows.map((row) => [row.type, row.text, row.nearest])).toEqual([
      ['tokens', '約 5／10 token', false],
      ['messages', '3／4 則', true],
    ]);
  });

  it('tokens 那道比較近時由它量', () => {
    const view = contextMeterView({
      measure: measure(9, 1, [
        { type: 'tokens', value: 10 },
        { type: 'messages', value: 4 },
      ]),
    });
    expect(view?.percent).toBe(90);
    expect(view?.rows.map((row) => row.nearest)).toEqual([true, false]);
  });

  it('門檻有幾道就列幾道，照設定的順序；同一種也可以有兩道；同分取排前面的', () => {
    const view = contextMeterView({
      measure: measure(6, 2, [
        { type: 'messages', value: 8 },
        { type: 'tokens', value: 12 },
        { type: 'tokens', value: 30 },
        { type: 'messages', value: 4 },
      ]),
    });
    expect(view?.rows.map((row) => [row.text, row.nearest])).toEqual([
      ['2／8 則', false],
      ['約 6／12 token', true],
      ['約 6／30 token', false],
      ['2／4 則', false],
    ]);
  });

  it('百分比無條件捨去：差一點點到門檻不會顯示 100%', () => {
    const view = contextMeterView({
      measure: measure(999, 0, [{ type: 'tokens', value: 1000 }]),
    });
    expect(view?.percent).toBe(99);
  });

  it('超過門檻時環停在滿格、百分比停在 100', () => {
    const view = contextMeterView({ measure: measure(0, 7, [{ type: 'messages', value: 5 }]) });
    expect(view?.ratio).toBe(1);
    expect(view?.percent).toBe(100);
    expect(view?.warning).toBe(true);
  });

  it('80% 以上（含）變警示色', () => {
    const at = (count: number) =>
      contextMeterView({ measure: measure(0, count, [{ type: 'messages', value: 100 }]) })?.warning;
    expect(at(79)).toBe(false);
    expect(at(80)).toBe(true);
  });

  it('「目前大小」只在收過 model/usage 時才有，千分位', () => {
    const only = measure(1, 1, [{ type: 'messages', value: 4 }]);
    expect(contextMeterView({ measure: only })?.inputTokens).toBeUndefined();
    expect(contextMeterView({ measure: only, inputTokens: 12345 })?.inputTokens).toBe(
      '12,345 token',
    );
  });

  it('按鈕名稱原樣帶著畫面上的「約 N%」', () => {
    const view = contextMeterView({ measure: measure(0, 3, [{ type: 'messages', value: 7 }]) });
    expect(view && contextMeterLabel(view)).toBe('對話用量：約 42%，點開看明細');
  });
});

describe('compact', () => {
  it.each([
    [950, '950'],
    [1000, '1k'],
    [8123, '8.1k'],
    [9960, '10k'],
    [42123, '42k'],
    [100000, '100k'],
    [999499, '999k'],
    [999999, '1M'],
    [1000000, '1M'],
    [1500000, '1.5M'],
    [25000000, '25M'],
  ])('%d → %s', (count, text) => {
    expect(compact(count)).toBe(text);
  });
});
