import { THREAD_AT_CAPACITY } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { THREAD_AT_CAPACITY_TEXT, threadCapacityText } from '@/lib/thread-capacity';

describe('threadCapacityText（#1478）', () => {
  it('thread 數滿了：回給使用者看的那一句', () => {
    expect(threadCapacityText(THREAD_AT_CAPACITY)).toBe(THREAD_AT_CAPACITY_TEXT);
  });

  it('那一句提管理者，不提上限數字，也不提重啟', () => {
    expect(THREAD_AT_CAPACITY_TEXT).toContain('管理者');
    expect(THREAD_AT_CAPACITY_TEXT).not.toMatch(/\d/u);
    expect(THREAD_AT_CAPACITY_TEXT).not.toContain('重啟');
    expect(THREAD_AT_CAPACITY_TEXT).not.toContain('serve');
  });

  it('其他碼與沒有碼：回 undefined，照各處原本的講法', () => {
    expect(threadCapacityText('unknown_error')).toBeUndefined();
    expect(threadCapacityText('thread_not_found')).toBeUndefined();
    expect(threadCapacityText(undefined)).toBeUndefined();
  });
});
