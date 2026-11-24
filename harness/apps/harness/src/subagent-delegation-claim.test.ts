/**
 * 前景子代理的委派聲明跟閘門的實際行為一致（[#2056](https://github.com/DemianLi/nexus-agent/issues/2056)）。
 *
 * 真的 `createCliAgent`／`createNexusAgent` 組裝，子代理叫一顆要核准的工具。**零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import {
  ApprovalPolicyController,
  FOREGROUND_SUBAGENT_DELEGATION_CONTEXT,
  SUBAGENT_DELEGATION_CONTEXT,
} from '@nexus/core';
import type { PluginEntry } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createNexusAgent, HEADLESS_APPROVALS } from './agent-factory.js';
import { createCliAgent } from './assembly-root.js';
import { shippedPlugins, withScriptedModel } from './fixtures.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';

const shipped = await shippedPlugins();

const DANGER: PluginEntry = {
  plugin: {
    name: 'danger',
    apply(registry) {
      registry.tools.register(
        tool(() => '做完了', { name: 'danger', description: '要核准。', schema: z.object({}) }),
      );
      registry.approvals.gate((exec, next) =>
        exec.name === 'danger' ? { kind: 'ask', reason: '危險' } : next(),
      );
      registry.subagents.register({ name: 'worker', description: '幹活的。' });
    },
  },
};

const TURNS: readonly ScriptedTurn[] = [
  {
    content: '委派。',
    toolCalls: [
      {
        name: 'task',
        args: { description: '幹活', subagent_type: 'worker', run_in_background: false },
      },
    ],
  },
  { content: '動手。', toolCalls: [{ name: 'danger', args: {} }] },
  { content: '子代理收工。' },
  { content: '收尾。' },
];

const systemOf = (prompt: readonly BaseMessage[] | undefined): string =>
  (prompt ?? [])
    .filter((message) => message.getType() === 'system')
    .map((message) => message.text)
    .join('\n');

/** 模型實際收到的每一輪，腳本裡第二輪是子代理的第一次請求。 */
let prompts: (readonly BaseMessage[])[];
let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join('/var/tmp', 'nexus-delegation-claim-'));
  prompts = [];
  const generate = ScriptedChatModel.prototype._generate;
  vi.spyOn(ScriptedChatModel.prototype, '_generate').mockImplementation(function (
    this: ScriptedChatModel,
    messages: BaseMessage[],
  ) {
    prompts.push(messages);
    return generate.call(this, messages);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(workspace, { recursive: true, force: true });
});

/** 跑一輪：回有沒有掛核准卡。 */
async function run(
  invocation: { approvalPolicy?: 'ask' | 'never' },
  approvals?: typeof HEADLESS_APPROVALS,
): Promise<boolean> {
  const built = await createCliAgent(
    { live: false, workspace, workspaceRoot: workspace, sandbox: 'workspace-write', ...invocation },
    withScriptedModel([...shipped, DANGER], TURNS),
    workspace,
    ...(approvals === undefined ? [] : [{ approvals }]),
  );
  const detach = built.attachSession(built.sessions);
  try {
    const result = await built.agent.invoke(toAgentInvocation('幹活。'), {
      configurable: { thread_id: 'delegation-claim' },
    });
    return ((result as { __interrupt__?: unknown[] }).__interrupt__?.length ?? 0) > 0;
  } finally {
    detach();
    await built.dispose();
  }
}

describe('前景子代理的委派聲明跟閘門一致（#2056）', () => {
  it.each([
    ['serve 路徑、政策 never', { approvalPolicy: 'never' as const }, undefined, '核准政策是不問'],
    ['CLI', {}, HEADLESS_APPROVALS, '關掉了人工核准'],
  ])(
    '%s：政策拒，聲明講自動拒絕',
    async (_name, invocation, approvals, denial) => {
      expect(await run(invocation, approvals)).toBe(false);
      const system = systemOf(prompts[1]);
      expect(system).toContain(SUBAGENT_DELEGATION_CONTEXT);
      expect(system).not.toContain(FOREGROUND_SUBAGENT_DELEGATION_CONTEXT);
      const results = (prompts[2] ?? []).filter((message) => message.getType() === 'tool');
      expect(results.at(-1)?.text).toContain(denial);
    },
    60000,
  );

  it('反例：serve 路徑、政策 ask：掛核准卡，聲明講等使用者', async () => {
    expect(await run({})).toBe(true);
    const system = systemOf(prompts[1]);
    expect(system).toContain(FOREGROUND_SUBAGENT_DELEGATION_CONTEXT);
    expect(system).not.toContain(SUBAGENT_DELEGATION_CONTEXT);
  }, 60000);

  it('同一輪裡切到 never：下一次模型呼叫就換句，閘門也跟著拒', async () => {
    const controller = new ApprovalPolicyController('ask');
    const FLIP: PluginEntry = {
      plugin: {
        name: 'flip',
        apply(registry) {
          registry.tools.register(
            tool(
              () => {
                controller.switchTo('never');
                return '切好了';
              },
              { name: 'flip', description: '切政策。', schema: z.object({}) },
            ),
          );
        },
      },
    };
    const [delegate, , ...rest] = TURNS;
    const turns: ScriptedTurn[] = [
      delegate as ScriptedTurn,
      { content: '切。', toolCalls: [{ name: 'flip', args: {} }] },
      { content: '動手。', toolCalls: [{ name: 'danger', args: {} }] },
      ...rest,
    ];
    const built = await createNexusAgent({
      model: new ScriptedChatModel({ turns }),
      checkpointer: new MemorySaver(),
      plugins: [DANGER, FLIP],
      approvals: { policy: controller.source },
    });
    try {
      const result = await built.agent.invoke(toAgentInvocation('幹活。'), {
        configurable: { thread_id: 'delegation-claim-switch' },
      });
      expect((result as { __interrupt__?: unknown[] }).__interrupt__).toBeUndefined();
    } finally {
      await built.dispose();
    }
    expect(systemOf(prompts[1])).toContain(FOREGROUND_SUBAGENT_DELEGATION_CONTEXT);
    const after = systemOf(prompts[2]);
    expect(after).toContain(SUBAGENT_DELEGATION_CONTEXT);
    expect(after).not.toContain(FOREGROUND_SUBAGENT_DELEGATION_CONTEXT);
    const results = (prompts[3] ?? []).filter((message) => message.getType() === 'tool');
    expect(results.at(-1)?.text).toContain('沒有人被問到');
  }, 60000);

  it('沒有 checkpointer：沒人被問到，聲明講自動拒絕', async () => {
    const built = await createNexusAgent({
      model: new ScriptedChatModel({ turns: [...TURNS] }),
      plugins: [DANGER],
    });
    try {
      await built.agent.invoke(toAgentInvocation('幹活。'));
    } finally {
      await built.dispose();
    }
    const system = systemOf(prompts[1]);
    expect(system).toContain(SUBAGENT_DELEGATION_CONTEXT);
    expect(system).not.toContain(FOREGROUND_SUBAGENT_DELEGATION_CONTEXT);
  }, 60000);
});
