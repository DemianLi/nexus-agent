/**
 * **`exit_plan_mode` 只有人關掉審核才收這一輪；其餘結局照常回頭叫模型**（[#1607](https://github.com/DemianLi/nexus-agent/issues/1607) PM 審查 B1／B2）。
 *
 * dsh 只在 `ASK_CANCELLED` 時 `exec.concludeTurn()`（`plan-mode/src/index.ts:331-341`），拋錯與拒絕一律不收。這裡用產品組裝
 * （出貨清單、計劃模式開著）把每一種「不是關掉審核」的結局各跑一次，斷言**模型被叫了第二次**——它有機會改正：
 *
 * - 參數缺 `plan`（工具外層的校驗，圍堵接住的拋錯）；
 * - 核准閘門 deny；
 * - 計劃沒有 `#` 標題、不在計劃模式、沒有人可以回答（本體自己的拒絕）。
 *
 * 另外釘兩件東西：
 *
 * - **錯誤碼不丟**（B2）：混批＋全攔核准閘門（headless），日誌上 `exit_plan_mode` 的 `tool/result` 仍帶 `APPROVAL_POLICY_NEVER`。
 * - **熱路徑位元組**：上面三種本體拒絕，第二次請求裡送給供應商的 tool 訊息，位元組跟改動前相同
 *   （帶 `name: exit_plan_mode`——core 為了讓路由不收而拿掉的 `name`，由 plan-mode 的 `wrapModelCall` 在送出前補回）。
 *
 * 零憑證、零外部連線：模型是 `ScriptedChatModel`。
 */

import type { BaseMessage } from '@langchain/core/messages';
import { convertMessagesToCompletionsMessageParams } from '@langchain/openai';
import type { NexusPlugin, PluginEntry, SessionEvent } from '@nexus/core';
import {
  EXIT_PLAN_MODE_TOOL_NAME,
  NOT_IN_PLAN_MODE_MESSAGE,
  PLAN_HEADING_REQUIRED_MESSAGE,
  PLAN_NO_REVIEWER_MESSAGE,
} from '@nexus/plugin-plan-mode';
import { describe, expect, it } from 'vitest';

import { HEADLESS_APPROVALS } from './agent-factory.js';
import { createCliAgent } from './assembly-root.js';
import { shippedPlugins, withoutTimeContext, withScriptedModel } from './fixtures.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';

const shipped = withoutTimeContext(await shippedPlugins());
const GUIDANCE = (shipped.find((entry) => entry.id === 'plan-mode')?.config as { guidance: string })
  .guidance;

const PLAN = '# 計劃\n\n先看再改。';

/** 什麼都不放行、也不問人：核准閘門直接 deny `exit_plan_mode`。 */
const denyExit: PluginEntry = {
  id: 'probe-deny',
  plugin: {
    name: 'probe-deny',
    apply(registry) {
      registry.approvals.gate((exec, next) =>
        exec.name === EXIT_PLAN_MODE_TOOL_NAME ? { kind: 'deny', reason: '不准' } : next(),
      );
    },
  } satisfies NexusPlugin,
} as unknown as PluginEntry;

/** 每個工具都要人看過；headless 底下沒有人，拿到 `APPROVAL_POLICY_NEVER`。 */
const askEverything: PluginEntry = {
  id: 'probe-ask',
  plugin: {
    name: 'probe-ask',
    apply(registry) {
      registry.approvals.gate(() => ({ kind: 'ask', reason: '探針：每個工具都要人看過' }));
    },
  } satisfies NexusPlugin,
} as unknown as PluginEntry;

interface Ran {
  readonly model: ScriptedChatModel;
  readonly messages: BaseMessage[];
  readonly events: readonly SessionEvent[];
}

