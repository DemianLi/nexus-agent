import { THREAD_LOG_BUSY, THREAD_LOG_TOO_LARGE } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import {
  THREAD_LOG_BUSY_TEXT,
  THREAD_LOG_TOO_LARGE_TEXT,
  threadLogBudgetText,
  threadLogBusyText,
  threadLogTooLargeText,
} from '@/lib/thread-log-budget';

describe('日誌超過額度的兩句（#2203）', () => {
  it('各認各的碼，threadLogBudgetText 兩個都認', () => {
    expect(threadLogTooLargeText(THREAD_LOG_TOO_LARGE)).toBe(THREAD_LOG_TOO_LARGE_TEXT);
    expect(threadLogTooLargeText(THREAD_LOG_BUSY)).toBeUndefined();
    expect(threadLogBusyText(THREAD_LOG_BUSY)).toBe(THREAD_LOG_BUSY_TEXT);
    expect(threadLogBusyText(THREAD_LOG_TOO_LARGE)).toBeUndefined();
    expect(threadLogBudgetText(THREAD_LOG_TOO_LARGE)).toBe(THREAD_LOG_TOO_LARGE_TEXT);
    expect(threadLogBudgetText(THREAD_LOG_BUSY)).toBe(THREAD_LOG_BUSY_TEXT);
  });

  it.each([THREAD_LOG_TOO_LARGE_TEXT, THREAD_LOG_BUSY_TEXT])(
    '%s：說對話沒有壞、提管理者，不提數字與 serve 的用語',
    (text) => {
      expect(text).toContain('對話沒有壞');
      expect(text).toContain('管理者');
      expect(text).not.toMatch(/\d/u);
      expect(text).not.toMatch(/serve|額度|日誌|重啟/u);
    },
  );

  it('只有暫時的那一句叫人稍後再試', () => {
    expect(THREAD_LOG_BUSY_TEXT).toContain('稍後再試');
    expect(THREAD_LOG_TOO_LARGE_TEXT).not.toContain('再試');
  });

  it('其他碼與沒有碼：回 undefined', () => {
    expect(threadLogBudgetText('unknown_error')).toBeUndefined();
    expect(threadLogBudgetText(undefined)).toBeUndefined();
  });
});
