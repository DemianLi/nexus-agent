// @vitest-environment node
import type { PendingInput } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { pendingLabel } from '@/lib/pending-label';

/** 面板名稱與狀態列唸的是同一句（§8）。 */

const question = (intent?: { kind: 'plan-review'; approve: string }): PendingInput =>
  ({
    kind: 'question',
    interruptId: 'q',
    namespace: [],
    questions: [
      {
        id: 'plan-review',
        question: '同意這份計劃並離開計劃模式？',
        detail: '# 計劃',
        options: [{ label: '同意' }, { label: '繼續規劃' }],
        ...(intent === undefined ? {} : { intent }),
      },
    ],
  }) as unknown as PendingInput;

describe('面板名稱', () => {
  it('計劃審核叫「計劃待審」，兩個以上照樣帶跨面板進度（#654 二-Q2）', () => {
    const review = question({ kind: 'plan-review', approve: '同意' });
    expect(pendingLabel(review, { index: 0, total: 1 })).toBe('計劃待審');
    expect(pendingLabel(review, { index: 1, total: 2 })).toBe('計劃待審（2／2）');
  });

  it('認不出意圖的照一般提問', () => {
    expect(pendingLabel(question(), { index: 0, total: 1 })).toBe('有 1 個問題要你回答');
  });
});
