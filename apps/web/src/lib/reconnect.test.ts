import { describe, expect, it } from 'vitest';

import { RECONNECT_MAX_MS, reconnectDelay } from './reconnect';

describe('reconnectDelay', () => {
  it('第 n 次的上限是 500ms × 2^(n−1)，實際等上限的一半到全部', () => {
    const caps = [500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000];
    caps.forEach((cap, index) => {
      expect(reconnectDelay(index + 1, () => 0)).toBe(cap / 2);
      expect(reconnectDelay(index + 1, () => 0.999_999)).toBeCloseTo(cap, 0);
    });
  });

  it('封頂 10 秒，重試再多次也一樣', () => {
    expect(reconnectDelay(50, () => 0.999_999)).toBeLessThanOrEqual(RECONNECT_MAX_MS);
    expect(reconnectDelay(50, () => 0)).toBe(RECONNECT_MAX_MS / 2);
  });
});
