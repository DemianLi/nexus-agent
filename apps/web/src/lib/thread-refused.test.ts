import { describe, expect, it } from 'vitest';

import { THREAD_REFUSED_TEXT } from '@/lib/thread-refused';

describe('下行被拒、碼沒有專用文案的那一句（#2222）', () => {
  it('說還在重試與下一步，不提數字與 serve 的用語', () => {
    expect(THREAD_REFUSED_TEXT).toContain('重試');
    expect(THREAD_REFUSED_TEXT).toContain('聯絡管理者');
    expect(THREAD_REFUSED_TEXT).not.toMatch(/\d/u);
    expect(THREAD_REFUSED_TEXT).not.toMatch(/serve|thread|下行|unknown/u);
  });
});
