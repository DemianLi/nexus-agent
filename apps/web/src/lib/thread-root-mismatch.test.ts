import { THREAD_ROOT_MISMATCH, THREAD_WRITER_HELD } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { THREAD_ROOT_MISMATCH_TEXT, threadRootMismatchText } from '@/lib/thread-root-mismatch';

describe('可寫根接不上的那一句（#2222）', () => {
  it('只認這個碼', () => {
    expect(threadRootMismatchText(THREAD_ROOT_MISMATCH)).toBe(THREAD_ROOT_MISMATCH_TEXT);
    expect(threadRootMismatchText(THREAD_WRITER_HELD)).toBeUndefined();
    expect(threadRootMismatchText(undefined)).toBeUndefined();
  });

  it('涵蓋 home 與工作區、指向管理者，不叫人再試，不提路徑與 serve 的用語', () => {
    expect(THREAD_ROOT_MISMATCH_TEXT).toContain('home');
    expect(THREAD_ROOT_MISMATCH_TEXT).toContain('工作區');
    expect(THREAD_ROOT_MISMATCH_TEXT).toMatch(/請聯絡管理者。$/u);
    expect(THREAD_ROOT_MISMATCH_TEXT).not.toContain('再試');
    expect(THREAD_ROOT_MISMATCH_TEXT).not.toMatch(/\/|serve|thread|--workspace/u);
  });
});
