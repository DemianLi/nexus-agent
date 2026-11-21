import { describe, expect, it } from 'vitest';
import { percentile, reportTriggers, summarize, wFormula } from './host-kill-stats.js';

describe('host-kill-stats', () => {
  it('percentile 是 nearest-rank', () => {
    const xs = Array.from({ length: 30 }, (_, i) => i + 1);
    expect(percentile(xs, 50)).toBe(15);
    expect(percentile(xs, 95)).toBe(29);
    expect(percentile([], 50)).toBeNaN();
  });

  it('W 有 5 秒下限，超過就是最大值 × 1.5 進位到整秒', () => {
    expect(wFormula([1200])).toBe(5000);
    expect(wFormula([3000, 2000])).toBe(5000);
    expect(wFormula([3100])).toBe(5000);
    expect(wFormula([4000])).toBe(6000);
    expect(wFormula([4100, 1000])).toBe(7000);
  });

  it('回報條件：相加最大值、p95、沒恢復、兩架構差一倍', () => {
    const ok = summarize('a', [{ aMs: 800, bMs: 100, backoffMs: 1000 }], 1);
    expect(reportTriggers([ok])).toEqual([]);
    const slow = summarize('b', [{ aMs: 2500, bMs: 700, backoffMs: undefined }], 2);
    const triggers = reportTriggers([ok, slow]);
    expect(triggers.some((t) => t.includes('超過 3000'))).toBe(true);
    expect(triggers.some((t) => t.includes('p95'))).toBe(true);
    expect(triggers.some((t) => t.includes('沒有取得有效樣本'))).toBe(true);
    expect(triggers.some((t) => t.includes('差一倍'))).toBe(true);
  });
});
