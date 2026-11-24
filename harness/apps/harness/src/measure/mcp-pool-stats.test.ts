/**
 * 統計工具要跟 Python 逐位相同。期望值都是 Python 3.12 實際印出來的（`random.Random`、`statistics.median`、f-string、`repr`）。
 *
 * `mcp-pool-agg-1947.expected.txt` 是 #1947 的 `agg.py` 吃 {@link synthetic1947Runs} 印出來的報告。改了合成數據就要重產：
 * 把 `synthetic1947Runs()` 的每個 `[tag, results]` 寫成 `<目錄>/<tag>.json`（`{"results": [...]}`），
 * 再跑 `python3.12 -I agg.py <目錄> > mcp-pool-agg-1947.expected.txt`。`agg.py` 在 #1947 的本機證據目錄，不進 repo。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { report1947 } from './mcp-pool-agg-1947.js';
import { synthetic1947Runs } from './mcp-pool-agg-1947.fixture.js';
import {
  PyCounter,
  PyRandom,
  PyTuple,
  WINDOWS,
  bootstrapMedian90,
  fixed,
  median,
  pyRepr,
} from './mcp-pool-stats.js';

describe('PyRandom 跟 Python 的 random.Random 同一個序列', () => {
  it('getrandbits(32)', () => {
    const rnd = new PyRandom(1947);
    expect([rnd.getrandbits(32), rnd.getrandbits(32), rnd.getrandbits(32)]).toEqual([
      3141045603, 2923336697, 2383691671,
    ]);
  });

  it('randrange：24 與 12 個回合各重抽一輪', () => {
    const a = new PyRandom(1947);
    expect(Array.from({ length: 12 }, () => a.randrange(24))).toEqual([
      23, 21, 17, 19, 2, 18, 11, 15, 20, 11, 18, 11,
    ]);
    const b = new PyRandom(1947);
    expect(Array.from({ length: 12 }, () => b.randrange(12))).toEqual([
      11, 10, 8, 9, 1, 9, 5, 7, 10, 5, 9, 5,
    ]);
  });

  it('超過 32 位元的種子照 Python 切成多段', () => {
    const rnd = new PyRandom(2n ** 40n + 5n);
    expect(Array.from({ length: 5 }, () => rnd.randrange(1000))).toEqual([516, 529, 275, 679, 948]);
  });
});

describe('median 與 bootstrap', () => {
  it('偶數個取中間兩個的平均，奇數個取中間那個', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([3, 1, 2])).toBe(2);
    expect(() => median([])).toThrow(/空的/u);
  });

  it('90% 區間跟 agg.py 的 boot 相同', () => {
    expect(bootstrapMedian90([3.1, 1.2, 9.9, 4.4, 5.0, 2.2, 7.7, 8.8, 6.6, 0.5, 1.1, 2.9])).toEqual(
      [2.15, 6.6],
    );
  });
});

describe('fixed 照 Python 的 f-string 四捨五入', () => {
  it.each([
    [0.25, 1, '0.2'],
    [0.35, 1, '0.3'],
    [1.25, 1, '1.2'],
    [2.5, 1, '2.5'],
    [-0.05, 1, '-0.1'],
    [616.25, 1, '616.2'],
    [0, 1, '0.0'],
    [-0, 1, '-0.0'],
    [2.5, 0, '2'],
    [0.125, 2, '0.12'],
    [1.0005, 3, '1.000'],
  ])('%s 取 %s 位是 %s', (x, digits, want) => {
    expect(fixed(x, digits)).toBe(want);
  });
});

describe('pyRepr', () => {
  it('dict、tuple、list、引號的選法', () => {
    const value = new Map<unknown, unknown>([
      [new PyTuple(['run1', 3]), ['L:outcome', "a'b", 'x"y']],
      ['k', 1.5],
    ]);
    expect(pyRepr(value)).toBe(`{('run1', 3): ['L:outcome', "a'b", 'x"y'], 'k': 1.5}`);
  });

  it('Counter 照次數由多到少，dict 照插入順序', () => {
    expect(pyRepr(new PyCounter<number>().update([4, 5, 4]))).toBe('Counter({4: 2, 5: 1})');
    expect(pyRepr(new PyCounter<string>().update(['b', 'a', 'b']).counts)).toBe("{'b': 2, 'a': 1}");
  });
});

describe('#1947 的彙總改寫成 TS，輸出跟 agg.py 逐字相同', () => {
  it('窗是暖機之後的第 1–10、11–20、21–40 輪', () => {
    expect(WINDOWS).toEqual([
      [1, 10],
      [11, 20],
      [21, 40],
    ]);
  });

  it('合成數據的報告跟 agg.py 印的一樣', () => {
    const want = readFileSync(new URL('./mcp-pool-agg-1947.expected.txt', import.meta.url), 'utf8');
    expect(report1947(synthetic1947Runs())).toBe(want);
  });
});
