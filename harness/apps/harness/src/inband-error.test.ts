/**
 * 串流內錯誤信封的分類梯子（#1805）。梯子照 dsh `providerError`（`transport.ts:22-35`，`687f282e`）：每一階是「狀態條件或
 * `type`／字樣條件」，順序 `AUTH`、`QUOTA`、`RATE_LIMIT`、`CONTEXT_WINDOW_EXCEEDED`、`INVALID_REQUEST`、`SERVER`。
 */

import { describe, expect, it } from 'vitest';

import {
  classifyInbandError,
  isContextWindowExceededDetail,
  isQuotaExceededDetail,
} from './inband-error.js';

describe('classifyInbandError：type 與字串 code（沒有數字碼）', () => {
  it.each([
    [{ type: 'authentication_error' }, 'AUTH', 401],
    [{ type: 'permission_error' }, 'AUTH', 403],
    [{ type: 'rate_limit_error' }, 'RATE_LIMIT', 429],
    [{ type: 'invalid_request_error' }, 'INVALID_REQUEST', 400],
    [{ type: 'api_error' }, 'SERVER', 500],
    [{ type: 'overloaded_error' }, 'SERVER', 500],
    [{ type: 'x' }, 'SERVER', 500],
    [{}, 'SERVER', 500],
  ] as const)('%j → %s／%i', (error, code, status) => {
    expect(classifyInbandError({ ...error })).toMatchObject({ code, status });
  });

  it('不是物件（沒有 error 欄位的信封）→ SERVER／500', () => {
    expect(classifyInbandError(undefined)).toMatchObject({ code: 'SERVER', status: 500 });
  });

  it('字串型的 code 進 detail、數字型的不進：code: "insufficient_quota" 是 QUOTA', () => {
    expect(classifyInbandError({ code: 'insufficient_quota' })).toMatchObject({
      code: 'QUOTA',
      status: 402,
    });
  });
});

describe('classifyInbandError：數字碼（400–599）當成 dsh 的 status', () => {
  it.each([
    [401, 'AUTH', 401],
    [403, 'AUTH', 403],
    [402, 'QUOTA', 402],
    [429, 'RATE_LIMIT', 429],
    [400, 'INVALID_REQUEST', 400],
    [413, 'INVALID_REQUEST', 413],
    [500, 'SERVER', 500],
    [503, 'SERVER', 503],
    [422, 'HTTP_422', 422],
    [404, 'HTTP_404', 404],
  ] as const)('code: %i → %s／%i', (numeric, code, status) => {
    expect(classifyInbandError({ code: numeric, type: 'x' })).toMatchObject({ code, status });
  });

  it('status 欄位也認；600 與 200 不算數字碼', () => {
    expect(classifyInbandError({ status: 429 })).toMatchObject({ code: 'RATE_LIMIT' });
    expect(classifyInbandError({ code: 600 })).toMatchObject({ code: 'SERVER', status: 500 });
    expect(classifyInbandError({ code: 200 })).toMatchObject({ code: 'SERVER', status: 500 });
  });

  it('梯子的順序：先到的階贏（每一階是「或」）', () => {
    // 數字碼 503（SERVER 階）＋ type 是 AUTH 階 → AUTH；今天以前記 SERVER。
    expect(classifyInbandError({ code: 503, type: 'authentication_error' })).toMatchObject({
      code: 'AUTH',
      status: 401,
    });
    // 401 ＋ 額度字樣：AUTH 在 QUOTA 前面。
    expect(classifyInbandError({ code: 401, message: 'insufficient quota' })).toMatchObject({
      code: 'AUTH',
      status: 401,
    });
    // 429 ＋ 額度字樣：QUOTA 在 RATE_LIMIT 前面。
    expect(
      classifyInbandError({ code: 429, message: 'You exceeded your current quota' }),
    ).toMatchObject({
      code: 'QUOTA',
      status: 402,
    });
    // 500 ＋ rate_limit_error：RATE_LIMIT 在 SERVER 前面。
    expect(classifyInbandError({ code: 500, type: 'rate_limit_error' })).toMatchObject({
      code: 'RATE_LIMIT',
      status: 429,
    });
    // 超窗字樣在 INVALID_REQUEST 前面，載體狀態保留信封自己的 413。
    expect(
      classifyInbandError({
        code: 413,
        message: 'request is too large for the model context window',
      }),
    ).toMatchObject({ code: 'CONTEXT_WINDOW_EXCEEDED', status: 413, overflow: true });
  });
});

describe('字樣偵測（逐字照 dsh `isContextWindowExceededError`／`isQuotaExceededError`）', () => {
  it.each([
    "This model's maximum context length is 8192 tokens",
    'context_length_exceeded',
    'context window exceeded',
    'prompt is too long for this model',
    'The input exceeds the model context window',
  ])('超窗：%s', (detail) => {
    expect(isContextWindowExceededDetail(detail)).toBe(true);
  });

  it.each(['rate limit reached', 'invalid max_tokens value', 'the context was loaded', ''])(
    '不是超窗：%s',
    (detail) => {
      expect(isContextWindowExceededDetail(detail)).toBe(false);
    },
  );

  it.each([
    'insufficient_quota',
    'Your account has insufficient balance',
    'quota exceeded',
    'usage limit reached',
    'You exceeded your current quota',
    'credits exhausted',
    'out of credits',
  ])('額度：%s', (detail) => {
    expect(isQuotaExceededDetail(detail)).toBe(true);
  });

  it.each(['rate limit exceeded, retry later', 'too many requests', ''])(
    '不是額度：%s',
    (detail) => {
      expect(isQuotaExceededDetail(detail)).toBe(false);
    },
  );
});
