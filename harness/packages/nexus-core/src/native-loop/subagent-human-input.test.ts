/**
 * 前景子代理同一步兩顆 exclusive 呼叫：後一顆在屏障上 `idle` 等前一顆時，前一顆還在跑，子代理那一層就還在跑，root 那顆 `task` 不算停下，
 * 這一批不會被判成都在 `idle` 等而失敗（`suspension.ts` 的委派）。
 *
 * `invoke` 不放服務（`human-input.ts`）；一起釘住，兩條入口都照常收尾。
 */

import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { StateBackend } from 'deepagents';
import { fakeModel } from '../fixtures.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { assembleAgent } from '../agent-assembly.js';
import { fakePlugin } from '../fixtures.js';
import { foldRegistry } from '../fold.js';
import { loadPlugins } from '../load.js';

/** 沒宣告 `concurrencySafe`，是 exclusive；跑 50 毫秒，比判定卡死的那個 `setImmediate` 久。 */
const slow = (name: string) =>
  tool(
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return `${name} 好了`;
    },
    { name, description: name, schema: z.object({}) },
  );

describe('native：前景子代理一步兩顆 exclusive 呼叫', () => {
  it.each(['streamEvents', 'invoke'] as const)('%s：兩顆都收完，這次 run 照常收尾', async (via) => {
    const { registry } = await loadPlugins([
      fakePlugin('tools', (r) => {
        r.tools.register(slow('slow_a'));
        r.tools.register(slow('slow_b'));
      }),
    ]);
    const backend = new StateBackend();
    const params = foldRegistry(registry, {
      summarization: false,
      defaultBackend: backend,
      events: registry.dispatch,
    });
    const agent = assembleAgent({
      ...params,
      model: fakeModel()
        .respondWithTools([
          {
            name: 'task',
            args: { description: '叫兩顆', subagent_type: 'general-purpose' },
            id: 'root-task',
          },
        ])
        .respondWithTools([
          { name: 'slow_a', args: {}, id: 'sub-a' },
          { name: 'slow_b', args: {}, id: 'sub-b' },
        ])
        .respond(new AIMessage('子代理收完'))
        .respond(new AIMessage('root 收完')),
      backend: params.backend ?? backend,
      checkpointer: new MemorySaver(),
      loop: 'native',
      events: registry.dispatch,
    }) as unknown as {
      streamEvents(input: unknown, config: object): Promise<AsyncIterable<unknown>>;
      invoke(input: unknown, config: object): Promise<unknown>;
    };
    const input = { messages: [new HumanMessage('動手')] };
    const configurable = { thread_id: 't' };
    const seen: unknown[] = [];
    if (via === 'streamEvents') {
      for await (const event of await agent.streamEvents(input, { version: 'v3', configurable }))
        seen.push(event);
    } else {
      seen.push(await agent.invoke(input, { configurable }));
    }

    const text = JSON.stringify(seen);
    expect(text).toContain('子代理收完');
    expect(text).toContain('root 收完');
  });
});
