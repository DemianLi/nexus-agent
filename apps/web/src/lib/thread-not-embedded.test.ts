import { THREAD_IS_SUBAGENT, THREAD_NOT_EMBEDDED } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { NEW_CONVERSATION_LABEL } from '@/embed/embedded-chat';
import { THREAD_NOT_EMBEDDED_TEXT, threadNotEmbeddedText } from '@/lib/thread-not-embedded';

describe('不是嵌入版開的那一句（#2382）', () => {
  it('只認這個碼', () => {
    expect(threadNotEmbeddedText(THREAD_NOT_EMBEDDED)).toBe(THREAD_NOT_EMBEDDED_TEXT);
    expect(threadNotEmbeddedText(THREAD_IS_SUBAGENT)).toBeUndefined();
    expect(threadNotEmbeddedText(undefined)).toBeUndefined();
  });

  it('叫人按「新對話」，不叫人再試，不提 thread 與嵌入', () => {
    expect(THREAD_NOT_EMBEDDED_TEXT).toContain(`「${NEW_CONVERSATION_LABEL}」`);
    expect(THREAD_NOT_EMBEDDED_TEXT).not.toContain('再試');
    expect(THREAD_NOT_EMBEDDED_TEXT).not.toMatch(/thread|embed|嵌入|設定檔/iu);
  });
});
