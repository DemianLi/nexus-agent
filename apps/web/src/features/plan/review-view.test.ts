// @vitest-environment node
import type { QuestionItem, ToolEntry } from '@nexus/wire';
import {
  APPROVAL_REJECTED_TEMPLATE,
  EXIT_PLAN_MODE_TOOL_NAME,
  PLAN_FEEDBACK_PREFIX,
  PLAN_KEEP_PLANNING_MESSAGE,
  PLAN_REVIEW_DISMISSED_MESSAGE,
  UNFINISHED_TOOL_CODE,
  UNFINISHED_TOOL_TEXT,
} from '@nexus/wire';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AUTO_OPENED_KEY,
  LEGACY_PLAN_REJECTED_TEXT,
  LEGACY_PLAN_REVIEW_DISMISSED_TEXT,
  MAX_AUTO_OPENED,
  PLAN_KEEP_PLANNING_LEAD,
  PLAN_REVIEW_DISMISSED_TEXT,
  markAutoOpened,
  planOutcomeOf,
  planReviewOf,
  wasAutoOpened,
} from '@/features/plan/review-view';
import { ABORTED_BEFORE_DISPATCH_CODE } from '@/features/question/view';
import { memoryStorage } from '@/test/right-sidebar';

/** 計劃審核（#654）的規則：認得審核、標題與摘要、從工具卡讀結果、自動打開過哪幾份。 */

const review = (patch: Partial<QuestionItem> = {}): QuestionItem => ({
  id: 'plan-review',
  question: '同意這份計劃並離開計劃模式？',
  detail: '# 改登入頁\n\n先改文案。',
  options: [{ label: '同意' }, { label: '繼續規劃' }],
  intent: { kind: 'plan-review', approve: '同意', callId: 'call_1' },
  ...patch,
});

function tool(patch: Partial<ToolEntry>): ToolEntry {
  return {
    kind: 'tool',
    id: 'tool-call_1',
    callId: 'call_1',
    name: 'exit_plan_mode',
    input: JSON.stringify({ plan: '# 改登入頁\n\n先改文案。' }),
    status: 'suspended',
    attribution: { kind: 'root' },
    ...patch,
  };
}

describe('認得審核', () => {
  it('帶 plan-review 意圖、全文、同意的標籤：認得，同意照意圖指名的標籤', () => {
    expect(planReviewOf([review()])).toEqual({
      questionId: 'plan-review',
      approve: '同意',
      plan: '# 改登入頁\n\n先改文案。',
      callId: 'call_1',
    });
    const renamed = review({
      options: [{ label: '核可' }, { label: '再想想' }],
      intent: { kind: 'plan-review', approve: '核可' },
    });
    expect(planReviewOf([renamed])).toMatchObject({ approve: '核可', callId: undefined });
    expect(
      planReviewOf([review({ intent: { kind: 'plan-review', approve: '同意', callId: '' } })])
        ?.callId,
    ).toBeUndefined();
  });

  it('任何一條不成立就照一般提問', () => {
    expect(planReviewOf([review(), { ...review(), id: 'b' }])).toBeUndefined();
    expect(planReviewOf([review({ intent: undefined })])).toBeUndefined();
    expect(planReviewOf([review({ detail: undefined })])).toBeUndefined();
    expect(planReviewOf([review({ multiSelect: true })])).toBeUndefined();
    expect(
      planReviewOf([review({ options: [{ label: '同意' }, { label: 'b' }, { label: 'c' }] })]),
    ).toBeUndefined();
    expect(planReviewOf([review({ options: [{ label: '好' }] })])).toBeUndefined();
  });
});

