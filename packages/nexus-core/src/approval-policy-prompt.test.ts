import { SystemMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';

import type { ApprovalChannel } from './approval.js';
import type { ApprovalPolicyValue } from './approval-policy.js';
import {
  APPROVAL_POLICY_ASK_SENTENCE,
  APPROVAL_POLICY_NEVER_SENTENCE,
  approvalPolicySentence,
  createApprovalPolicyPromptMiddleware,
} from './approval-policy-prompt.js';

const HUMAN: ApprovalChannel = { kind: 'human' };
const POLICY_NEVER: ApprovalChannel = { kind: 'policy-never' };
const NO_CHANNEL: ApprovalChannel = { kind: 'no-channel' };

describe('approvalPolicySentence：句子跟閘門用同一組事實推', () => {
  it.each([
    ['human、ask：會去問', HUMAN, 'ask', APPROVAL_POLICY_ASK_SENTENCE],
    ['human、never：政策關掉了', HUMAN, 'never', APPROVAL_POLICY_NEVER_SENTENCE],
    [
      'policy-never、ask：管道一律回絕，不看政策（CLI、背景子代理）',
      POLICY_NEVER,
      'ask',
      APPROVAL_POLICY_NEVER_SENTENCE,
    ],
    ['policy-never、never', POLICY_NEVER, 'never', APPROVAL_POLICY_NEVER_SENTENCE],
    [
      'no-channel、ask：照政策講，沒有可用管道由 ASK 句後半說',
      NO_CHANNEL,
      'ask',
      APPROVAL_POLICY_ASK_SENTENCE,
    ],
    ['no-channel、never', NO_CHANNEL, 'never', APPROVAL_POLICY_NEVER_SENTENCE],
  ] as const)('%s', (_label, channel, policy, sentence) => {
    expect(approvalPolicySentence(channel, policy)).toBe(sentence);
  });
});

type Request = { systemMessage?: SystemMessage; systemPrompt?: string };

async function seen(channel: ApprovalChannel, policy: () => ApprovalPolicyValue, request: Request) {
  const middleware = createApprovalPolicyPromptMiddleware(channel, policy) as unknown as {
    wrapModelCall(
      request: Request,
      handler: (request: Request) => Promise<Request>,
    ): Promise<Request>;
  };
  return middleware.wrapModelCall(request, (passed) => Promise.resolve(passed));
}

describe('createApprovalPolicyPromptMiddleware', () => {
  it('接在系統訊息後面，不取代原本的內容', async () => {
    const passed = await seen(HUMAN, () => 'ask', { systemMessage: new SystemMessage('身分句。') });
    expect(passed.systemMessage?.text).toBe(`身分句。\n${APPROVAL_POLICY_ASK_SENTENCE}`);
  });

  it('沒有系統訊息時由 systemPrompt 承接', async () => {
    const passed = await seen(HUMAN, () => 'never', {});
    expect(passed.systemPrompt).toBe(APPROVAL_POLICY_NEVER_SENTENCE);
  });

  it('每次呼叫現讀政策：切換之後下一次呼叫就是新的那一句', async () => {
    let policy: ApprovalPolicyValue = 'ask';
    const first = await seen(HUMAN, () => policy, { systemMessage: new SystemMessage('') });
    policy = 'never';
    const second = await seen(HUMAN, () => policy, { systemMessage: new SystemMessage('') });
    expect(first.systemMessage?.text).toContain(APPROVAL_POLICY_ASK_SENTENCE);
    expect(second.systemMessage?.text).toContain(APPROVAL_POLICY_NEVER_SENTENCE);
  });
});
