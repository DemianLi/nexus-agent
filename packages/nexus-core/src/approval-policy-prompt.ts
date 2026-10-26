/**
 * 把這張圖**目前的核准政策**講成一句話，每次模型呼叫接到系統訊息尾端（[#1986](https://github.com/DemianLi/nexus-agent/issues/1986)）。
 *
 * 句子由閘門用的同一組事實推出：這張圖的 {@link ApprovalChannel} 加上這一刻的核准政策（{@link approvalPolicySentence}）。
 * 只看政策旋鈕不夠：CLI 與背景子代理的管道是 `policy-never`，旋鈕照樣是 `ask`，閘門卻一律回絕。
 *
 * **每次呼叫現算**：`/permission` 在兩輪之間切了政策，下一次模型呼叫看到的就是新的那一句。
 *
 * @module
 */

import type { AgentMiddleware } from 'langchain';
import { createMiddleware } from 'langchain';

import type { ApprovalChannel } from './approval.js';
import type { ApprovalPolicyValue } from './approval-policy.js';

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
 * 每次模型呼叫把 {@link approvalPolicySentence} 接到系統訊息後面的 middleware。
 *
 * **用 `concat` 不用取代**，同沙箱政策句：`systemMessage` 在就接在它後面，不在就由 `systemPrompt` 承接；基座兩個都讀。
 *
 * @param channel - 這張圖的核准管道，組裝時就定了。
 * @param policy - 每次模型呼叫問一次。
 * @returns 可以放進 middleware 陣列的實例。
 */
export function createApprovalPolicyPromptMiddleware(
  channel: ApprovalChannel,
  policy: () => ApprovalPolicyValue,
): AgentMiddleware {
  return createMiddleware({
    name: APPROVAL_POLICY_PROMPT_MIDDLEWARE_NAME,
    wrapModelCall: (request, handler) => {
      const sentence = approvalPolicySentence(channel, policy());
      const { systemMessage } = request;
      return handler(
        systemMessage === undefined
          ? { ...request, systemPrompt: sentence }
          : { ...request, systemMessage: systemMessage.concat(`\n${sentence}`) },
      );
    },
  }) as unknown as AgentMiddleware;
}
