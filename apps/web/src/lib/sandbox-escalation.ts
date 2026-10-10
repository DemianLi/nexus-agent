import type { PendingApproval } from '@nexus/wire';

/**
 * 沙箱升級的核准（[#1292](https://github.com/DemianLi/nexus-agent/issues/1292)，#949 Q5）：卡上畫 harness 送的那句描述——
 * 模式、理由、「只蓋這一次」都在裡面（`@nexus/plugin-sandbox-policy` 的 `escalationReason`，對應 dsh `escalation.ts` 的
 * `displayReason`）。**web 不拼這句話**：沒有描述（較舊的 server）就退回一般核准卡。
 *
 * 工具名與模式字面照 plugin 抄（web 不依賴那個套件），`sandbox-escalation.test.ts` 從 `docs/tool-catalog.md` 讀回來對。
 */

/** 模型看到的工具名，同 plugin 的 `SANDBOX_ESCALATION_TOOL_NAME`。 */
export const SANDBOX_ESCALATION_TOOL = 'request_sandbox_escalation';

/** 核准面板的名稱（狀態列唸的也是它，見 `pending-label.ts`）：不露工具名。 */
export const ESCALATION_TITLE = '要求放寬檔案權限';

/** 升到這一格時多講一句：plugin 的 `ESCALATION_TARGETS` 裡最寬的那格。 */
export const FULL_ACCESS_MODE = 'danger-full-access';

/** 措辭對齊權限座「全開」的確認（`permission-seat.tsx` 的 `DANGER_CONFIRM_TEXT`），只講這一次。 */
export const FULL_ACCESS_NOTE = '這一次的檔案寫入不受工作區限制。';

export interface EscalationView {
  /** harness 送的那句描述，原樣。 */
  readonly reason: string;
  /** 要升到 {@link FULL_ACCESS_MODE}。讀結構化的參數 `sandbox_permissions`，不從描述裡切字。 */
  readonly fullAccess: boolean;
}

/** 這一筆是帶描述的沙箱升級才有值；其他工具與沒有描述的照一般核准卡畫。 */
export function escalationView(
  action: PendingApproval['actions'][number],
): EscalationView | undefined {
  if (action.name !== SANDBOX_ESCALATION_TOOL || action.description === undefined) return undefined;
  const mode =
    typeof action.args === 'object' && action.args !== null
      ? (action.args as Record<string, unknown>)['sandbox_permissions']
      : undefined;
  return { reason: action.description, fullAccess: mode === FULL_ACCESS_MODE };
}
