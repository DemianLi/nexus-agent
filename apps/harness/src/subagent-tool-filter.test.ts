/**
 * 子代理的工具允許／拒絕清單（[#707](https://github.com/DemianLi/nexus-agent/issues/707)）的產品路徑：
 * 真的組裝（`createNexusAgent({ subagentToolFilter })`）、真的基座檔案工具（`ContainedFilesystemBackend`）、
 * 真的前景 `task` 與背景 `subagent`。**子代理有自己的假模型**，`boundToolNames` 是它當次請求真正綁到的工具名。
 *
 * 量三件事：被遮的工具不在模型的請求裡（前景、背景各一條）；手寫一則叫它的呼叫拿到錯誤結果、磁碟上沒有那個檔；
 * root 完全不受影響。
 */

import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import type { PluginEntry, ToolFilter } from '@nexus/core';
import { SessionRegistry } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedToolCall, ScriptedTurn } from './scripted-model.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-tool-filter-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const call = (name: string, args: ScriptedToolCall['args']): ScriptedTurn => ({
  content: '',
  toolCalls: [{ name, args }],
});
const toolTexts = (messages: readonly BaseMessage[]) =>
  messages.filter((message) => message.getType() === 'tool').map((message) => message.text);
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );
async function until(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function assemble(options: {
  rootTurns: ScriptedTurn[];
  workerTurns: ScriptedTurn[];
  filter: ToolFilter | undefined;
  background: boolean;
}) {
  const rootModel = new ScriptedChatModel({ turns: options.rootTurns });
  const workerModel = new ScriptedChatModel({ turns: options.workerTurns });
  const worker: PluginEntry = {
    plugin: {
      name: 'worker-host',
      apply(registry) {
        registry.subagents.register({
          name: 'worker',
          description: '幹活的。',
          systemPrompt: '你是 worker。',
          model: workerModel as never,
        });
        registry.tools.register(
          tool(() => '看過了', { name: 'look', description: '看一眼。', schema: z.object({}) }),
        );
        registry.tools.register(
          tool(() => '聽到了', { name: 'listen', description: '聽一聽。', schema: z.object({}) }),
        );
      },
    },
  };
  const built = await createNexusAgent({
    model: rootModel,
    checkpointer: new MemorySaver(),
    plugins: [worker],
    backend: new ContainedFilesystemBackend({ rootDir: dir, mode: 'workspace-write' }),
    ...(options.background && { backgroundSubagents: {} }),
    ...(options.filter !== undefined && { subagentToolFilter: options.filter }),
  });
  const sessions = new SessionRegistry('root-1');
  const detach = built.attachSession(sessions, {});
  return {
    rootModel,
    workerModel,
    sessions,
    async say() {
      return (await built.agent.invoke(
        { messages: [new HumanMessage('委派')] },
        { configurable: { thread_id: 'thread-1' } },
      )) as { messages: BaseMessage[] };
    },
    async close() {
      detach();
      await built.dispose();
    },
  };
}

const WRITE = call('write_file', { file_path: '/leak.txt', content: '不該寫出去' });
const delegateForeground = call('task', { description: '寫檔', subagent_type: 'worker' });
const delegateBackground = call('subagent', {
  description: '寫檔',
  subagent_type: 'worker',
  run_in_background: true,
});

describe('前景（task）', () => {
  it('deny write_file：子代理的請求沒有它；手寫呼叫拿到錯誤結果、磁碟沒有檔；root 的請求照舊有它', async () => {
    const run = await assemble({
      rootTurns: [delegateForeground, { content: '根收尾' }],
      workerTurns: [WRITE, { content: '子代理收尾' }],
      filter: { deny: ['write_file', 'listen'] },
      background: false,
    });
    try {
      await run.say();
      expect(run.workerModel.boundToolNames).toContain('read_file');
      expect(run.workerModel.boundToolNames).toContain('look');
      expect(run.workerModel.boundToolNames).not.toContain('write_file');
      expect(run.workerModel.boundToolNames).not.toContain('listen');
      expect(run.rootModel.boundToolNames).toContain('write_file');
      expect(run.rootModel.boundToolNames).toContain('listen');
      // 子代理第二輪看到的那則工具結果就是遮罩的拒絕句，檔沒寫出去。
      expect(JSON.stringify(run.workerModel.prompts.at(-1))).toContain('被設定遮掉了');
      expect(await exists(join(dir, 'leak.txt'))).toBe(false);
    } finally {
      await run.close();
    }
  });

  it('allow：基座工具只剩列到的，registry 工具也只剩列到的', async () => {
    const run = await assemble({
      rootTurns: [delegateForeground, { content: '根收尾' }],
      workerTurns: [{ content: '子代理收尾' }],
      filter: { allow: ['read_file', 'look'] },
      background: false,
    });
    try {
      await run.say();
      const bound = run.workerModel.boundToolNames.slice();
      expect([...bound].sort()).toEqual(['look', 'read_file']);
    } finally {
      await run.close();
    }
  });

  it('對照組：沒設過濾，子代理看得到 write_file、也寫得出去', async () => {
    const run = await assemble({
      rootTurns: [delegateForeground, { content: '根收尾' }],
      workerTurns: [WRITE, { content: '子代理收尾' }],
      filter: undefined,
      background: false,
    });
    try {
      await run.say();
      expect(run.workerModel.boundToolNames).toContain('write_file');
      expect(await exists(join(dir, 'leak.txt'))).toBe(true);
    } finally {
      await run.close();
    }
  });
});

describe('背景（subagent）', () => {
  it('deny write_file：背景那一輪的請求沒有它、寫不出去；背景 host 吃的是 fold 後的規格', async () => {
    const run = await assemble({
      rootTurns: [delegateBackground, { content: '根收尾' }],
      workerTurns: [WRITE, { content: '背景收尾' }],
      filter: { deny: ['write_file'] },
      background: true,
    });
    try {
      const result = await run.say();
      expect(toolTexts(result.messages)[0]).toMatch(/bg-[0-9a-f]{12}/);
      await until(() => run.workerModel.prompts.length >= 2);
      expect(run.workerModel.boundToolNames).not.toContain('write_file');
      expect(JSON.stringify(run.workerModel.prompts.at(-1))).toContain('被設定遮掉了');
      expect(await exists(join(dir, 'leak.txt'))).toBe(false);
      expect(run.rootModel.boundToolNames).toContain('write_file');
    } finally {
      await run.close();
    }
  });
});

describe('組裝期驗名字', () => {
  it('未知名字：createNexusAgent 拋，訊息指名並列出已知名單', async () => {
    await expect(
      assemble({
        rootTurns: [],
        workerTurns: [],
        filter: { deny: ['writte_file'] },
        background: false,
      }),
    ).rejects.toThrow(/"writte_file"[\s\S]*write_file/);
  });
});
