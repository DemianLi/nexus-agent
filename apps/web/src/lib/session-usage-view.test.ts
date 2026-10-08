import { describe, expect, it } from 'vitest';

import { formatDuration, sessionUsageView } from '@/lib/session-usage-view';

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
      usage: {
        total: '422,195 token',
        input: '412,380 token',
        output: '9,815 token',
        cacheRead: '沒記',
        cacheWrite: '沒記',
        cacheNote: '「沒記」是這台 server 沒有記錄，不是 0。',
      },
      time: { counts: '4 輪／17 次', llm: '2 分 13 秒', tool: '38.4 秒' },
    });
  });

  describe('快取讀、快取寫（#724）：缺席是「沒記」，不是 0', () => {
    const base = { inputTokens: 412_380, outputTokens: 9_815 };

    it('兩格都有：各寫精確數字，說明講已含在輸入裡；總量不變（不重複加）', () => {
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
      expect(view?.usage).toMatchObject({
        total: '422,195 token',
        cacheRead: '300,000 token',
        cacheWrite: '12,380 token',
        cacheNote: '快取讀、快取寫已含在輸入裡。',
      });
    });

    it('記了、值是 0：寫 0 token，不寫沒記（兩件事分開）', () => {
      const view = sessionUsageView({ ...base, cacheReadTokens: 0, cacheWriteTokens: 0 }, stats);
      expect(view?.usage).toMatchObject({ cacheRead: '0 token', cacheWrite: '0 token' });
    });

    it('只有一格有：另一格寫沒記，說明講沒記不是 0', () => {
      const view = sessionUsageView({ ...base, cacheReadTokens: 5_000 }, stats);
      expect(view?.usage).toMatchObject({
        cacheRead: '5,000 token',
        cacheWrite: '沒記',
        cacheNote: '「沒記」是這台 server 沒有記錄，不是 0。',
      });
    });

    it('沒有 token 時用量那一段不畫，快取兩格也就不畫', () => {
      expect(sessionUsageView(null, stats)?.usage).toBeUndefined();
    });
  });

  it('模型呼叫都沒報用量：只剩時間那一段，收著改寫次數（同 dsh 只剩時間那顆）', () => {
    const view = sessionUsageView(null, stats);
    expect(view?.usage).toBeUndefined();
    expect(view?.label).toBe('4 輪／17 次');
    expect(view?.time?.counts).toBe('4 輪／17 次');
  });

  it('有 token、統計還是 null：只有用量那一段（兩格互相獨立）', () => {
    const view = sessionUsageView({ inputTokens: 1_200, outputTokens: 0 }, null);
    expect(view?.label).toBe('1.2k token');
    expect(view?.time).toBeUndefined();
  });

  it('時間那兩列大於 0 才列', () => {
    const view = sessionUsageView(null, { ...stats, llmMs: 0, toolMs: 0 });
    expect(view?.time).toEqual({ counts: '4 輪／17 次' });
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
