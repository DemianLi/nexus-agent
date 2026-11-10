/**
 * native 直接呼叫 `streamEvents` 才走得到的兩條邊界，pump 那條路造不出來：
 *
 * - 呼叫端的 `config.signal` 在提問還掛著時舉起：這次 run 以中止拒絕，那顆呼叫的 `ask` 也要被收回，不留在記憶體裡等不到的答覆。
 *   pump 不帶 `config.signal`（`apps/harness/src/thread-pump.ts`）。
 * - 接回時一顆答覆都沒帶（`Command({ resume: {} })`）：pump 一次只送一顆 id 的答覆（`thread-pump.ts`），造不出來；這裡量 agent 自己
 *   在動任何狀態之前拋。
 */

import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { Command, MemorySaver } from '@langchain/langgraph';
import { StateBackend } from 'deepagents';
import { fakeModel } from '../fixtures.js';
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

describe('native：接回時一顆答覆都沒帶', () => {
  it('當場拋；thread 照舊停著、沒發任何事件（不重發 tool-started）；之後帶對的 id 照常接回', async () => {
    const { registry } = await loadPlugins([
      fakePlugin('ask', (r) => {
        r.tools.register(
          tool(
            async (_input, config) => {
              const service = humanInputOf(config);
              if (service === undefined) throw new Error('讀不到等人服務');
              return `答覆：${String(await service.ask({ kind: 'question' }))}`;
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
      streamEvents(input: unknown, config: object): Promise<AsyncIterable<Event>>;
    };
    type Event = {
      readonly seq: number;
      readonly method: string;
      readonly params: { readonly data?: { event?: string; values?: { id: string }[] } };
    };
    const config = { version: 'v3', configurable: { thread_id: 't' } };
    const drain = async (stream: AsyncIterable<Event>): Promise<Event[]> => {
      const events: Event[] = [];
      for await (const event of stream) events.push(event);
      return events;
    };
    const parked = await drain(
      await agent.streamEvents({ messages: [new HumanMessage('問我')] }, config),
    );
    const id = parked.find((event) => event.method === 'updates')?.params.data?.values?.[0]?.id;
    expect(id).toMatch(/^[0-9a-f]{32}$/);

    await expect(agent.streamEvents(new Command({ resume: {} }), config)).rejects.toThrow(
      '沒有帶任何一顆答覆',
    );

    const resumed = await drain(
      await agent.streamEvents(new Command({ resume: { [id!]: 'A' } }), config),
    );
    // 序號接在停住那一段後面：中間那次被拒的接回沒發出任何事件（換串流、`lifecycle running`、重發 `tool-started` 都會佔序號）。
    expect(resumed[0]?.seq).toBe(parked.at(-1)!.seq + 1);
    expect(
      resumed.filter(
        (event) => event.method === 'tools' && event.params.data?.event === 'tool-started',
      ),
    ).toHaveLength(1);
    expect(resumed.some((event) => JSON.stringify(event).includes('答覆：A'))).toBe(true);
  });
});
