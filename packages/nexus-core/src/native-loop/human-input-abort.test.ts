/**
 * 呼叫端的 `config.signal` 在提問還掛著時舉起：這次 run 以中止拒絕，那顆呼叫的 `ask` 也要被收回，不留在記憶體裡等不到的答覆。
 *
 * pump 不帶 `config.signal`（`apps/harness/src/thread-pump.ts`），這條路只有直接呼叫 `streamEvents` 的人走得到，所以寫在這裡。
 */

import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { StateBackend } from 'deepagents';
import { fakeModel } from 'langchain';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { assembleAgent } from '../agent-assembly.js';
import { fakePlugin } from '../fixtures.js';
import { foldRegistry } from '../fold.js';
import { humanInputOf, isHumanInputWithdrawn } from '../human-input.js';
import { loadPlugins } from '../load.js';

describe('native：呼叫端中止時收回掛著的提問', () => {
  it('提問還沒答、呼叫端中止：串流以錯誤收尾，那次 ask 以 HumanInputWithdrawn 拒絕', async () => {
    let asked: (() => void) | undefined;
    const askedOnce = new Promise<void>((resolve) => (asked = resolve));
    let outcome: unknown = 'pending';
    const { registry } = await loadPlugins([
      fakePlugin('ask', (r) => {
        r.tools.register(
          tool(
            async (_input, config) => {
              const service = humanInputOf(config);
              if (service === undefined) throw new Error('讀不到等人服務');
              const answer = service.ask({ kind: 'question' });
              asked?.();
              try {
                return String(await answer);
              } catch (error) {
                outcome = error;
                throw error;
              }
            },
            { name: 'ask_probe', description: '問人。', schema: z.object({}) },
          ),
        );
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
        .respond(
          new AIMessage({
            content: '',
            tool_calls: [{ id: 'q1', name: 'ask_probe', args: {} }],
          }),
        )
        .respond(new AIMessage('好了')),
      backend: params.backend ?? backend,
      checkpointer: new MemorySaver(),
      loop: 'native',
      events: registry.dispatch,
    }) as unknown as {
      streamEvents(input: unknown, config: object): Promise<AsyncIterable<unknown>>;
    };
    const caller = new AbortController();
    const stream = await agent.streamEvents(
      { messages: [new HumanMessage('問我')] },
      { version: 'v3', configurable: { thread_id: 't' }, signal: caller.signal },
    );
    const drained = (async () => {
      for await (const _ of stream) {
        // 讀到底；中止時這裡拋。
      }
    })().then(
      () => 'completed',
      (error: unknown) => error,
    );
    await askedOnce;
    caller.abort();

    expect(await drained).not.toBe('completed');
    for (let i = 0; i < 5 && outcome === 'pending'; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(isHumanInputWithdrawn(outcome)).toBe(true);
  });
});
