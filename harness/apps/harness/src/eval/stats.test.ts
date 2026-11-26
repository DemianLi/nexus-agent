/**
 * 以題目為單位的區間（[#1002](https://github.com/DemianLi/nexus-agent/issues/1002)）：純函式。
 *
 * 承重的一條是**「換一題結果就變」與「同題重跑結果就變」要分得開**：區間隨前者變寬，
 * 不被後者單獨撐大。端到端那一半（真的跑 agent）在 `intervals.test.ts`。
 */

import { describe, expect, it } from 'vitest';
import {
  BOOTSTRAP_LEVEL,
  BOOTSTRAP_RESAMPLES,
  caseStats,
  formatCaseStats,
  mulberry32,
  type ColumnEntry,
} from './stats.js';

/** 每題 `runs` 次執行，各題的值由 `values` 給（同題每次相同）。 */
function between(values: readonly number[], runs = 1): ColumnEntry[] {
  return values.flatMap((value, index) =>
    Array.from({ length: runs }, () => ({ caseId: `c${index}`, value })),
  );
}

/** 每題 `runs` 次執行，值在 0 與 1 之間輪流 —— 每題的平均都是 `ones / runs`。 */
function within(cases: number, runs: number, ones: number): ColumnEntry[] {
  return Array.from({ length: cases }, (_, index) =>
    Array.from({ length: runs }, (_, run) => ({ caseId: `c${index}`, value: run < ones ? 1 : 0 })),
  ).flat();
}

const width = (entries: readonly ColumnEntry[]): number => {
  const stats = caseStats(entries);
  if (stats?.interval === undefined) throw new Error('沒有區間');
  return stats.interval.high - stats.interval.low;
};

describe('區間跟著「換一題」變寬', () => {
  it('題目之間差得越多區間越寬', () => {
    const same = width(between([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]));
    const mild = width(between([0.4, 0.6, 0.4, 0.6, 0.4, 0.6]));
    const wild = width(between([1, 1, 1, 0, 0, 0]));
    expect(same).toBe(0);
    expect(mild).toBeGreaterThan(same);
    expect(wild).toBeGreaterThan(mild);
  });

  it('七題五過兩不過：區間很寬 —— 這是對的', () => {
    const stats = caseStats(between([1, 1, 1, 1, 1, 0, 0]));
    expect(stats?.interval?.low).toBeLessThan(0.5);
    expect(stats?.interval?.high).toBe(1);
  });
});

describe('區間不被「同題重跑」單獨撐大', () => {
  it('每題都是一半一半：重跑變異最大，區間卻塌成一點（題目之間沒有差）', () => {
    const entries = within(6, 4, 2);
    const stats = caseStats(entries);
    expect(stats?.mean).toBe(0.5);
    expect(stats?.interval).toMatchObject({ low: 0.5, high: 0.5 });
    expect(stats?.collapsed).toBe(true);
    // 同一批資料的最小到最大是 0–1：範圍把重跑變異全算進去了，區間沒有。
    const values = entries.map((entry) => entry.value);
    expect(Math.min(...values)).toBe(0);
    expect(Math.max(...values)).toBe(1);
  });

  it('題的平均相同、重跑變異不同 → 區間一字不差', () => {
    // 兩份資料每題的平均都是 0.5（前者每次都 0.5，後者一次 0、一次 1）。
    const steady = between([0.5, 0.5, 0.5, 0.5, 0.5, 0.5], 2);
    const jumpy = within(6, 2, 1);
    expect(caseStats(jumpy)?.interval).toEqual(caseStats(steady)?.interval);
  });

  it('同題多跑不會讓區間變窄：n 是題數，不是執行數', () => {
    const once = caseStats(between([1, 1, 1, 0, 0, 0], 1));
    const many = caseStats(between([1, 1, 1, 0, 0, 0], 10));
    expect(many?.interval).toEqual(once?.interval);
    expect(many?.cases).toBe(6);
    expect(many?.runs).toBe(60);
  });
});

describe('一題等於幾個百分點', () => {
  it('七題：100/7 = 14.3，與手算一致', () => {
    const stats = caseStats(between([1, 1, 1, 1, 1, 1, 0]));
    expect(stats?.pointsPerCase).toBeCloseTo(14.2857, 3);
    expect(formatCaseStats(stats)).toContain('一題 = 14.3 個百分點');
  });

  it('同題多跑時一次執行也印出來：7 題 × 3 次，一次 = 4.8', () => {
    const stats = caseStats(between([1, 1, 1, 1, 1, 1, 0], 3));
    expect(stats?.pointsPerRun).toBeCloseTo(4.7619, 3);
    expect(formatCaseStats(stats)).toContain('一題 = 14.3 個百分點（一次執行 = 4.8，共 21 次）');
  });

  it('難題參數那欄 n=9 次執行，一次 = 11.1（卡片的例子）', () => {
    const stats = caseStats(between([1, 1, 1, 1, 1, 1, 1, 1, 0]));
    expect(stats?.runs).toBe(9);
    expect(stats?.pointsPerRun).toBeCloseTo(11.111, 2);
  });

  it('按判得動的執行數算，不是按題目總數', () => {
    // 九題裡只有四題判得動這一欄：一題 = 25 個百分點，不是 11.1。
    expect(caseStats(between([1, 0, 1, 1]))?.pointsPerCase).toBe(25);
  });
});

describe('邊界', () => {
  it('沒有任何一筆：undefined', () => {
    expect(caseStats([])).toBeUndefined();
    expect(formatCaseStats(undefined)).toBe('—');
  });

  it('只有一題：抽不出區間，而且明說，但一題的換算還在', () => {
    const stats = caseStats(between([1], 3));
    expect(stats?.interval).toBeUndefined();
    expect(stats?.pointsPerCase).toBe(100);
    expect(formatCaseStats(stats)).toMatch(/只有 1 題，抽不出區間/);
  });

  it('全部同值：塌成一點而且報表明說不代表沒有不確定度', () => {
    const stats = caseStats(between([1, 1, 1, 1, 1, 1, 1]));
    expect(stats?.collapsed).toBe(true);
    expect(formatCaseStats(stats)).toContain('區間塌成一點，不代表沒有不確定度');
  });

  it('區間落在題目平均的最小與最大之間，而且包得住以題為單位的平均', () => {
    const entries = between([0.2, 0.9, 0.5, 1, 0, 0.7]);
    const stats = caseStats(entries);
    expect(stats?.interval?.low).toBeGreaterThanOrEqual(0);
    expect(stats?.interval?.high).toBeLessThanOrEqual(1);
    expect(stats?.interval?.low).toBeLessThanOrEqual(stats?.mean ?? NaN);
    expect(stats?.interval?.high).toBeGreaterThanOrEqual(stats?.mean ?? NaN);
  });

  it('種子固定：同一份資料永遠同一個區間', () => {
    const entries = between([0.2, 0.9, 0.5, 1, 0, 0.7]);
    expect(caseStats(entries)).toEqual(caseStats(entries));
  });

  it('方法與 n 印在字裡', () => {
    const text = formatCaseStats(caseStats(between([1, 0, 1, 0, 1, 1, 0])));
    expect(text).toContain(`${Math.round(BOOTSTRAP_LEVEL * 100)}% 區間`);
    expect(text).toContain(`以 7 題為單位重抽 ${BOOTSTRAP_RESAMPLES} 次`);
  });

  it('mulberry32 確定而且落在 [0,1)', () => {
    const a = mulberry32(1);
    const b = mulberry32(1);
    for (let i = 0; i < 100; i += 1) {
      const value = a();
      expect(value).toBe(b());
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});
