// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { catalogToolSection } from '@/test/tool-catalog';

import { SANDBOX_ESCALATION_TOOL, escalationReason } from '@/lib/sandbox-escalation';

/** 沙箱升級的核准卡（#1292）。工具名照 plugin 抄，這裡從模型實際收到的目錄讀回來對。 */

describe('跟 plugin 對得上', () => {
  it('目錄裡有這顆工具，`sandbox_permissions` 的 enum 有 workspace-write', () => {
    const section = catalogToolSection(SANDBOX_ESCALATION_TOOL);
    expect(section).toContain('"sandbox_permissions"');
    expect(section).toContain('"workspace-write"');
  });
});

describe('escalationReason', () => {
  const reason = '把 "/x/a.txt" 的檔案政策升到 workspace-write，只蓋這一次：要寫設定檔';
  const action = (name: string, description?: string) => ({
    name,
    args: {},
    ...(description === undefined ? {} : { description }),
  });

  it('帶描述的升級：描述原樣', () => {
    expect(escalationReason(action(SANDBOX_ESCALATION_TOOL, reason))).toBe(reason);
  });

  it('沒有描述、或不是升級：沒有值（照一般核准卡）', () => {
    expect(escalationReason(action(SANDBOX_ESCALATION_TOOL))).toBeUndefined();
    expect(escalationReason(action('write_file', '基座 HITL 的描述'))).toBeUndefined();
  });
});
