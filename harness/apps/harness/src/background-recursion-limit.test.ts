/**
 * 背景子代理的遞迴上限（[#858](https://github.com/DemianLi/nexus-agent/issues/858) 的量測順帶量到的）。
 *
 * 背景圖是 `compileSubagentGraph` 用 `createAgent` 直接編的：沒有 `createDeepAgent` 最後那層 `withConfig({ recursionLimit })`，
 * 也沒有一次性子代理從 `task` 那次呼叫繼承來的 root 上限，於是落在 LangGraph 的預設 25。量到的：這個預設下連續 8 次
 * 工具呼叫就 `GraphRecursionError`（develop 上就是，掛上插話載體之後 5 次就撞）。serve 出廠就是背景續行之後，
 * 每個做點事的背景子代理都會 `turn/failed`。
 *
 * 修法是 `compileSubagent` 給圖帶 root 同一個上限（旗標 > 設定列 > 預設）。這裡兩條量它：
 * 預設值下 12 次工具呼叫跑得完（25 的時候不行）、呼叫端明著傳的上限真的到得了背景圖（用一個既不是 25 也不是預設 100 的值）。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import type { PluginEntry } from '@nexus/core';
import { BACKGROUND_SESSION_CONFIG_KEY } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import type { BackgroundAgent } from './background-subagents.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';

describe('背景子代理的遞迴上限', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nexus-bg-recursion-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const crew: PluginEntry = {
    plugin: {
      name: 'recursion-crew',
      apply(registry) {
        registry.subagents.register({
          name: 'worker',
          description: '連續呼叫工具的。',
          systemPrompt: '幹活。',
          tools: [
            tool(() => 'pong', { name: 'ping', description: '一次。', schema: z.object({}) }),
          ],
        });
      },
    },
  };

  /** 背景 worker 連續呼叫 `pings` 次工具再收尾，回這一輪是否跑完（沒跑完就是拋出的錯誤名）。 */
  async function runWorker(pings: number, recursionLimit?: number): Promise<string> {
    const turns: ScriptedTurn[] = [
      ...Array.from({ length: pings }, () => ({
        content: '',
        toolCalls: [{ name: 'ping', args: {} }],
      })),
      { content: '完' },
    ];
    const built = await createNexusAgent({
      model: new ScriptedChatModel({ turns }),
      checkpointer: new MemorySaver(),
      plugins: [crew],
      backend: new ContainedFilesystemBackend({ rootDir: dir, mode: 'workspace-write' }),
      ...(recursionLimit !== undefined && { recursionLimit }),
    });
    try {
      const graph = built.compileSubagent(
        'worker',
        new MemorySaver(),
      ) as unknown as BackgroundAgent;
      const run = await graph.streamEvents(
        { messages: [{ role: 'user', content: '開工' }] } as never,
        {
          version: 'v3',
          configurable: { thread_id: 'root/bg-1', [BACKGROUND_SESSION_CONFIG_KEY]: 'bg-1' },
        },
      );
      for await (const event of run) void event;
      return 'ok';
    } catch (error) {
      return (error as Error).name;
    } finally {
      await built.dispose();
    }
  }

  it('預設的上限下，連續 12 次工具呼叫跑得完（LangGraph 的預設 25 撐不到）', async () => {
    expect(await runWorker(12)).toBe('ok');
  });

  it('呼叫端明著傳的上限到得了背景圖：同樣 12 次，傳 30（不是 25 也不是預設 100）就撞牆', async () => {
    expect(await runWorker(12, 30)).toBe('GraphRecursionError');
  });
});
