/**
 * CLI headless（`HEADLESS_APPROVALS`、`runTurn`）那條路上，每顆工具呼叫的 config 放的是什麼（[#2358](https://github.com/DemianLi/nexus-agent/issues/2358)）：
 * native 放「這裡沒人可問」（`NO_HUMAN_INPUT`），不放等人服務；`langgraph` 兩樣都不放。管道是 `policy-never`，閘門與讀管道的
 * 生產者在那一格就回絕；不看管道、直接 `exec.interrupt` 的生產者（MCP 反問）靠這顆標記，所以這裡釘住它真的在。
 *
 * **零憑證、零外部連線**：模型是腳本。
 */

import { tool } from '@langchain/core/tools';
import type { PluginEntry } from '@nexus/core';
import { humanInputOf, humanInputUnavailable } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { HEADLESS_APPROVALS } from './agent-factory.js';
import { createCliAgent } from './assembly-root.js';
import { runTurn } from './cli.js';
import { shippedPlugins, withScriptedModel } from './fixtures.js';

interface Seen {
  readonly service: boolean;
  readonly unavailable: boolean;
}

/** 一顆記下自己 config 上放了什麼的工具。 */
function readerPlugin(seen: Seen[]): PluginEntry {
  return {
    plugin: {
      name: 'reader',
      apply(registry) {
        registry.tools.register(
          tool(
            async (_input, config) => {
              seen.push({
                service: humanInputOf(config) !== undefined,
                unavailable: humanInputUnavailable(config),
              });
              return '讀了';
            },
            { name: 'reader', description: 'reader', schema: z.object({}) },
          ),
        );
      },
    },
  };
}

describe.each(['langgraph', 'native'] as const)('%s：CLI headless 那條路', (loop) => {
  it('工具呼叫的 config：native 是標記、沒有服務；langgraph 都沒有', async () => {
    const seen: Seen[] = [];
    const { agent, dispose, sessionLog } = await createCliAgent(
      { live: false, agentLoop: loop },
      withScriptedModel(
        [...(await shippedPlugins()), readerPlugin(seen)],
        [{ content: '', toolCalls: [{ name: 'reader', args: {} }] }, { content: '收工。' }],
      ),
      undefined,
      { approvals: HEADLESS_APPROVALS },
    );
    try {
      await runTurn(agent, '讀。', { log: () => {}, error: () => {} }, sessionLog, undefined, loop);
    } finally {
      await dispose();
    }

    expect(seen).toEqual([{ service: false, unavailable: loop === 'native' }]);
  }, 60000);
});
