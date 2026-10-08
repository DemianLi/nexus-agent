import {
  COMPACTION,
  CONTEXT_MEASURE,
  emptyConversation,
  MODEL_USAGE,
  reduceAll,
  SESSION_STATS,
  TOKEN_USAGE,
} from '@nexus/wire';
import type { Event } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { Script } from '@/test/conversation-frames';

import { COST_LIMITS, compactionCount, contextRows, usageSections } from './cost-view';

/** 狀態都從真的 frame 折出來，不手寫 `entries`。 */
function fold(...build: ((script: Script) => Event[])[]) {
  const script = new Script();
  return reduceAll(
    emptyConversation(),
    build.flatMap((make) => make(script)),
  );
}

describe('usageSections', () => {
  it('兩顆總帳都有：token 三列、時間四列，數字照 frame', () => {
    const state = fold((s) => [
      s.custom(TOKEN_USAGE, { inputTokens: 412_380, outputTokens: 3_120 }),
      s.custom(SESSION_STATS, { turns: 3, steps: 9, llmMs: 45_200, toolMs: 162_000 }),
    ]);
    expect(usageSections(state.tokenUsage, state.sessionStats)).toEqual({
      tokens: [
        ['輸入', '412,380 token'],
        ['輸出', '3,120 token'],
        ['合計', '415,500 token'],
      ],
      stats: [
        ['輪數', '3'],
        ['模型呼叫', '9 次'],
        ['模型耗時', '45.2 秒'],
        ['工具耗時', '2 分 42 秒'],
      ],
    });
  });

  it('新 server（有 uncachedInputTokens）：輸入只算未快取的，快取讀、快取寫另列，合計四項相加；inputTokens 怎麼改都不影響', () => {
    const rows = (inputTokens: number) => {
      const state = fold((s) => [
        s.custom(TOKEN_USAGE, {
          inputTokens,
          uncachedInputTokens: 200,
          cacheReadTokens: 700,
          cacheWriteTokens: 100,
          outputTokens: 50,
        }),
      ]);
      return usageSections(state.tokenUsage, state.sessionStats).tokens;
    };
    expect(rows(1_000)).toEqual([
      ['輸入', '200 token'],
      ['快取讀', '700 token'],
      ['快取寫', '100 token'],
      ['輸出', '50 token'],
      ['合計', '1,050 token'],
    ]);
    expect(rows(200)).toEqual(rows(1_000));
  });

  it('新 server 沒記快取：那兩列畫沒記，不畫 0，合計不加', () => {
    const state = fold((s) => [
      s.custom(TOKEN_USAGE, { inputTokens: 90, uncachedInputTokens: 100, outputTokens: 10 }),
    ]);
    expect(usageSections(state.tokenUsage, null).tokens).toEqual([
      ['輸入', '100 token'],
      ['快取讀', '沒記'],
      ['快取寫', '沒記'],
      ['輸出', '10 token'],
      ['合計', '110 token'],
    ]);
  });

  it('四桶任一大於 0 就有 token 那一段（只有快取讀也算）', () => {
    const state = fold((s) => [
      s.custom(TOKEN_USAGE, {
        inputTokens: 0,
        uncachedInputTokens: 0,
        cacheReadTokens: 800,
        outputTokens: 0,
      }),
    ]);
    expect(usageSections(state.tokenUsage, null).tokens?.at(-1)).toEqual(['合計', '800 token']);
  });

  it('entries 是空的時數字仍等於 frame 的值：數字不是從畫面加出來的', () => {
    const state = fold((s) => [
      s.custom(TOKEN_USAGE, { inputTokens: 100, outputTokens: 10 }),
      s.custom(SESSION_STATS, { turns: 1, steps: 1, llmMs: 1000, toolMs: 0 }),
    ]);
    expect(state.entries).toHaveLength(0);
    expect(usageSections(state.tokenUsage, state.sessionStats).tokens?.[2]).toEqual([
      '合計',
      '110 token',
    ]);
  });

  it('一頁歷史（只載入尾巴一輪）的 entries 與總帳不同步時，照總帳', () => {
    const state = fold(
      (s) => s.human('history-0', '只載入了這一句'),
      (s) => [
        s.custom(TOKEN_USAGE, { inputTokens: 9_000_000, outputTokens: 1_000 }),
        s.custom(SESSION_STATS, { turns: 120, steps: 400, llmMs: 3_600_000, toolMs: 0 }),
      ],
    );
    expect(state.entries).toHaveLength(1);
    const sections = usageSections(state.tokenUsage, state.sessionStats);
    expect(sections.tokens?.[0]).toEqual(['輸入', '9,000,000 token']);
    expect(sections.stats?.[0]).toEqual(['輪數', '120']);
  });

  it('沒有任何用量（null、或全 0）兩段都不給，不畫 0', () => {
    expect(usageSections(null, null)).toEqual({});
    expect(usageSections({ inputTokens: 0, outputTokens: 0 }, null)).toEqual({});
    expect(usageSections(null, { turns: 0, steps: 0, llmMs: 0, toolMs: 0 })).toEqual({});
  });

  it('模型呼叫都沒回報用量時只有時間那一段；反過來只有 token 那一段', () => {
    const onlyStats = usageSections(null, { turns: 1, steps: 2, llmMs: 500, toolMs: 0 });
    expect(onlyStats.tokens).toBeUndefined();
    expect(onlyStats.stats).toHaveLength(4);
    const onlyTokens = usageSections({ inputTokens: 1, outputTokens: 0 }, null);
    expect(onlyTokens.stats).toBeUndefined();
    expect(onlyTokens.tokens).toHaveLength(3);
  });
});

