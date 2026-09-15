/**
 * 子代理照委派那一刻的沙箱模式判，而且碰不到 root 的 grant 與 denial——[#326](https://github.com/DemianLi/nexus-agent/issues/326)
 * 的驗收。
 *
 * 產品路徑：真的組裝、真的 deepagents `task`，fence 與 plugin 讀同一顆控制器，同 `cli.ts` 的接法。**前提（驗收 1）
 * 不另寫一條**：下面每一條要綠，快照都得真的穿過 `task` 到得了子代理的 fence 或閘門；拿掉 `sandbox-policy.ts`
 * 那顆 `wrapToolCall` 時，「放寬／收緊」「子代理的升級」三條都會紅。
 *
 * **「委派之後 root 切換」用一顆 `flip` 工具代替**：它在子代理那一輪裡叫 `switchTo`，也就是 `/sandbox` 走的同一個
 * 入口。`switchTo` 改的是 root 那一格、不讀快照，所以效果跟 root 在子代理跑到一半時切換一樣；直接在測試裡插一個
 * `/sandbox` 抓不到「子代理還在跑」那個時間點。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`，它的輪數由 root 與子代理依序吃掉。
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { Command, MemorySaver } from '@langchain/langgraph';
import type { NexusPlugin } from '@nexus/core';
import type { Event } from '@nexus/wire';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import type { SandboxMode } from './contained-backend.js';
import { toAgentInvocation } from './messages.js';
import { nonWideningRefusal, SANDBOX_ESCALATION_TOOL_NAME } from './sandbox-escalation.js';
import { SandboxModeController } from './sandbox-mode.js';
import { createSandboxPolicyPlugin, sandboxPolicySentence } from './sandbox-policy.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedToolCall, ScriptedTurn } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

const WORKER: NexusPlugin = {
  name: 'worker-host',
  apply(registry) {
    registry.subagents.register({
      name: 'worker',
      description: '幹活的。',
      systemPrompt: '你是 worker，只做交代給你的事。',
    });
  },
};

/** `/sandbox` 的替身，理由見檔頭。 */
function flipPlugin(controller: SandboxModeController): NexusPlugin {
  return {
    name: 'flip',
    apply(registry) {
      registry.tools.register(
        tool(
          ({ to }: { to: SandboxMode }) => {
            controller.switchTo(to);
            return `切到 ${to}`;
          },
          {
            name: 'flip',
            description: '切 root 的沙箱模式。',
            schema: z.object({
              to: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
            }),
          },
        ),
      );
    },
  };
}

const call = (name: string, args: ScriptedToolCall['args']): ScriptedTurn => ({
  content: '',
  toolCalls: [{ name, args }],
});
const delegate = call('task', { description: '幹活', subagent_type: 'worker' });
const flip = (to: SandboxMode) => call('flip', { to });
const write = (filePath: string, content: string) =>
  call('write_file', { file_path: filePath, content });
const escalate = (filePath: string, mode: SandboxMode) =>
  call(SANDBOX_ESCALATION_TOOL_NAME, {
    file_path: filePath,
    sandbox_permissions: mode,
    justification: '要寫這個檔',
  });

const APPROVE = new Command({ resume: { decisions: [{ type: 'approve' }] } }) as never;

/** 一份 prompt 是不是子代理的：子代理那幾輪的人話是 `task` 的描述。 */
function isSubagentPrompt(prompt: readonly BaseMessage[]): boolean {
  return prompt.some((message) => message.getType() === 'human' && message.text === '幹活');
}

/** 子代理看到的每一則工具結果，依出現順序（取最後一份子代理 prompt，它帶著整段）。 */
function subagentToolTexts(model: ScriptedChatModel): string[] {
  const prompts = model.prompts.filter(isSubagentPrompt);
  return (prompts.at(-1) ?? [])
    .filter((message) => message.getType() === 'tool')
    .map((message) => message.text);
}

/** root 這條 thread 的每一則工具結果。 */
function rootToolTexts(result: { messages: unknown }): string[] {
  return (result.messages as BaseMessage[])
    .filter((message) => message.getType() === 'tool')
    .map((message) => message.text);
}

const isRootDone = (frame: Event): boolean =>
  frame.method === 'lifecycle' &&
  frame.params.namespace.length === 0 &&
  (frame.params.data as { graph_name?: unknown }).graph_name === 'root' &&
  ['completed', 'failed'].includes(String((frame.params.data as { event?: unknown }).event));

