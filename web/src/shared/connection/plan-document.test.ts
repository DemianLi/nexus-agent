// @vitest-environment node
import type { ToolEntry } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { UNTITLED_PLAN, planDocument, submittedPlanOf } from '@/shared/connection/plan-document';

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
