/**
 * 核准稽核落在開著的輪內（[#2026](https://github.com/DemianLi/nexus-agent/issues/2026)），用產品路徑量真的日誌形狀：
 * 真的 `createNexusAgent`＋真的 `ThreadPump`，掛上 `@nexus/core` 的不變量配套入口（每一份會話各一個 runner）。
 *
 * 政策是 `never` 時，前景子代理叫的要核准的工具由政策路徑回絕，稽核寫進**子代理自己那份日誌**，而那份日誌沒有 `turn/*`。
 * 這條釘的是：這個正常形狀不報違規。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import {
  ApprovalPolicyController,
  approvalGatePlugin,
  createHostServicesPlugin,
} from '@nexus/core';
import type { InvariantError, PluginEntry } from '@nexus/core';
import { createCoreInvariantPlugin } from '@nexus/core/invariant';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { ScriptedChatModel } from './scripted-model.js';
import { composeAttachSessions } from './session-attach.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

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

it('政策 never、前景子代理碰到要核准的工具：子代理日誌有一對稽核、沒有輪，不報違規', async () => {
  const controller = new ApprovalPolicyController('never');
  const violations: InvariantError[] = [];
  const built = await createNexusAgent({
    model: new ScriptedChatModel({
      turns: [
        {
          content: '委派。',
          toolCalls: [{ name: 'task', args: { description: '幹活', subagent_type: 'worker' } }],
        },
        { content: '動手。', toolCalls: [{ name: 'danger', args: {} }] },
        { content: '子代理收工。' },
        { content: '收尾。' },
      ],
    }),
    checkpointer: new MemorySaver(),
    plugins: [
      createHostServicesPlugin({ approvalPolicy: controller }),
      { plugin: approvalGatePlugin },
      DANGER,
      createCoreInvariantPlugin(),
    ],
    approvals: { policy: controller.source },
    onInvariantViolation: (error) => violations.push(error),
  });
  const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'approval-audit-turns');
  // 產品接線那一口：遙測、不變量、參與者一起接（`built.attachSession` 只接參與者，不變量不會掛上）。
  const attachment = composeAttachSessions(built)(pump.sessions);
  try {
    await pump.submit({ kind: 'message', text: '開始' });
    await pump.whenIdle();

    const subagent = pump.sessions.list().find((each) => each.address.kind === 'subagent');
    const types = subagent!.log.events.map((event) => event.type);
    expect(types).toEqual(expect.arrayContaining(['approval/asked', 'approval/decided']));
    expect(types.some((type) => type.startsWith('turn/'))).toBe(false);
    expect(violations).toEqual([]);
  } finally {
    await attachment.detach();
    await built.dispose();
  }
});
