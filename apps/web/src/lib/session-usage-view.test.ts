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
      usage: { total: '422,195 token', input: '412,380 token', output: '9,815 token' },
      time: { counts: '4 輪／17 次', llm: '2 分 13 秒', tool: '38.4 秒' },
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
