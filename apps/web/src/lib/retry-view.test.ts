import type { WireLlmRetry } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { RETRYING_NOW_TEXT, retryNoticeText, retryRemainingMs } from '@/lib/retry-view';

const retry = (over: Partial<WireLlmRetry> = {}): WireLlmRetry => ({
  retryId: 'r1',
  retry: 1,
  maxRetries: 2,
  delayMs: 3000,
  code: 'TIMEOUT',
  ...over,
});

describe('retryRemainingMs', () => {
  it('從收到的時刻起算，過了終點是 0 不是負的', () => {
    expect(retryRemainingMs(retry(), 1000, 1000)).toBe(3000);
    expect(retryRemainingMs(retry(), 1000, 2200)).toBe(1800);
    expect(retryRemainingMs(retry(), 1000, 4000)).toBe(0);
    expect(retryRemainingMs(retry(), 1000, 9000)).toBe(0);
  });

  it('不讀伺服器的 since：時鐘差再多倒數也一樣', () => {
    expect(retryRemainingMs(retry({ since: 1 }), 1000, 1000)).toBe(3000);
    expect(retryRemainingMs(retry({ since: 9_999_999_999 }), 1000, 1000)).toBe(3000);
  });
});

describe('retryNoticeText', () => {
  it('原因、無條件進位的秒數、第幾次', () => {
    expect(retryNoticeText(retry(), 3000)).toBe('逾時，3 秒後重試（第 1／2 次）');
    expect(retryNoticeText(retry(), 1001)).toBe('逾時，2 秒後重試（第 1／2 次）');
    expect(retryNoticeText(retry(), 300)).toBe('逾時，1 秒後重試（第 1／2 次）');
  });

  it('倒數走完：寫「正在重試」，不寫 0 秒', () => {
    expect(retryNoticeText(retry({ retry: 2 }), 0)).toBe(
      `逾時，${RETRYING_NOW_TEXT}（第 2／2 次）`,
    );
    expect(retryNoticeText(retry(), 0)).not.toContain('0 秒');
  });

  it('失敗碼沿用失敗輪標頭那張表：認得的換中文、HTTP_<n> 寫 HTTP n、不認得的原樣', () => {
    expect(retryNoticeText(retry({ code: 'TRANSPORT' }), 1000)).toContain('連線失敗');
    expect(retryNoticeText(retry({ code: 'RATE_LIMIT' }), 1000)).toContain('被限流');
    expect(retryNoticeText(retry({ code: 'SERVER' }), 1000)).toContain('服務端錯誤');
    expect(retryNoticeText(retry({ code: 'HTTP_503' }), 1000)).toContain('HTTP 503');
    expect(retryNoticeText(retry({ code: 'WEIRD_NEW_CODE' }), 1000)).toContain('WEIRD_NEW_CODE');
  });
});
