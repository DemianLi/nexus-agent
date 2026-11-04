/**
 * 把這張圖**目前的核准政策**講成一句話，每次模型呼叫接到系統訊息尾端（[#1986](https://github.com/DemianLi/nexus-agent/issues/1986)）。
 *
 * 句子由閘門用的同一組事實推出：這張圖的 {@link ApprovalChannel} 加上這一刻的核准政策（{@link approvalPolicySentence}）。
 * 只看政策旋鈕不夠：CLI 與背景子代理的管道是 `policy-never`，旋鈕照樣是 `ask`，閘門卻一律回絕。
 *
 * **每次呼叫現算**：`/permission` 在兩輪之間切了政策，下一次模型呼叫看到的就是新的那一句。
 *
 * 句子是系統提示詞的一段（{@link approvalPolicySection}），由 {@link createApprovalPolicyPromptMiddleware} 那一格的轉接接上（`prompt-sections.ts`，#2414）。
 *
 * @module
 */

import type { AgentMiddleware } from './base-types.js';
import type { ApprovalChannel } from './approval.js';
import type { ApprovalPolicyValue } from './approval-policy.js';
import { createSectionSlotMiddleware, MIDDLE_SECTION_ORDERS } from './prompt-sections.js';
import type { MiddleSection } from './prompt-sections.js';

/** middleware 的名字。 */
export const APPROVAL_POLICY_PROMPT_MIDDLEWARE_NAME = 'nexusApprovalPolicyPrompt';

/** 這張圖確定性回絕每一次核准時講的那句。 */
export const APPROVAL_POLICY_NEVER_SENTENCE =
  '這個 session 關掉了核准提示：需要核准的動作一律自動回絕——不要請求沙箱升級（不要設 `sandbox_permissions`）。';

/** 需要核准的動作會去問、但仍可能拒絕收場時講的那句。 */
export const APPROVAL_POLICY_ASK_SENTENCE =
  '這個 session 開著核准提示：需要核准的操作可以經由設定好的核准管道發問；沒有可用的管道時，請求以拒絕收場。';

/**
 * 這張圖這一刻的核准政策句。
 *
 * 結論跟閘門一致：管道是 `policy-never` 時不看政策，講回絕那句；`human` 看政策。`no-channel` 的閘門不看政策、一律以沒有管道
 * 回絕，句子則照政策講：ASK 句後半「沒有可用的管道時，請求以拒絕收場」說的就是它。
 *
 * @param channel - 這張圖的核准管道。
 * @param policy - 這一刻的核准政策。
 * @returns {@link APPROVAL_POLICY_NEVER_SENTENCE} 或 {@link APPROVAL_POLICY_ASK_SENTENCE}。
 */
export function approvalPolicySentence(
  channel: ApprovalChannel,
  policy: ApprovalPolicyValue,
): string {
  if (channel.kind === 'policy-never' || policy === 'never') return APPROVAL_POLICY_NEVER_SENTENCE;
  return APPROVAL_POLICY_ASK_SENTENCE;
}

/**
 * 核准政策句這一段：每次模型呼叫照 {@link approvalPolicySentence} 現算。
 *
 * @param channel - 這張圖的核准管道，組裝時就定了。
 * @param policy - 每次模型呼叫問一次。
 */
export function approvalPolicySection(
  channel: ApprovalChannel,
  policy: () => ApprovalPolicyValue,
): MiddleSection {
  return {
    name: 'nexus:approval-policy',
    order: MIDDLE_SECTION_ORDERS.APPROVAL_POLICY,
    separator: '\n',
    text: () => approvalPolicySentence(channel, policy()),
  };
}

/**
 * 接 {@link approvalPolicySection} 的那一格。
 *
 * @param channel - 這張圖的核准管道，組裝時就定了。
 * @param policy - 每次模型呼叫問一次。
 * @returns 可以放進 middleware 陣列的實例。
 */
export function createApprovalPolicyPromptMiddleware(
  channel: ApprovalChannel,
  policy: () => ApprovalPolicyValue,
): AgentMiddleware {
  return createSectionSlotMiddleware(APPROVAL_POLICY_PROMPT_MIDDLEWARE_NAME, [
    approvalPolicySection(channel, policy),
  ]);
}
