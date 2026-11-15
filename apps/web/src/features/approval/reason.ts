import type { PendingApproval } from '@nexus/wire';

/**
 * 核准面板上那句「為什麼要問」（[#1628](https://github.com/DemianLi/nexus-agent/issues/1628)）：閘門回 `ask` 時給的理由，例如 MCP 閘門的
 * 「MCP server crm 的工具 orders.search 要先讓人看過（設定 approval）」（#1622）。人在面板上看到的工具名可能被補了指紋，看不出是哪台
 * server、哪支工具，這一句補上。
 *
 * **只畫閘門給的理由**：core 的閘門在沒有理由時自己填一句預設字，再一律放進酬載的 `description`（`@nexus/core` 的 `approval.ts`），
 * 那句跟面板上「要執行 …」那一行重複，所以**等於預設字視同沒有**。預設字照 core 抄（web 的產品碼不從 core 取值），`approval-reason.test.ts`
 * 讀那邊的原始碼對。
 */

/** core 閘門沒有理由時填的那一句（`approval.ts` 的 `` `"${exec.name}" 需要人工核准` ``）。 */
export function defaultApprovalReason(name: string): string {
  return `"${name}" 需要人工核准`;
}

/** 這一筆要畫的理由；沒有、空白、或只是預設字時是 `undefined`。 */
export function approvalReasonOf(action: PendingApproval['actions'][number]): string | undefined {
  const reason = action.description?.trim();
  if (reason === undefined || reason === '' || reason === defaultApprovalReason(action.name)) {
    return undefined;
  }
  return reason;
}