describe('審核結果', () => {
  const failed = (said: string) => tool({ status: 'failed', error: `Error: ${said}` });

  it('工具跑完、不是關掉審核那一句：同意（新舊兩條路都一樣）', () => {
    expect(planOutcomeOf(tool({ status: 'done', text: '計劃已獲准' }))).toBe('approved');
    expect(
      planOutcomeOf(
        tool({ status: 'done', text: '計劃已獲准，離開計劃模式；從你的下一步起照計劃執行。' }),
      ),
    ).toBe('approved');
  });

  it('關掉審核的新形狀（#1607 之後，工具跑完帶新字）：要求修改', () => {
    expect(planOutcomeOf(tool({ status: 'done', text: PLAN_REVIEW_DISMISSED_TEXT }))).toBe(
      'revise',
    );
  });

  it('關掉審核、選了繼續規劃（有沒有意見）、舊路由的拒絕：都是要求修改', () => {
    expect(planOutcomeOf(failed(LEGACY_PLAN_REVIEW_DISMISSED_TEXT))).toBe('revise');
    expect(planOutcomeOf(failed(`${PLAN_KEEP_PLANNING_LEAD}修改計劃後再提交一次。`))).toBe(
      'revise',
    );
    expect(planOutcomeOf(failed(`${PLAN_KEEP_PLANNING_LEAD}使用者的意見：先別動 API`))).toBe(
      'revise',
    );
    expect(planOutcomeOf(failed(LEGACY_PLAN_REJECTED_TEXT))).toBe('revise');
  });

  it('這一輪被停掉：收回的那個碼、折疊器補的那個碼（比碼不比字）', () => {
    expect(
      planOutcomeOf(
        tool({
          status: 'failed',
          error: 'Error: tool call aborted before dispatch',
          errorCode: ABORTED_BEFORE_DISPATCH_CODE,
        }),
      ),
    ).toBe('stopped');
    expect(
      planOutcomeOf(
        tool({ status: 'failed', error: UNFINISHED_TOOL_TEXT, errorCode: UNFINISHED_TOOL_CODE }),
      ),
    ).toBe('stopped');
    // 同樣的字、沒有碼：不算停止。
    expect(planOutcomeOf(failed('tool call aborted before dispatch'))).toBeUndefined();
  });

  it('還在等、問人之前就被擋掉的：沒有結果', () => {
    expect(planOutcomeOf(tool({}))).toBeUndefined();
    expect(planOutcomeOf(tool({ status: 'running' }))).toBeUndefined();
    expect(
      planOutcomeOf(failed('現在不在計劃模式，exit_plan_mode 沒有東西可以離開')),
    ).toBeUndefined();
    expect(planOutcomeOf(tool({ name: 'write_file', status: 'done' }))).toBeUndefined();
  });

  it('結果文字只在 `text`（沒有 `error`）也讀得到', () => {
    expect(planOutcomeOf(tool({ status: 'failed', text: LEGACY_PLAN_REVIEW_DISMISSED_TEXT }))).toBe(
      'revise',
    );
  });
});

describe('抄來的字跟 wire 對得上（wire 的值跟 plugin、core 一致由 harness 的 `wire-harness-facts.test.ts` 釘住，改了那邊這裡要紅）', () => {
  it('工具名、關掉審核那一句（#1607 之前是舊字、之後是新字，兩種都認；換成第三種要紅）', () => {
    expect(EXIT_PLAN_MODE_TOOL_NAME).toBe('exit_plan_mode');
    expect([LEGACY_PLAN_REVIEW_DISMISSED_TEXT, PLAN_REVIEW_DISMISSED_TEXT]).toContain(
      PLAN_REVIEW_DISMISSED_MESSAGE,
    );
  });

  it('繼續規劃的兩種說法都以同一個開頭起頭', () => {
    expect(PLAN_KEEP_PLANNING_MESSAGE.startsWith(PLAN_KEEP_PLANNING_LEAD)).toBe(true);
    expect(PLAN_FEEDBACK_PREFIX).toBe(`${PLAN_KEEP_PLANNING_LEAD}使用者的意見：`);
  });

  it('舊路由的拒絕：core 的閘門用這個樣板', () => {
    expect(APPROVAL_REJECTED_TEMPLATE).toBe('有人看過並拒絕了 "{name}"。');
    expect(LEGACY_PLAN_REJECTED_TEXT).toBe(
      APPROVAL_REJECTED_TEMPLATE.replace('{name}', 'exit_plan_mode'),
    );
  });
});

describe('自動打開過哪幾份', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('記下來就認得；只留最近的那幾份', () => {
    expect(wasAutoOpened('call_1')).toBe(false);
    markAutoOpened('call_1');
    expect(wasAutoOpened('call_1')).toBe(true);
    for (let i = 0; i < MAX_AUTO_OPENED; i += 1) markAutoOpened(`call_x${i}`);
    expect(wasAutoOpened('call_1')).toBe(false);
    expect(JSON.parse(localStorage.getItem(AUTO_OPENED_KEY) ?? '[]')).toHaveLength(MAX_AUTO_OPENED);
  });

  it('存的東西壞了、讀不到、寫不進：當成沒開過，不拋', () => {
    localStorage.setItem(AUTO_OPENED_KEY, '{壞掉');
    expect(wasAutoOpened('call_1')).toBe(false);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('localStorage', {
      ...memoryStorage(),
      getItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
    });
    expect(wasAutoOpened('call_1')).toBe(false);
    expect(() => markAutoOpened('call_1')).not.toThrow();
  });
});