async function run(
  turns: readonly ScriptedTurn[],
  options: { before?: PluginEntry[]; startActive?: boolean; headless?: boolean } = {},
): Promise<Ran> {
  const plugins = [
    ...(options.before ?? []),
    ...shipped.map((entry) =>
      entry.id === 'plan-mode'
        ? { ...entry, config: { guidance: GUIDANCE, startActive: options.startActive ?? true } }
        : entry,
    ),
  ];
  const built = await createCliAgent(
    { live: false },
    withScriptedModel(plugins, turns),
    undefined,
    options.headless === true ? { approvals: HEADLESS_APPROVALS } : {},
  );
  const detach = built.attachSession(built.sessions);
  try {
    const out = (await built.agent.invoke(toAgentInvocation('規劃一下'), {
      configurable: { thread_id: `conclusion-${Math.random()}` },
    })) as { messages: BaseMessage[] };
    return {
      model: built.model as ScriptedChatModel,
      messages: out.messages,
      events: [...built.sessions.root.events],
    };
  } finally {
    detach();
    await built.dispose();
  }
}

const exitCall = (args: Record<string, unknown>): ScriptedTurn => ({
  content: '交計劃。',
  toolCalls: [{ name: EXIT_PLAN_MODE_TOOL_NAME, args }],
});
const AGAIN: ScriptedTurn = { content: '再試。' };

/** 第二次請求送給供應商的 tool 訊息（Chat Completions 形狀）。 */
function providerToolMessage(model: ScriptedChatModel): unknown {
  const sent = convertMessagesToCompletionsMessageParams({
    messages: [...model.prompts[1]!],
    model: 'x',
  }) as { role: string }[];
  return sent.find((message) => message.role === 'tool');
}

describe('exit_plan_mode：不是關掉審核的結局，模型有機會改正（叫第二次）', () => {
  it('參數缺 plan（校驗外層、圍堵接住的拋錯）', async () => {
    const { model, messages } = await run([exitCall({}), AGAIN]);

    expect(model.prompts).toHaveLength(2);
    const tool = [...messages].reverse().find((message) => message.getType() === 'tool');
    expect(tool?.text).toContain('exit_plan_mode');
  });

  it('核准閘門 deny', async () => {
    const { model, messages } = await run([exitCall({ plan: PLAN }), AGAIN], {
      before: [denyExit],
    });

    expect(model.prompts).toHaveLength(2);
    const tool = [...messages].reverse().find((message) => message.getType() === 'tool');
    expect(tool?.text).toBe('Error: 不准');
  });

  it('混批＋全攔核准閘門（headless）：照常繼續，日誌上的 tool/result 仍帶 APPROVAL_POLICY_NEVER', async () => {
    const { model, events } = await run(
      [
        {
          content: '並行',
          toolCalls: [
            { name: EXIT_PLAN_MODE_TOOL_NAME, args: { plan: PLAN } },
            { name: 'write_todos', args: { todos: [] } },
          ],
        },
        AGAIN,
      ],
      { before: [askEverything], headless: true },
    );

    expect(model.prompts).toHaveLength(2);
    const callIds = new Set(
      events.flatMap((event) =>
        event.type === 'tool/call' && event.data.name === EXIT_PLAN_MODE_TOOL_NAME
          ? [event.data.callId]
          : [],
      ),
    );
    const verdicts = events.flatMap((event) =>
      event.type === 'tool/result' && callIds.has(event.data.callId)
        ? [{ isError: event.data.isError, error: (event.data as { error?: unknown }).error }]
        : [],
    );
    expect(verdicts).toEqual([
      { isError: true, error: expect.objectContaining({ code: 'APPROVAL_POLICY_NEVER' }) },
    ]);
  });
});

describe('exit_plan_mode：本體自己的拒絕，第二次請求送給供應商的位元組跟改動前相同', () => {
  it.each([
    ['計劃沒有 # 標題', { plan: '沒有標題的計劃' }, {}, PLAN_HEADING_REQUIRED_MESSAGE],
    ['不在計劃模式', { plan: PLAN }, { startActive: false }, NOT_IN_PLAN_MODE_MESSAGE],
    ['沒有人可以回答（headless）', { plan: PLAN }, { headless: true }, PLAN_NO_REVIEWER_MESSAGE],
  ] as const)('%s', async (_label, args, options, message) => {
    const { model } = await run([exitCall(args), AGAIN], options);

    expect(model.prompts).toHaveLength(2);
    expect(providerToolMessage(model)).toEqual({
      role: 'tool',
      content: `Error: ${message}`,
      name: EXIT_PLAN_MODE_TOOL_NAME,
      tool_call_id: expect.any(String),
    });
  });
});
