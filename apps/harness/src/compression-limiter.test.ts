import { describe, expect, it } from 'vitest';

import { CompressionLimiter, compressionFailure } from './compression-limiter.js';

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe('CompressionLimiter', () => {
  it('同時最多跑 concurrency 個，其餘照送進來的順序排隊', async () => {
    const limiter = new CompressionLimiter(2);
    const gates = [gate(), gate(), gate(), gate()];
    const started: number[] = [];
    const results = gates.map((g, index) =>
      limiter.run(async () => {
        started.push(index);
        await g.promise;
        return index;
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual([0, 1]);
    expect(limiter.active).toBe(2);

    gates[1]!.open();
    await results[1];
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual([0, 1, 2]);
    expect(limiter.active).toBe(2);

    for (const g of gates) g.open();
    expect(await Promise.all(results)).toEqual([0, 1, 2, 3]);
    expect(started).toEqual([0, 1, 2, 3]);
    expect(limiter.active).toBe(0);
  });

  it('失敗的任務也放出名額；同步拋錯一樣算失敗', async () => {
    const limiter = new CompressionLimiter(1);
    await expect(
      limiter.run(() => {
        throw new Error('同步');
      }),
    ).rejects.toThrow('同步');
    await expect(limiter.run(() => Promise.reject(new Error('非同步')))).rejects.toThrow('非同步');
    expect(await limiter.run(() => Promise.resolve('還跑得動'))).toBe('還跑得動');
    expect(limiter.active).toBe(0);
  });

  it('不是 Error 的拒絕包成 Error，原值放在 cause', async () => {
    const limiter = new CompressionLimiter(1);
    const rejected = limiter.run(() => Promise.reject('字串'));
    await expect(rejected).rejects.toBeInstanceOf(Error);
    await expect(rejected).rejects.toMatchObject({ cause: '字串' });
    const original = new TypeError('原樣');
    expect(compressionFailure(original)).toBe(original);
  });
});
