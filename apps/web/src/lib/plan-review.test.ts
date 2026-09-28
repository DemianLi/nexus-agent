// @vitest-environment node
import { readFileSync } from 'node:fs';

import type { QuestionItem, ToolEntry } from '@nexus/wire';
import { UNFINISHED_TOOL_TEXT } from '@nexus/wire';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AUTO_OPENED_KEY,
  LEGACY_PLAN_REJECTED_TEXT,
  MAX_AUTO_OPENED,
  PLAN_KEEP_PLANNING_LEAD,
  PLAN_REVIEW_DISMISSED_TEXT,
  UNTITLED_PLAN,
  markAutoOpened,
  planDocument,
  planOutcomeOf,
  planReviewOf,
  submittedPlanOf,
  wasAutoOpened,
} from '@/lib/plan-review';
import { WITHDRAWN_TOOL_REASON } from '@/lib/question-view';
import { memoryStorage } from '@/test/right-sidebar';

/** 計劃審核（#654）的規則：認得審核、標題與摘要、從工具卡讀結果、自動打開過哪幾份。 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const PLAN_MODE_SOURCE = '../../../../packages/nexus-plugin-plan-mode/src/index.ts';

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

describe('標題與摘要', () => {
  it('標題是第一個 # 標題的純文字，摘要是第一段的純文字：markdown 記號都拿掉', () => {
    const plan = planDocument(
      '# 改**登入**頁\n\n先把 [文案](https://x.test) 改成 `中文`，**再**補測試。\n\n## 步驟\n\n- 一\n- 二',
    );
    expect(plan.title).toBe('改登入頁');
    expect(plan.summary).toBe('先把 文案 改成 中文，再補測試。');
  });

  it('標題下面直接是清單：摘要是第一個項目', () => {
    expect(planDocument('# 改登入頁\n\n- 改成中文\n- 補測試').summary).toBe('改成中文');
  });

  it('沒有 # 標題：標題寫「計劃」，摘要照樣是第一段', () => {
    expect(planDocument('先改文案。\n\n再補測試。')).toMatchObject({
      title: UNTITLED_PLAN,
      summary: '先改文案。',
    });
    expect(planDocument('## 小標題\n\n內容').title).toBe(UNTITLED_PLAN);
  });

  it('只有標題：摘要是空的，不重複標題', () => {
    expect(planDocument('# 改登入頁').summary).toBe('');
  });
});

describe('交出的計劃（計劃卡）', () => {
  it('參數解得開、以 # 標題開頭才算', () => {
    expect(submittedPlanOf(tool({}))?.title).toBe('改登入頁');
    expect(submittedPlanOf(tool({ input: '{"plan":"沒有標題"}' }))).toBeUndefined();
    expect(submittedPlanOf(tool({ input: '{"plan":' }))).toBeUndefined();
    expect(submittedPlanOf(tool({ input: '{"plan":3}' }))).toBeUndefined();
    expect(submittedPlanOf(tool({ name: 'write_file' }))).toBeUndefined();
  });
});

describe('審核結果', () => {
  const failed = (said: string) => tool({ status: 'failed', error: `Error: ${said}` });

  it('工具跑完就是同意（新舊兩條路都一樣）', () => {
    expect(planOutcomeOf(tool({ status: 'done', text: '計劃已獲准' }))).toBe('approved');
  });

  it('關掉審核、選了繼續規劃（有沒有意見）、舊路由的拒絕：都是要求修改', () => {
    expect(planOutcomeOf(failed(PLAN_REVIEW_DISMISSED_TEXT))).toBe('revise');
    expect(planOutcomeOf(failed(`${PLAN_KEEP_PLANNING_LEAD}修改計劃後再提交一次。`))).toBe(
      'revise',
    );
    expect(planOutcomeOf(failed(`${PLAN_KEEP_PLANNING_LEAD}使用者的意見：先別動 API`))).toBe(
      'revise',
    );
    expect(planOutcomeOf(failed(LEGACY_PLAN_REJECTED_TEXT))).toBe('revise');
  });

  it('這一輪被停掉：收回的那一句、折疊器補的那一句', () => {
    expect(planOutcomeOf(failed(WITHDRAWN_TOOL_REASON))).toBe('stopped');
    expect(planOutcomeOf(tool({ status: 'failed', error: UNFINISHED_TOOL_TEXT }))).toBe('stopped');
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
    expect(planOutcomeOf(tool({ status: 'failed', text: PLAN_REVIEW_DISMISSED_TEXT }))).toBe(
      'revise',
    );
  });
});

describe('抄來的字跟 harness 對得上（web 不相依那兩個套件，改了那邊這裡要紅）', () => {
  const source = read(PLAN_MODE_SOURCE);

  it('工具名、關掉審核那一句', () => {
    expect(/EXIT_PLAN_MODE_TOOL_NAME = '([^']*)'/.exec(source)?.[1]).toBe('exit_plan_mode');
    expect(/PLAN_REVIEW_DISMISSED_MESSAGE =\s*'([^']*)'/.exec(source)?.[1]).toBe(
      PLAN_REVIEW_DISMISSED_TEXT,
    );
  });

  it('繼續規劃的兩種說法都以同一個開頭起頭', () => {
    expect(
      /PLAN_KEEP_PLANNING_MESSAGE = '([^']*)'/
        .exec(source)?.[1]
        ?.startsWith(PLAN_KEEP_PLANNING_LEAD),
    ).toBe(true);
    expect(source).toContain(`\`${PLAN_KEEP_PLANNING_LEAD}使用者的意見：\${feedback}\``);
  });

  it('舊路由的拒絕：core 的閘門用這個樣板', () => {
    const approval = read('../../../../packages/nexus-core/src/approval.ts');
    expect(approval).toContain('`有人看過並拒絕了 "${exec.name}"。`');
    expect(LEGACY_PLAN_REJECTED_TEXT).toBe('有人看過並拒絕了 "exit_plan_mode"。');
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
