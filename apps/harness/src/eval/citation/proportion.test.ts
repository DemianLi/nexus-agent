import { describe, expect, it } from 'vitest';
import { formatProportion, wilson } from './proportion.js';

describe('Wilson 區間', () => {
  it('0/20 的上界不是 0（Wald 會給 [0,0]）', () => {
    const r = wilson(0, 20);
    expect(r.low).toBe(0);
    expect(r.high).toBeCloseTo(0.1611, 3);
  });

  it('20/20 的下界不是 1', () => {
    const r = wilson(20, 20);
    expect(r.high).toBe(1);
    expect(r.low).toBeCloseTo(0.8389, 3);
  });

  it('10/20：對稱且包住 0.5', () => {
    const r = wilson(10, 20);
    expect(r.p).toBe(0.5);
    expect(r.low).toBeCloseTo(0.2993, 3);
    expect(r.high).toBeCloseTo(0.7007, 3);
  });

  it('n 越大區間越窄', () => {
    const small = wilson(5, 10);
    const large = wilson(50, 100);
    expect(large.high - large.low).toBeLessThan(small.high - small.low);
  });

  it('n 為 0 回 NaN；非法輸入拋', () => {
    expect(wilson(0, 0).p).toBeNaN();
    expect(() => wilson(3, 2)).toThrow(RangeError);
    expect(() => wilson(-1, 2)).toThrow(RangeError);
    expect(() => wilson(1.5, 2)).toThrow(RangeError);
  });

  it('格式', () => {
    expect(formatProportion(wilson(10, 20))).toBe('10/20 = 50% [30%, 70%]');
    expect(formatProportion(wilson(0, 0))).toBe('0/0');
  });
});
