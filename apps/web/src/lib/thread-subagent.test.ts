import { THREAD_AT_CAPACITY, THREAD_IS_SUBAGENT } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { THREAD_IS_SUBAGENT_TEXT, threadSubagentText } from '@/lib/thread-subagent';

describe('threadSubagentText（#1708）', () => {
  it('子代理的會話：回給使用者看的那一句', () => {
    expect(threadSubagentText(THREAD_IS_SUBAGENT)).toBe(THREAD_IS_SUBAGENT_TEXT);
  });

  it('那一句指回主對話，不提 thread、wire 或命令名', () => {
    expect(THREAD_IS_SUBAGENT_TEXT).toContain('主對話');
    expect(THREAD_IS_SUBAGENT_TEXT).not.toMatch(/thread|subagent|wire/iu);
  });

  it('其他碼與沒有碼：回 undefined', () => {
    expect(threadSubagentText(THREAD_AT_CAPACITY)).toBeUndefined();
    expect(threadSubagentText('thread_not_found')).toBeUndefined();
    expect(threadSubagentText(undefined)).toBeUndefined();
  });
});