describe('contextRows', () => {
  const measure = {
    approxTokens: 8_123,
    messageCount: 3,
    thresholds: [
      { type: 'tokens', value: 10_000 },
      { type: 'messages', value: 60 },
    ],
  };

  it('離自動摘要多遠、目前大小、每一道門檻各一列，門檻讀線上給的值', () => {
    const state = fold((s) => [
      s.custom(MODEL_USAGE, { inputTokens: 8_000 }),
      s.custom(CONTEXT_MEASURE, measure),
    ]);
    expect(contextRows(state.contextPressure)).toEqual([
      ['離自動摘要', '約 81%'],
      ['目前大小', '8,000 token'],
      ['token 門檻', '約 8.1k／10k token'],
      ['訊息門檻', '3／60 則'],
    ]);
  });

  it('沒有 measure（摘要關掉）或還沒收到就不給', () => {
    expect(contextRows(null)).toBeUndefined();
    const onlyUsage = fold((s) => [s.custom(MODEL_USAGE, { inputTokens: 5 })]);
    expect(contextRows(onlyUsage.contextPressure)).toBeUndefined();
  });
});

describe('compactionCount', () => {
  it('只數已載入的壓縮', () => {
    const state = fold(
      (s) => s.human('history-0', '問'),
      (s) => [
        s.custom(COMPACTION, { seq: 3, cutoff: 1, saved: true }),
        s.custom(COMPACTION, { seq: 8, cutoff: 5, saved: false }),
      ],
    );
    expect(compactionCount(state.entries)).toBe(2);
    expect(compactionCount(emptyConversation().entries)).toBe(0);
  });
});

describe('COST_LIMITS', () => {
  it('口徑把已知缺口都列出來：子代理、摘要、標題、失敗呼叫、快取讀取、耗時、已載入、金額與完成率', () => {
    const all = Object.values(COST_LIMITS).join('\n');
    for (const piece of [
      '不含任何子代理',
      '前景的目前沒有數字',
      '生摘要的那一次',
      '生標題的那一次',
      '失敗或中止的呼叫',
      '輸入含快取讀取',
      '重試退避',
      '等人核准',
      '只算已載入',
      '讀取當下',
      '沒有金額',
      '沒有完成率',
    ]) {
      expect(all).toContain(piece);
    }
  });
});
