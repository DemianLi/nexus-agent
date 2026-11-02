import { THREAD_AT_CAPACITY, THREAD_HISTORY_TOO_DEEP, THREAD_IS_SUBAGENT } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import {
  THREAD_HISTORY_TOO_DEEP_TEXT,
  threadHistoryTooDeepText,
} from '@/lib/thread-history-too-deep';

describe('threadHistoryTooDeepText（#1753）', () => {
  it('歷史太深：回給使用者看的那一句', () => {
    expect(threadHistoryTooDeepText(THREAD_HISTORY_TOO_DEEP)).toBe(THREAD_HISTORY_TOO_DEEP_TEXT);
  });

  it('那一句講打不開、指向新對話，不提層數、上限、thread 或日誌', () => {
    expect(THREAD_HISTORY_TOO_DEEP_TEXT).toContain('打不開');
    expect(THREAD_HISTORY_TOO_DEEP_TEXT).toContain('新的對話');
    expect(THREAD_HISTORY_TOO_DEEP_TEXT).not.toMatch(/thread|wire|日誌|上限|層|\d/iu);
  });

  it('其他碼與沒有碼：回 undefined', () => {
    expect(threadHistoryTooDeepText(THREAD_AT_CAPACITY)).toBeUndefined();
    expect(threadHistoryTooDeepText(THREAD_IS_SUBAGENT)).toBeUndefined();
    expect(threadHistoryTooDeepText('unknown_error')).toBeUndefined();
    expect(threadHistoryTooDeepText(undefined)).toBeUndefined();
  });
});