async function until(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

describe('子代理的沙箱模式', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nexus-subagent-sandbox-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** 照 `cli.ts` 的接法組起來。`fence: false` 是沒給 `--workspace` 的組裝：沒有 backend、沒有沙箱 plugin。 */
  async function assemble(
    mode: SandboxMode,
    turns: readonly ScriptedTurn[],
    options: { fence?: boolean } = {},
  ) {
    const controller = new SandboxModeController(mode);
    const model = new ScriptedChatModel({ turns });
    const fence = options.fence !== false;
    const built = await createNexusAgent({
      model,
      checkpointer: new MemorySaver(),
      plugins: [
        WORKER,
        flipPlugin(controller),
        ...(fence ? [createSandboxPolicyPlugin(controller, root)] : []),
      ],
      ...(fence && {
        backend: new ContainedFilesystemBackend({
          rootDir: root,
          mode: controller.source,
          grants: controller,
        }),
      }),
    });
    return { ...built, controller, model };
  }

  /** 真的 pump 跑一輪到收尾——看得到每一份會話日誌，serve 那條路的形狀。 */
  async function runWithLogs(
    mode: SandboxMode,
    turns: readonly ScriptedTurn[],
    options: { fence?: boolean } = {},
  ) {
    const built = await assemble(mode, turns, options);
    const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'subagent-sandbox');
    const detach = built.attachSession(pump.sessions);
    const frames: Event[] = [];
    const line = new AbortController();
    const stream = pump.subscribe(['lifecycle'], line.signal);
    const draining = (async () => {
      for await (const frame of stream) frames.push(frame);
    })();
    await pump.submit({ kind: 'message', text: '委派' });
    await until(() => frames.some(isRootDone));
    await pump.whenIdle();

    const logOf = (kind: 'root' | 'subagent') =>
      pump.sessions.list().filter((session) => session.address.kind === kind);
    const sandboxEvents = (kind: 'root' | 'subagent') =>
      logOf(kind).map((session) =>
        session.log.events
          .filter((event) => event.type === 'sandbox/mode')
          .map((event) => event.data),
      );
    return {
      ...built,
      sandboxEvents,
      close: async () => {
        line.abort();
        await draining;
        detach();
        await built.dispose();
      },
    };
  }

  /**
   * **子代理的模型請求也帶沙箱政策句，講的是委派那一格**（[#327](https://github.com/DemianLi/nexus-agent/issues/327)）。
   * 照 dsh：子代理併入父代理的組合，`sandbox:policy` 段落讀子代理自己 session 上委派時寫下的模式
   * （`packages/sandbox/sandbox-policy/src/index.ts:141-151`）。
   *
   * 子代理第二次請求在 `flip` 之後：root 那一格已經換了，句子仍是委派那一格——驗的是「每次」而且是「委派那格」，
   * 不是組裝當下那格。root 收尾那次拿的是新那一格，對照組。
   */
  it('子代理每次請求都帶政策句，是委派那一格；root 之後切換不影響它', async () => {
    const run = await runWithLogs('read-only', [
      delegate,
      flip('workspace-write'),
      { content: '子代理收工。' },
      { content: '根收工。' },
    ]);
    try {
      const systemOf = (prompt: readonly BaseMessage[]) =>
        prompt.find((message) => message.getType() === 'system')?.text ?? '';
      const subagentPrompts = run.model.prompts.filter(isSubagentPrompt);
      const rootPrompts = run.model.prompts.filter((prompt) => !isSubagentPrompt(prompt));
      expect(subagentPrompts).toHaveLength(2);
      for (const prompt of subagentPrompts) {
        expect(systemOf(prompt)).toContain(sandboxPolicySentence('read-only', root));
      }
      expect(systemOf(rootPrompts.at(-1) ?? [])).toContain(
        sandboxPolicySentence('workspace-write', root),
      );
    } finally {
      await run.close();
    }
  });

  it('沒掛沙箱 plugin 的組裝（沒給 `--workspace`），子代理請求裡沒有政策句', async () => {
    const run = await runWithLogs(
      'read-only',
      [delegate, { content: '子代理收工。' }, { content: '根收工。' }],
      { fence: false },
    );
    try {
      const subagentPrompts = run.model.prompts.filter(isSubagentPrompt);
      expect(subagentPrompts).toHaveLength(1);
      expect(
        subagentPrompts[0]?.find((message) => message.getType() === 'system')?.text ?? '',
      ).not.toContain('目前的檔案政策');
    } finally {
      await run.close();
    }
  });

  it('委派之後 root 放寬：子代理照委派那一格擋，root 自己的下一顆照新那一格放行', async () => {
    const run = await runWithLogs('read-only', [
      delegate,
      flip('workspace-write'),
      write('/a.txt', '一'),
      { content: '子代理收工。' },
      write('/c.txt', '三'),
      { content: '根收工。' },
    ]);
    try {
      const [flipped, denied] = subagentToolTexts(run.model);
      // 前提：切換真的在子代理寫之前發生了。
      expect(flipped).toBe('切到 workspace-write');
      expect(denied).toContain('這個 backend 是唯讀的');
      expect(denied).toContain('mode: read-only');
      expect(await exists(join(root, 'a.txt'))).toBe(false);
      // 反例：同一格在 root 那側是新的那一格——快照沒有漏出 `task` 之外。
      expect(run.controller.current).toBe('workspace-write');
      expect(await readFile(join(root, 'c.txt'), 'utf8')).toBe('三');

      // 日誌：子代理一顆、帶來源、是委派那一格；root 的是起始值加一次切換，委派沒有多寫。
      expect(run.sandboxEvents('subagent')).toEqual([
        [{ mode: 'read-only', source: 'delegation' }],
      ]);
      expect(run.sandboxEvents('root')).toEqual([
        [{ mode: 'read-only' }, { mode: 'workspace-write' }],
      ]);
    } finally {
      await run.close();
    }
  }, 20000);

  it('委派之後 root 收緊：子代理照委派那一格照樣寫得進去（照 dsh，root 之後的切換不屬於它）', async () => {
    const run = await runWithLogs('workspace-write', [
      delegate,
      flip('read-only'),
      write('/a.txt', '一'),
      { content: '子代理收工。' },
      { content: '根收工。' },
    ]);
    try {
      const [flipped, wrote] = subagentToolTexts(run.model);
      expect(flipped).toBe('切到 read-only');
      expect(wrote).not.toContain('[containment]');
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('一');
      expect(run.controller.current).toBe('read-only');
      expect(run.sandboxEvents('subagent')).toEqual([
        [{ mode: 'workspace-write', source: 'delegation' }],
      ]);
    } finally {
      await run.close();
    }
  }, 20000);

  it('沒給 --workspace 的組裝：子代理的日誌一顆 `sandbox/mode` 都沒有', async () => {
    const run = await runWithLogs(
      'workspace-write',
      [delegate, { content: '子代理收工。' }, { content: '根收工。' }],
      { fence: false },
    );
    try {
      // 前提：子代理的日誌真的開了。
      expect(run.sandboxEvents('subagent')).toHaveLength(1);
      expect(run.sandboxEvents('subagent')).toEqual([[]]);
    } finally {
      await run.close();
    }
  }, 20000);

  it('子代理叫升級：「加寬」照委派那一格判，拿到的是不加寬的拒絕，不是 policy-never 那句', async () => {
    const run = await runWithLogs('danger-full-access', [
      delegate,
      flip('workspace-write'),
      escalate('/a.txt', 'danger-full-access'),
      { content: '子代理收工。' },
      { content: '根收工。' },
    ]);
    try {
      const [, refused] = subagentToolTexts(run.model);
      expect(refused).toBe(
        `Error: ${nonWideningRefusal('danger-full-access', 'danger-full-access')}`,
      );
      expect(refused).not.toContain('沒有人被問到');
    } finally {
      await run.close();
    }
  }, 20000);

  it('root 手上一顆沒用掉的 grant：子代理同檔同操作認領不到，root 之後照樣認領得到', async () => {
    const { agent, dispose, controller, model } = await assemble('read-only', [
      write('/a.txt', '一'),
      escalate('/a.txt', 'workspace-write'),
      delegate,
      write('/a.txt', '一'),
      { content: '子代理收工。' },
      write('/a.txt', '一'),
      { content: '根收工。' },
    ]);
    const config = { configurable: { thread_id: 'root-grant' } };
    try {
      const paused = await agent.invoke(toAgentInvocation('寫 a.txt。'), config);
      expect(rootToolTexts(paused)[0]).toContain('這個 backend 是唯讀的');
      const after = await agent.invoke(APPROVE, config);

      const [childWrite] = subagentToolTexts(model);
      expect(childWrite).toContain('這個 backend 是唯讀的');
      const texts = rootToolTexts(after);
      expect(texts[1]).toContain('核准了');
      // 最後一顆是 root 的重試。
      expect(texts.at(-1)).not.toContain('[containment]');
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('一');
      expect(controller.peekGrant()).toBeUndefined();
    } finally {
      await dispose();
    }
  }, 20000);

  it('root 被擋 → 子代理被擋 → root 升級：grant 綁的是 root 那一次，root 的重試過得去', async () => {
    const { agent, dispose, model } = await assemble('read-only', [
      write('/a.txt', '一'),
      delegate,
      write('/b.txt', '二'),
      { content: '子代理收工。' },
      escalate('/a.txt', 'workspace-write'),
      write('/a.txt', '一'),
      { content: '根收工。' },
    ]);
    const config = { configurable: { thread_id: 'root-denial' } };
    try {
      await agent.invoke(toAgentInvocation('寫 a.txt。'), config);
      // 前提：子代理那一顆真的被 fence 擋下來了——不然它本來就不會記 denial。
      expect(subagentToolTexts(model)[0]).toContain('這個 backend 是唯讀的');

      const after = await agent.invoke(APPROVE, config);
      expect(rootToolTexts(after).at(-1)).not.toContain('[containment]');
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('一');
      expect(await exists(join(root, 'b.txt'))).toBe(false);
    } finally {
      await dispose();
    }
  }, 20000);
});
