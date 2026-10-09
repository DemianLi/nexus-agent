// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { catalogToolSection } from '@/test/tool-catalog';

import {
  FULL_ACCESS_MODE,
  SANDBOX_ESCALATION_TOOL,
  escalationView,
} from '@/lib/sandbox-escalation';

/** 沙箱升級的核准卡（#1292）。工具名與模式字面照 plugin 抄，這裡從模型實際收到的目錄讀回來對。 */

describe('跟 plugin 對得上', () => {
  it('目錄裡有這顆工具，`sandbox_permissions` 的 enum 有全開那格', () => {
    const section = catalogToolSection(SANDBOX_ESCALATION_TOOL);
    expect(section).toContain('"sandbox_permissions"');
    expect(section).toContain(`"${FULL_ACCESS_MODE}"`);
  });
});

describe('escalationView', () => {
  const reason = '把 "/x/a.txt" 的檔案政策升到 workspace-write，只蓋這一次：要寫設定檔';
  const action = (name: string, args: unknown, description?: string) => ({
    name,
    args,
    ...(description === undefined ? {} : { description }),
  });

  it('帶描述的升級：描述原樣；模式讀參數', () => {
    expect(
      escalationView(
        action(SANDBOX_ESCALATION_TOOL, { sandbox_permissions: 'workspace-write' }, reason),
      ),
    ).toEqual({ reason, fullAccess: false });
    expect(
      escalationView(
        action(SANDBOX_ESCALATION_TOOL, { sandbox_permissions: FULL_ACCESS_MODE }, reason),
      ),
    ).toEqual({ reason, fullAccess: true });
  });

  it('描述裡寫全開但參數不是：照參數（不從字串切）', () => {
    expect(
      escalationView(
        action(
          SANDBOX_ESCALATION_TOOL,
          { sandbox_permissions: 'workspace-write' },
          `升到 ${FULL_ACCESS_MODE}`,
        ),
      )?.fullAccess,
    ).toBe(false);
  });

  it('參數解不開（原字串）：照樣畫描述，不加全開那句', () => {
    expect(
      escalationView(action(SANDBOX_ESCALATION_TOOL, '{"sandbox_permissions": ', reason)),
    ).toEqual({
      reason,
      fullAccess: false,
    });
  });

  it('沒有描述、或不是升級：沒有值（照一般核准卡）', () => {
    expect(
      escalationView(action(SANDBOX_ESCALATION_TOOL, { sandbox_permissions: FULL_ACCESS_MODE })),
    ).toBeUndefined();
    expect(
      escalationView(action('write_file', { file_path: '/a' }, '基座 HITL 的描述')),
    ).toBeUndefined();
  });
});
