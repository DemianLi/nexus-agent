/**
 * 子代理的委派聲明：每次模型呼叫時接在子代理的系統訊息後面
 * （[#324](https://github.com/DemianLi/nexus-agent/issues/324)）。
 *
 * ## 照 dsh
 *
 * dsh 每個進程內子代理的執行期上下文裡固定放一段 `SUBAGENT_DELEGATION_CONTEXT`
 * （`references/deepseek-harness/packages/subagent/subagent/src/child-agent.ts:166-209`，SHA `c291e79`）：
 * 權限範圍在啟動時就固定、需要核准的操作會自動被拒、被拒了不要重試而是在回覆裡交代。它**刻意不放進
 * 系統提示詞**，讓父子的系統提示詞保持一致。字照翻成中文，見 {@link SUBAGENT_DELEGATION_CONTEXT}。
 *
 * 這句話對**背景**子代理字面為真，靠的是編圖時換上的那顆核准閘門（管道固定 `policy-never`，見
 * {@link ./fold.ts} 的 `createBackgroundApprovalGate`）、換上的這顆預設聲明與問答工具的 `rootOnly`。
 * **前景**子代理的核准交給使用者（#328 第 1 項），但沒有人會被問到時這句同樣為真（[#2056](https://github.com/DemianLi/nexus-agent/issues/2056)）。fold 每次呼叫用 {@link foregroundDelegationContext} 選句，有人會被問到時放的是 {@link FOREGROUND_SUBAGENT_DELEGATION_CONTEXT}。
 *
 * ## 載體
 *
 * 我們沒有「執行期上下文」這個槽。最接近的是 `wrapModelCall`：每次呼叫都接上、不改 spec 的
 * `systemPrompt`，同 root 的沙箱政策句（`packages/nexus-plugin-sandbox-policy/src/index.ts`）。**由 fold 自己建、
 * 只放進子代理的清單**，不走 plugin：plugin 的 middleware 會攤到 root 與每個子代理上
 * （[#327](https://github.com/DemianLi/nexus-agent/issues/327)），而這一句 root 不能有；fold 補的 general-purpose
 * 也要有。
 *
 * **接上，不是取代**：這一句是系統提示詞的一段（{@link subagentDelegationSection}），由這一格的轉接接在 `systemMessage` 後面
 * （`prompt-sections.ts`，#2414）。
 *
 * @module
 */

import type { ApprovalChannel } from './approval.js';
import type { ApprovalPolicyValue } from './approval-policy.js';
import type { AgentMiddleware } from './base-types.js';
import { createSectionSlotMiddleware, MIDDLE_SECTION_ORDERS } from './prompt-sections.js';
import type { MiddleSection } from './prompt-sections.js';

/** middleware 的名字。名字不撞基座任何一個，所以它是 novel entry。 */
export const SUBAGENT_DELEGATION_MIDDLEWARE_NAME = 'nexusSubagentDelegation';

/**
 * 沒有人會被問到的子代理（背景，以及前景自動回絕時）每次模型呼叫看到的那一段。dsh `SUBAGENT_DELEGATION_CONTEXT` 的中文。
 */
export const SUBAGENT_DELEGATION_CONTEXT =
  '你是被委派的子代理：你的權限範圍在啟動時就固定了，無法在這個 session 裡擴大——' +
  '需要核准的操作會自動被拒絕。任務需要超出這個範圍時，不要重試被拒絕的操作；' +
  '在回覆裡說明這個限制，讓委派你的 agent 處理。';

/**
 * 有人會被問到的前景子代理看到的那一段（[#328](https://github.com/DemianLi/nexus-agent/issues/328) 第 1 項）：主對話停著等，需要核准的操作交給使用者決定。
 * 沒有人會被問到時放的是 {@link SUBAGENT_DELEGATION_CONTEXT}，見 {@link foregroundDelegationContext}。「被拒了不要重試」留著——使用者拒絕與自動拒絕對子代理是同一件事。
 * 問答工具與沙箱升級在子代理裡仍然確定性回絕（各自的句子會講），這一句只管核准閘門。
 */
export const FOREGROUND_SUBAGENT_DELEGATION_CONTEXT =
  '你是被委派的子代理：你的權限範圍在啟動時就固定了，無法在這個 session 裡擴大——' +
  '需要核准的操作會交給使用者決定，在使用者回答之前你會等著。操作被拒絕時，不要重試被拒絕的操作；' +
  '任務需要超出這個範圍時，在回覆裡說明這個限制，讓委派你的 agent 處理。';

/**
 * 前景子代理這一刻該看的那一段，跟閘門同一組事實：管道不是 `human`、或政策是 `never`，都沒有人會被問到。
 *
 * @param channel - 這張圖的核准管道。
 * @param policy - 這一刻的核准政策。
 * @returns 會自動回絕時是 {@link SUBAGENT_DELEGATION_CONTEXT}，其餘是 {@link FOREGROUND_SUBAGENT_DELEGATION_CONTEXT}。
 */
export function foregroundDelegationContext(
  channel: ApprovalChannel,
  policy: ApprovalPolicyValue,
): string {
  return channel.kind === 'human' && policy !== 'never'
    ? FOREGROUND_SUBAGENT_DELEGATION_CONTEXT
    : SUBAGENT_DELEGATION_CONTEXT;
}

/**
 * 委派聲明這一段。
 *
 * @param context - 每次模型呼叫取一次那一句。
 */
export function subagentDelegationSection(context: () => string): MiddleSection {
  return {
    name: 'nexus:subagent-delegation',
    order: MIDDLE_SECTION_ORDERS.SUBAGENT_DELEGATION,
    separator: '\n',
    text: () => context(),
  };
}

/**
 * 建一顆把委派聲明接進系統訊息的 middleware。
 *
 * 無狀態，一份實例走遍每個子代理。
 *
 * @param context - 回傳要接的那一段，每次模型呼叫取一次。預設回傳 {@link SUBAGENT_DELEGATION_CONTEXT}（背景子代理：背後沒有人）；
 * fold 替前景子代理傳以 {@link foregroundDelegationContext} 現算的函式。
 * @returns 只放進子代理清單的那一顆。
 */
export function createSubagentDelegationMiddleware(
  context: () => string = () => SUBAGENT_DELEGATION_CONTEXT,
): AgentMiddleware {
  return createSectionSlotMiddleware(SUBAGENT_DELEGATION_MIDDLEWARE_NAME, [
    subagentDelegationSection(context),
  ]);
}
