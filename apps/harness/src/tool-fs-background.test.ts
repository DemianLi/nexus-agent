/**
 * 背景子代理也拿 `tool-fs` 的白名單（[#1605](https://github.com/DemianLi/nexus-agent/issues/1605)）：出貨是 continuable 背景模式，
 * 背景圖由 `compileSubagentGraph` 另編，不經 `task`。回歸的話，背景子代理會重新看到 `write_file`。
 * 前景（root、`task` 子代理）在 `tool-fs.test.ts`；選項物件的形狀在 `packages/nexus-core/src/agent-assembly-options.test.ts`。
 */

import { tmpdir } from 'node:os';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import type { PluginEntry } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';
import { toolFsPlugin } from './settings/tool-fs.js';

const toolFs = (config: Record<string, unknown>): PluginEntry => ({
  plugin: toolFsPlugin as never,
  config,
});

const WORKER: PluginEntry = {
  plugin: {
    name: 'tool-fs-assembly-host',
    apply(registry) {
      registry.tools.register(
        tool(() => 'pong', { name: 'ping', description: '回 pong。', schema: z.object({}) }),
      );
      registry.subagents.register({
        name: 'worker',
        description: '幹活的。',
        systemPrompt: '你是 worker。',
      });
    },
  },
};

/** 每一次 `bindTools` 收到的工具名。 */
class RecordingModel extends ScriptedChatModel {
  readonly bindings: string[][] = [];

  override bindTools(tools: readonly unknown[]): ScriptedChatModel {
    this.bindings.push(tools.map((each) => (each as { name: string }).name));
    return super.bindTools(tools);
  }
}

/** 組一個有 `worker` 子代理的 agent。 */
async function assemble(plugins: readonly PluginEntry[]) {
  return createNexusAgent({
    model: new RecordingModel({ turns: [{ content: '好。' }] }),
    plugins: [WORKER, ...plugins],
    checkpointer: new MemorySaver(),
    backend: new ContainedFilesystemBackend({ rootDir: tmpdir(), mode: 'workspace-write' }),
  });
}

describe('背景子代理的工具清單', () => {
  it('背景子代理：`compileSubagent` 編出來的圖，模型綁到的工具沒有 write_file／edit_file／delete', async () => {
    const built = await assemble([toolFs({ write: false, edit: false })]);
    const model = new RecordingModel({ turns: [{ content: '好。' }] });
    try {
      const graph = built.compileSubagent('worker', new MemorySaver(), model) as unknown as {
        invoke: (input: unknown, config?: unknown) => Promise<unknown>;
      };
      await graph.invoke(toAgentInvocation('做。'), { configurable: { thread_id: 'bg' } });

      expect(model.bindings.length).toBeGreaterThanOrEqual(1);
      for (const names of model.bindings) {
        for (const closed of ['write_file', 'edit_file', 'delete']) {
          expect(names, closed).not.toContain(closed);
        }
        for (const kept of ['ls', 'read_file', 'glob', 'grep']) expect(names, kept).toContain(kept);
      }
    } finally {
      await built.dispose();
    }
  });

  it('對照：沒有 tool-fs 這一列時，背景子代理的圖看得到 write_file', async () => {
    const built = await assemble([]);
    const model = new RecordingModel({ turns: [{ content: '好。' }] });
    try {
      const graph = built.compileSubagent('worker', new MemorySaver(), model) as unknown as {
        invoke: (input: unknown, config?: unknown) => Promise<unknown>;
      };
      await graph.invoke(toAgentInvocation('做。'), { configurable: { thread_id: 'bg' } });

      expect(model.bindings.flat()).toContain('write_file');
    } finally {
      await built.dispose();
    }
  });
});
