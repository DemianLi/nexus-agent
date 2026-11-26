// @vitest-environment node
import type { PendingInput } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { pendingHead, pendingLabel } from '@/features/status/pending-label';

/** 面板的 `aria-label` 與狀態列唸的是同一句（§8）；看得到的名稱列是它的縮寫（#3035）。 */

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

const approval = (name: string): PendingInput =>
  ({
    kind: 'approval',
    interruptId: 'a',
    namespace: [],
    actions: [{ name, args: {} }],
    allowedDecisions: ['approve', 'reject'],
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

  it('沙箱升級不露工具名（#1292），其他工具照舊是工具名', () => {
    expect(pendingLabel(approval('request_sandbox_escalation'), { index: 0, total: 1 })).toBe(
      '等待核准：要求放寬檔案權限',
    );
    expect(pendingLabel(approval('write_file'), { index: 1, total: 2 })).toBe(
      '等待核准：write_file（2／2）',
    );
  });
});

describe('名稱列看得到的縮寫（#3035）', () => {
  it('核准：種類、工具名標籤、哪個子代理要的、跨面板進度', () => {
    expect(
      pendingHead(approval('write_file'), { index: 0, total: 2 }, '子代理「explore」'),
    ).toEqual({
      kind: '等待核准',
      tools: [{ text: 'write_file', code: true }],
      asker: '子代理「explore」',
      position: '（1／2）',
    });
  });

  it('沙箱升級的名稱是一句話，不畫成工具名標籤', () => {
    expect(
      pendingHead(approval('request_sandbox_escalation'), { index: 0, total: 1 }).tools,
    ).toEqual([{ text: '要求放寬檔案權限', code: false }]);
  });

  it('提問只講幾個問題，計劃審核叫「計劃待審」；兩種都沒有工具名', () => {
    expect(pendingHead(question(), { index: 1, total: 2 })).toEqual({
      kind: '1 個問題',
      tools: [],
      position: '（2／2）',
    });
    expect(
      pendingHead(question({ kind: 'plan-review', approve: '同意' }), { index: 0, total: 1 }),
    ).toEqual({
      kind: '計劃待審',
      tools: [],
      position: '',
    });
  });
});
