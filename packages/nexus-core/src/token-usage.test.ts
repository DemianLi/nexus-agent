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

  it('沒有 model/usage 就是兩個 0', () => {
    expect(deriveTokenUsage([ev('turn/start', { kind: 'message', text: '嗨' })])).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  /** `totalTokens` 不讀：總量由讀的那一側把兩格加起來，同 dsh 的 `StatsPills`。 */
  it('不讀 totalTokens', () => {
    const odd = ev('model/usage', { inputTokens: 10, outputTokens: 5, totalTokens: 999 });
    expect(deriveTokenUsage([odd])).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it('不相干的事件與兩格都是 0 的那顆回同一個參照', () => {
    const state = tokenUsageUnit.apply(tokenUsageUnit.init(), usage(3, 4));
    expect(tokenUsageUnit.apply(state, ev('model/end'))).toBe(state);
    expect(tokenUsageUnit.apply(state, usage(0, 0))).toBe(state);
  });
});
