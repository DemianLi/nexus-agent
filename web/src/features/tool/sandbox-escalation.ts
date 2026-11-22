import type { PendingApproval } from '@nexus/wire';

/**
 * 沙箱升級的核准（[#1292](https://github.com/DemianLi/nexus-agent/issues/1292)，#949 Q5）：卡上畫 harness 送的那句描述——
 * 模式、理由、「只蓋這一次」都在裡面（`@nexus/plugin-sandbox-policy` 的 `escalationReason`，對應 dsh `escalation.ts` 的
 * `displayReason`）。**web 不拼這句話**：沒有描述（較舊的 server）就退回一般核准卡。
 *
 * 工具名照 plugin 抄（web 不依賴那個套件），`sandbox-escalation.test.ts` 從 `docs/tool-catalog.md` 讀回來對。
 */

/** 模型看到的工具名，同 plugin 的 `SANDBOX_ESCALATION_TOOL_NAME`。 */
export const SANDBOX_ESCALATION_TOOL = 'request_sandbox_escalation';

/** 核准面板的名稱（狀態列唸的也是它，見 `pending-label.ts`）：不露工具名。 */
export const ESCALATION_TITLE = '要求放寬檔案權限';

/** 這一筆是帶描述的沙箱升級才有值（harness 送的那句描述，原樣）；其他工具與沒有描述的照一般核准卡畫。 */
export function escalationReason(action: PendingApproval['actions'][number]): string | undefined {
  return action.name === SANDBOX_ESCALATION_TOOL ? action.description : undefined;
}
