import { describe, expect, it } from 'vitest';

import {
  cacheHitRate,
  cacheHitRateText,
  formatDuration,
  sessionUsageView,
  usageBuckets,
} from '@/shared/lib/usage-view';

const stats = { turns: 4, steps: 17, llmMs: 133_000, toolMs: 38_400 };

describe('sessionUsageView（#574）', () => {
  it('兩格都是 null：不畫（null 等於 dsh 的全是 0）', () => {
    expect(sessionUsageView(null, null)).toBeNull();
  });

  it('全是 0 也不畫：沒有 token、也沒有結束的模型呼叫', () => {
    expect(
      sessionUsageView({ inputTokens: 0, outputTokens: 0 }, { ...stats, turns: 0, steps: 0 }),
    ).toBeNull();
  });

  it('都有：收著寫總量，總量＝輸入＋輸出（輸入已含快取讀取）', () => {
    const view = sessionUsageView({ inputTokens: 412_380, outputTokens: 9_815 }, stats);
    expect(view).toEqual({
      label: '422k token',
      ariaLabel: '這條對話的用量：422k token，點開看明細',
      total: '422,195 token',
    });
  });

  describe('總數（#724）：快取不重複加、沒記的不加', () => {
    const base = { inputTokens: 412_380, outputTokens: 9_815 };

    it('舊 server（沒有 uncachedInputTokens）：快取是輸入的明細，總數不重複加', () => {
      const view = sessionUsageView(
        { ...base, cacheReadTokens: 300_000, cacheWriteTokens: 12_380 },
        stats,
      );
      expect(view?.label).toBe('422k token');
      expect(view?.total).toBe('422,195 token');
    });

    it('新 server（有 uncachedInputTokens）：總數是四項相加', () => {
      const view = sessionUsageView(
        {
          ...base,
          uncachedInputTokens: 100_000,
          cacheReadTokens: 300_000,
          cacheWriteTokens: 12_380,
        },
        stats,
      );
      expect(view?.label).toBe('422k token');
      expect(view?.total).toBe('422,195 token');
    });

    it('新 server 的快取缺席：總數不含沒記的那一項', () => {
      const view = sessionUsageView(
        { inputTokens: 999, uncachedInputTokens: 1_000, outputTokens: 50 },
        stats,
      );
      expect(view?.total).toBe('1,050 token');
    });
  });

  it('模型呼叫都沒報用量：沒有總數，收著改寫次數（同 dsh 只剩時間那顆）', () => {
    const view = sessionUsageView(null, stats);
    expect(view?.total).toBeUndefined();
    expect(view?.label).toBe('4 輪／17 次');
  });

  it('有 token、統計還是 null：照樣有總數', () => {
    const view = sessionUsageView({ inputTokens: 1_200, outputTokens: 0 }, null);
    expect(view?.label).toBe('1.2k token');
    expect(view?.total).toBe('1,200 token');
  });
});

describe('formatDuration（照 dsh）', () => {
  it.each([
    [0, '0 秒'],
    [45_240, '45.2 秒'],
    [59_940, '59.9 秒'],
    // 照 dsh：先看是不是不到 60 秒再捨入，所以 59.96 秒寫成「60 秒」，不是「1 分 0 秒」。
    [59_960, '60 秒'],
    [60_000, '1 分 0 秒'],
    [162_000, '2 分 42 秒'],
  ])('%i ms → %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe('usageBuckets（#724 收尾第 1 步）', () => {
  const full = {
    uncachedInputTokens: 200,
    cacheReadTokens: 700,
    cacheWriteTokens: 100,
    outputTokens: 50,
  };

  it('釘住：inputTokens 從「完整 prompt」改成「只算未快取」，畫面上的數字不變', () => {
    const before = sessionUsageView({ ...full, inputTokens: 1_000 }, stats);
    const after = sessionUsageView({ ...full, inputTokens: 200 }, stats);
    expect(after).toEqual(before);
    expect(after?.total).toBe('1,050 token');
    expect(usageBuckets({ ...full, inputTokens: 1_000 })).toEqual(
      usageBuckets({ ...full, inputTokens: 200 }),
    );
  });

  it('新 server：不讀 inputTokens，四桶相加；沒記的快取是 undefined、合計不加', () => {
    expect(
      usageBuckets({ inputTokens: 123_456, uncachedInputTokens: 10, outputTokens: 5 }),
    ).toEqual({
      input: 10,
      cacheRead: undefined,
      cacheWrite: undefined,
      output: 5,
      total: 15,
      cacheInInput: false,
    });
  });

  it('舊 server：輸入就是 inputTokens（含快取），快取是明細不另加', () => {
    expect(usageBuckets({ inputTokens: 1_000, outputTokens: 50, cacheReadTokens: 700 })).toEqual({
      input: 1_000,
      cacheRead: 700,
      cacheWrite: undefined,
      output: 50,
      total: 1_050,
      cacheInInput: true,
    });
  });

  it('null 當成全是 0（舊 server 的口徑）；uncachedInputTokens 是 0 也算新 server', () => {
    expect(usageBuckets(null).total).toBe(0);
    expect(
      usageBuckets({ inputTokens: 500, uncachedInputTokens: 0, outputTokens: 5 }),
    ).toMatchObject({
      input: 0,
      total: 5,
      cacheInInput: false,
    });
  });

  it('只有快取讀、沒有未快取與輸出也算有 token（四桶任一大於 0）', () => {
    const view = sessionUsageView(
      { inputTokens: 0, uncachedInputTokens: 0, cacheReadTokens: 800, outputTokens: 0 },
      null,
    );
    expect(view?.label).toBe('800 token');
  });
});

describe('cacheHitRate（#724）', () => {
  const buckets = (over: Partial<ReturnType<typeof usageBuckets>>) => ({
    input: 200,
    cacheRead: 700,
    cacheWrite: 100,
    output: 50,
    total: 1_050,
    cacheInInput: false,
    ...over,
  });

  it('新 server：快取讀 ÷ 三桶相加', () => {
    expect(cacheHitRate(buckets({}))).toBeCloseTo(0.7);
  });

  it('舊 server：分母是 input（已含快取），不再加一次', () => {
    expect(
      cacheHitRate(buckets({ input: 1_000, cacheRead: 250, cacheWrite: 100, cacheInInput: true })),
    ).toBeCloseTo(0.25);
  });

  it('沒記與不畫的分界', () => {
    expect(cacheHitRate(buckets({ cacheRead: undefined }))).toBe('unrecorded');
    expect(cacheHitRate(buckets({ cacheWrite: undefined }))).toBe('unrecorded');
    expect(cacheHitRate(buckets({ cacheRead: undefined, cacheWrite: undefined }))).toBeUndefined();
  });

  it('整筆輸入是 0 除不了：不畫，不是 NaN 也不是 0%', () => {
    expect(cacheHitRate(buckets({ input: 0, cacheRead: 0, cacheWrite: 0 }))).toBeUndefined();
  });

  it('寫成字：小數一位，沒記寫沒記', () => {
    expect(cacheHitRateText(0.6243)).toBe('62.4%');
    expect(cacheHitRateText(0)).toBe('0.0%');
    expect(cacheHitRateText(1)).toBe('100.0%');
    expect(cacheHitRateText('unrecorded')).toBe('沒記');
  });
});
