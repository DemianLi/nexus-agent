// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { ABORTED_BEFORE_DISPATCH_CODE, ASK_USER_QUESTION } from '@/lib/question-view';
import { abortedToolLabel } from '@/lib/tool-aborted';

describe('abortedToolLabel（#2247）', () => {
  it('兩個碼各有自己的字', () => {
    expect(abortedToolLabel('execute', 'ABORTED')).toBe('已停止');
    expect(abortedToolLabel('execute', ABORTED_BEFORE_DISPATCH_CODE)).toBe('沒有執行');
  });

  it('別的碼、沒帶碼都不是被中止', () => {
    expect(abortedToolLabel('execute', 'FS_NO_SPACE')).toBeUndefined();
    expect(abortedToolLabel('execute', undefined)).toBeUndefined();
  });

  it('提問不在內', () => {
    expect(abortedToolLabel(ASK_USER_QUESTION, 'ABORTED')).toBeUndefined();
    expect(abortedToolLabel(ASK_USER_QUESTION, ABORTED_BEFORE_DISPATCH_CODE)).toBeUndefined();
  });
});
