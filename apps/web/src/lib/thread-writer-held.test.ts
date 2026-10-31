import { THREAD_AT_CAPACITY, THREAD_WRITER_HELD } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { THREAD_WRITER_HELD_TEXT, threadWriterHeldText } from '@/lib/thread-writer-held';

describe('寫租約被別的寫入者握著的那一句（#2214）', () => {
  it('只認這個碼', () => {
    expect(threadWriterHeldText(THREAD_WRITER_HELD)).toBe(THREAD_WRITER_HELD_TEXT);
    expect(threadWriterHeldText(THREAD_AT_CAPACITY)).toBeUndefined();
    expect(threadWriterHeldText(undefined)).toBeUndefined();
  });

  it('說對話沒有壞與下一步，不提數字與 serve 的用語', () => {
    expect(THREAD_WRITER_HELD_TEXT).toContain('對話沒有壞');
    expect(THREAD_WRITER_HELD_TEXT).toContain('再試');
    expect(THREAD_WRITER_HELD_TEXT).not.toMatch(/\d/u);
    expect(THREAD_WRITER_HELD_TEXT).not.toMatch(/serve|寫入者|行程|租約|thread/u);
  });
});
