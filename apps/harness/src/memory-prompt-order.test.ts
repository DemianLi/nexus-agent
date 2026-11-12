/**
 * 記憶的渲染那半排在 `historyFromLog` 正前方，而且是最後一個改系統提示的（[#2361](https://github.com/DemianLi/nexus-agent/issues/2361) PR-D）。
 *
 * 請求快照要在推導之前寫，那一刻系統提示要已經完整；記憶那一段原本在洋蔥最內層、推導的內側，所以拆成讀檔與渲染兩半，
 * 渲染排到推導前面。搬過去仍是最後一塊的前提是：它後面（推導、請求快照、中止訊號、讀檔那半）沒有別的 cell 改系統提示或工具清單。
 * 之後有人在這幾格中間加 cell，這裡會紅。
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
      // 讀檔那半留在 tail（最後一格），順序不動。
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
