/**
 * token 總帳與會話統計的 `custom` frame 怎麼折（[#574](https://github.com/DemianLi/nexus-agent/issues/574)）。
 *
 * 兩條路產出同一種 frame 的那一半在 `apps/harness/src/session-totals-wire.test.ts`；這裡只管折疊器：整顆換掉、
 * 形狀不對整顆不收、往前翻頁不動它。
 */

import { describe, expect, it } from 'vitest';

import { emptyConversation, prependEntries, reduceAll } from './conversation.js';
import type { Event } from './protocol.js';
import { SESSION_STATS, TOKEN_USAGE } from './session-totals.js';

const custom = (name: string, payload: unknown): Event =>
  ({
    type: 'event',
    method: 'custom',
    params: { namespace: [], timestamp: 0, data: { name, payload } },
  }) as Event;

const usage = { inputTokens: 422_000, outputTokens: 3_100 };
const stats = { turns: 3, steps: 11, llmMs: 48_200, toolMs: 7_300 };

const fold = (...frames: Event[]) => reduceAll(emptyConversation(), frames);

describe('tokenUsage', () => {
  it('一顆都沒有是 null', () => {
    expect(emptyConversation().tokenUsage).toBeNull();
  });

  it('整顆換掉，只帶認得的欄位', () => {
    const later = { inputTokens: 500_000, outputTokens: 4_000 };
    expect(fold(custom(TOKEN_USAGE, usage)).tokenUsage).toEqual(usage);
    expect(fold(custom(TOKEN_USAGE, usage), custom(TOKEN_USAGE, later)).tokenUsage).toEqual(later);
    expect(fold(custom(TOKEN_USAGE, { ...usage, totalTokens: 1 })).tokenUsage).toEqual(usage);
  });

  it('任何一格不對就整顆不收，不動已經有的', () => {
    const bad: unknown[] = [
      { inputTokens: 1 },
      { outputTokens: 1 },
      { inputTokens: -1, outputTokens: 1 },
      { inputTokens: 1.5, outputTokens: 1 },
      { inputTokens: 1, outputTokens: '2' },
    ];
    for (const payload of bad) {
      expect(fold(custom(TOKEN_USAGE, payload)).tokenUsage).toBeNull();
      expect(fold(custom(TOKEN_USAGE, usage), custom(TOKEN_USAGE, payload)).tokenUsage).toEqual(
        usage,
      );
    }
  });
});

describe('tokenUsage：快取分桶（#724）', () => {
  const buckets = {
    ...usage,
    uncachedInputTokens: 22_000,
    cacheReadTokens: 390_000,
    cacheWriteTokens: 10_000,
  };

  it('三個選填格有就帶過去，缺席就沒有那個 key（沒記，不是 0）', () => {
    expect(fold(custom(TOKEN_USAGE, buckets)).tokenUsage).toEqual(buckets);
    const partial = fold(
      custom(TOKEN_USAGE, { ...usage, uncachedInputTokens: 422_000 }),
    ).tokenUsage;
    expect(partial).toEqual({ ...usage, uncachedInputTokens: 422_000 });
    expect(partial).not.toHaveProperty('cacheReadTokens');
    expect(partial).not.toHaveProperty('cacheWriteTokens');
    // 舊 server 只送兩格：照舊。
    expect(fold(custom(TOKEN_USAGE, usage)).tokenUsage).toEqual(usage);
  });

  it('報了 0 就是 0，不被當成缺席丟掉', () => {
    expect(fold(custom(TOKEN_USAGE, { ...usage, cacheReadTokens: 0 })).tokenUsage).toHaveProperty(
      'cacheReadTokens',
      0,
    );
  });

  it('選填格有一格不是數量，整顆不收（不收一半），不動已經有的', () => {
    for (const key of ['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
      for (const value of [-1, 0.5, '3', null]) {
        const payload = { ...usage, [key]: value };
        expect(fold(custom(TOKEN_USAGE, payload)).tokenUsage).toBeNull();
        expect(fold(custom(TOKEN_USAGE, buckets), custom(TOKEN_USAGE, payload)).tokenUsage).toEqual(
          buckets,
        );
      }
    }
  });
});

describe('sessionStats', () => {
  it('一顆都沒有是 null', () => {
    expect(emptyConversation().sessionStats).toBeNull();
  });

  it('整顆換掉，只帶認得的欄位', () => {
    expect(fold(custom(SESSION_STATS, { ...stats, ttftMs: 1 })).sessionStats).toEqual(stats);
    const later = { ...stats, steps: 12 };
    expect(fold(custom(SESSION_STATS, stats), custom(SESSION_STATS, later)).sessionStats).toEqual(
      later,
    );
  });

  it('任何一格不對就整顆不收，不動已經有的', () => {
    for (const key of Object.keys(stats)) {
      for (const value of [undefined, -1, 0.5, '3']) {
        const payload = { ...stats, [key]: value };
        expect(fold(custom(SESSION_STATS, payload)).sessionStats).toBeNull();
        expect(
          fold(custom(SESSION_STATS, stats), custom(SESSION_STATS, payload)).sessionStats,
        ).toEqual(stats);
      }
    }
  });
});

it('往前翻頁兩格都不動：那是「現在」的事', () => {
  const now = fold(custom(TOKEN_USAGE, usage), custom(SESSION_STATS, stats));
  const earlier = fold(
    custom(TOKEN_USAGE, { inputTokens: 1, outputTokens: 1 }),
    custom(SESSION_STATS, { turns: 1, steps: 1, llmMs: 1, toolMs: 0 }),
  );
  const joined = prependEntries(now, earlier);
  expect(joined.tokenUsage).toEqual(usage);
  expect(joined.sessionStats).toEqual(stats);
});
