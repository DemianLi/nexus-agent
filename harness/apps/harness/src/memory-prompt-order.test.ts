/**
 * 記憶的渲染那半排在 `historyFromLog` 正前方，而且是最後一個改系統提示的（[#2361](https://github.com/DemianLi/nexus-agent/issues/2361)）。
 *
 * 請求快照在推導之前寫，那一刻系統提示要已經完整，所以記憶分成讀檔與渲染兩半，渲染那半排在推導前面。
 * 記憶是最後一塊的前提是：它後面（推導、請求快照、中止訊號、讀檔那半）沒有別的 cell 改系統提示或工具清單。
 * 在這幾格中間加系統提示或工具清單 cell 會讓這支紅。
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySaver } from '@langchain/langgraph';
import { systemPromptCellOf, toolListCellOf } from '@nexus/core';
import { createMemoryPlugin } from '@nexus/plugin-memory';
import { describe, expect, it } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { ScriptedChatModel } from './scripted-model.js';

describe('記憶渲染那半的位置', () => {
  it('在 historyFromLog 正前方，它後面沒有別的系統提示或工具清單 cell', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-memory-order-'));
    await writeFile(join(root, 'AGENTS.md'), '代號胡桃。');
    const { agent, dispose } = await createNexusAgent({
      model: new ScriptedChatModel({ turns: [{ content: '好。' }] }),
      backend: new ContainedFilesystemBackend({ rootDir: root }),
      checkpointer: new MemorySaver(),
      agentLoop: 'native',
      historySource: 'log',
      plugins: [createMemoryPlugin()],
    });
    try {
      const stack = (agent as unknown as { middleware: readonly { name: string }[] }).middleware;
      const names = stack.map((entry) => entry.name);
      const promptAt = names.indexOf('nexusMemoryPrompt');
      const historyAt = names.indexOf('historyFromLog');
      expect(promptAt).toBeGreaterThanOrEqual(0);
      expect(historyAt).toBe(promptAt + 1);
      // 讀檔那半在 tail（最後一格）。
      expect(names.at(-1)).toBe('MemoryMiddleware');
      // 渲染那半之後，沒有別的 cell 改系統提示或工具清單。
      for (const entry of stack.slice(promptAt + 1)) {
        expect(systemPromptCellOf(entry), entry.name).toBeUndefined();
        expect(toolListCellOf(entry), entry.name).toBeUndefined();
      }
      expect(systemPromptCellOf(stack[promptAt]!)).toBeDefined();
    } finally {
      await dispose();
    }
  });
});
