/**
 * 會話總帳那道折疊的規則。每一條對著一份手寫的事件串驗；真的跑一場對話之後線上收不收得到，在
 * `apps/harness/src/session-totals-wire.test.ts`。
 */

import { describe, expect, it } from 'vitest';
import type { SessionEvent, SessionEventType } from './session-log.js';
import { deriveTokenUsage, tokenUsageUnit } from './token-usage.js';

function ev(type: SessionEventType, data: unknown = {}): SessionEvent {
  return { type, time: 0, data, seq: 0 } as unknown as SessionEvent;
}

const usage = (inputTokens: number, outputTokens: number) =>
  ev('model/usage', { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens });

describe('會話總帳', () => {
  it('每一顆 model/usage 的輸入、輸出各自加總', () => {
    expect(deriveTokenUsage([usage(1000, 20), usage(1500, 35), usage(2100, 8)])).toEqual({
      inputTokens: 4600,
      outputTokens: 63,
    });
  });

  it('沒有 model/usage 就是 0，快取兩格缺席', () => {
    const empty = deriveTokenUsage([ev('turn/start', { kind: 'message', text: '嗨' })]);
    expect(empty).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(empty).not.toHaveProperty('cacheReadTokens');
    expect(empty).not.toHaveProperty('cacheWriteTokens');
  });

  /** `totalTokens` 不讀：總量由讀的那一側把兩格加起來，同 dsh 的 `StatsPills`。 */
  it('不讀 totalTokens', () => {
    const odd = ev('model/usage', { inputTokens: 10, outputTokens: 5, totalTokens: 999 });
    expect(deriveTokenUsage([odd])).toEqual({
      inputTokens: 10,
      outputTokens: 5,
    });
  });

  it('不相干的事件與四格都沒東西的那顆回同一個參照', () => {
    const state = tokenUsageUnit.apply(tokenUsageUnit.init(), usage(3, 4));
    expect(tokenUsageUnit.apply(state, ev('model/end'))).toBe(state);
    expect(tokenUsageUnit.apply(state, usage(0, 0))).toBe(state);
  });

  describe('四桶（#724）', () => {
    const cached = (input: number, output: number, read?: number, write?: number) =>
      ev('model/usage', {
        inputTokens: input,
        outputTokens: output,
        totalTokens: input + output + (read ?? 0) + (write ?? 0),
        ...(read === undefined ? {} : { cacheReadTokens: read }),
        ...(write === undefined ? {} : { cacheWriteTokens: write }),
      });

    it('inputTokens 只是未快取那一桶（照 dsh），兩個快取桶各自累計', () => {
      expect(deriveTokenUsage([cached(100, 10, 900, 0), cached(50, 5, 450, 200)])).toEqual({
        inputTokens: 100 + 50,
        outputTokens: 15,
        cacheReadTokens: 1350,
        cacheWriteTokens: 200,
      });
    });

    it('快取欄位缺席＝沒記：沒有任何一顆報過，總帳就沒有那一格', () => {
      const totals = deriveTokenUsage([usage(10, 1), usage(20, 2)]);
      expect(totals).not.toHaveProperty('cacheReadTokens');
      expect(totals).not.toHaveProperty('cacheWriteTokens');
    });

    it('有一顆報過，那一格就出現，沒報的呼叫不當 0 加', () => {
      expect(deriveTokenUsage([usage(10, 1), cached(20, 2, 80)])).toEqual({
        inputTokens: 10 + 20,
        outputTokens: 3,
        cacheReadTokens: 80,
      });
    });

    it('報了 0 也算有報：快取讀那格是 0 而不是缺席', () => {
      expect(deriveTokenUsage([cached(10, 1, 0)])).toMatchObject({ cacheReadTokens: 0 });
    });

    it('只有快取桶有東西的那顆（未快取與輸出是 0）照樣加', () => {
      expect(deriveTokenUsage([cached(0, 0, 500)])).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 500,
      });
    });

    it('狀態版本是 3（inputTokens 換成未快取的語義）', () => {
      expect(tokenUsageUnit.stateVersion).toBe(3);
    });
  });
});
