/**
 * `llmFailure`／`thrownMessage`：記失敗的那一步不能拋，欄位壞了丟掉那一格（#1557，N0471／N0480）。
 */

import { describe, expect, it } from 'vitest';

import { LLM_FAILURE_FALLBACK_MESSAGE, llmFailure, thrownMessage } from './llm-failure.js';

describe('thrownMessage', () => {
  it('Error 取 message，其他值 String()', () => {
    expect(thrownMessage(new Error('壞了'))).toBe('壞了');
    expect(thrownMessage('字串')).toBe('字串');
    expect(thrownMessage(42)).toBe('42');
  });

  it('toString 會拋錯的物件：固定字，不拋', () => {
    const hostile = {
      toString() {
        throw new Error('boom');
      },
    };
    expect(thrownMessage(hostile)).toBe(LLM_FAILURE_FALLBACK_MESSAGE);
    expect(thrownMessage(Object.create(null))).toBe(LLM_FAILURE_FALLBACK_MESSAGE);
  });

  it('message 的存取子拋錯、或訊息是空字串：固定字', () => {
    const getter = new Error('x');
    Object.defineProperty(getter, 'message', {
      get() {
        throw new Error('boom');
      },
    });
    expect(thrownMessage(getter)).toBe(LLM_FAILURE_FALLBACK_MESSAGE);
    expect(thrownMessage(new Error(''))).toBe(LLM_FAILURE_FALLBACK_MESSAGE);
    expect(thrownMessage('')).toBe(LLM_FAILURE_FALLBACK_MESSAGE);
  });
});

describe('llmFailure', () => {
  it('合格的欄位原樣帶，而且是凍結的', () => {
    const failure = llmFailure({
      message: '限流',
      code: 'RATE_LIMIT',
      status: 429,
      requestId: 'r-1',
    });
    expect(failure).toEqual({ message: '限流', code: 'RATE_LIMIT', status: 429, requestId: 'r-1' });
    expect(Object.isFrozen(failure)).toBe(true);
  });

  it.each([Number.NaN, 99, 600, 429.5, Number.POSITIVE_INFINITY, '429', null])(
    'status 是 %s：丟掉那一格',
    (status) => {
      expect(llmFailure({ message: 'm', code: 'C', status })).toEqual({ message: 'm', code: 'C' });
    },
  );

  it.each([100, 429, 503, 599])('status %i 在範圍內：保留', (status) => {
    expect(llmFailure({ message: 'm', code: 'C', status })).toHaveProperty('status', status);
  });

  it('message 空或不是字串：固定字；code 空或不是字串：UNKNOWN', () => {
    expect(llmFailure({ message: '', code: 'C' }).message).toBe(LLM_FAILURE_FALLBACK_MESSAGE);
    expect(llmFailure({ message: 1, code: 'C' }).message).toBe(LLM_FAILURE_FALLBACK_MESSAGE);
    expect(llmFailure({ message: 'm', code: '' }).code).toBe('UNKNOWN');
    expect(llmFailure({ message: 'm', code: undefined }).code).toBe('UNKNOWN');
  });

  it('requestId 只收非空字串，空字串整格不帶', () => {
    expect(llmFailure({ message: 'm', code: 'C', requestId: '' })).not.toHaveProperty('requestId');
    expect(llmFailure({ message: 'm', code: 'C', requestId: 5 })).not.toHaveProperty('requestId');
  });
});
