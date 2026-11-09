/**
 * **停在核准點時收回，同一批的兄弟呼叫各只有一筆結果**（[#2627](https://github.com/DemianLi/nexus-agent/issues/2627)）。
 *
 * 模型一步叫兩顆：`danger` 要核准，`other` 不用。收回時 `other` 可能已經落定（跑完，或在閘門裡按停止時派工前就被中止），
 * 也可能排在 `danger` 後面還沒起跑。不論哪一種，收完之後：
 *
 * - 每個 tool call id 恰好一筆 `tool/result`，日誌的跨筆關係 0 違規；
 * - 跑完的那顆，對話裡是它真的結果，它用 `Command` 寫的 state 也還在；
 * - 還沒起跑的那顆，結果前面有它自己的 `tool/call`，碼是 `ABORTED_BEFORE_DISPATCH`。
 *
 * 收線（`close()`）時還停在核准點的，不寫日誌。
 *
 * @module
 */

import { ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { Command } from '@langchain/langgraph';
import type { PluginEntry, SessionEvent } from '@nexus/core';
import { createSessionRelationshipChecker, TOOL_ABORTED_BEFORE_DISPATCH } from '@nexus/core';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createNexusAgent } from './agent-factory.js';
import { PrunedMemorySaver } from './pruned-memory-saver.js';
import { ScriptedChatModel } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

type Loop = 'langgraph' | 'native';
type Order = 'danger-first' | 'other-first';

const LOOPS = ['langgraph', 'native'] as const;
const OTHER_TEXT = '另一顆做完';
const FILE = '/sibling.txt';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * 組一份。
 *
 * @param loop - 哪一個 loop。
 * @param options.order - 兩顆呼叫的先後。
 * @param options.gate - 閘門同步回 `ask`，或先等一拍 macrotask。
 * @param options.onGate - 閘門判定 `danger` 要問、回 `ask` 之前叫一次。
 * @param options.command - `other` 回 `Command`：寫一個檔進 `files`，帶它的 ToolMessage。
 */
async function assemble(
  loop: Loop,
  options: {
    order: Order;
    gate?: 'sync' | 'async';
    onGate?: () => void;
    command?: boolean;
  },
) {
  const danger = { name: 'danger', args: {} };
  const other = { name: 'other', args: {} };
  const model = new ScriptedChatModel({
    turns: [
      {
        content: '動手。',
        toolCalls: options.order === 'danger-first' ? [danger, other] : [other, danger],
      },
      { content: '好。' },
    ],
  });
  const hook = { onGate: options.onGate };
  const ask = { kind: 'ask' as const, reason: '危險' };
  const ran = { other: 0 };
  const plugin: PluginEntry = {
    plugin: {
      name: 'withdraw-sibling',
      apply(registry) {
        registry.tools.register(
          tool(() => '做完了', { name: 'danger', description: '要核准。', schema: z.object({}) }),
        );
        registry.tools.register(
          tool(
            (_input: unknown, config: { toolCall?: { id?: string } }) => {
              ran.other += 1;
              if (options.command !== true) return OTHER_TEXT;
              const stamp = '2026-11-09T00:00:00Z';
              return new Command({
                update: {
                  files: { [FILE]: { content: ['寫了'], created_at: stamp, modified_at: stamp } },
                  messages: [
                    new ToolMessage({
                      content: OTHER_TEXT,
                      tool_call_id: config.toolCall?.id ?? '',
                    }),
                  ],
                },
              });
            },
            { name: 'other', description: '不用核准。', schema: z.object({}) },
          ),
        );
        registry.approvals.gate((exec, next) => {
          if (exec.name !== 'danger') return next();
          const fire = (): typeof ask => {
            const onGate = hook.onGate;
            hook.onGate = undefined;
            onGate?.();
            return ask;
          };
          if (options.gate !== 'async') return fire();
          return new Promise<void>((resolve) => setImmediate(resolve)).then(fire);
        });
      },
    },
  };
  const built = await createNexusAgent({
    model,
    checkpointer: new PrunedMemorySaver(),
    agentLoop: loop,
    plugins: [plugin],
  });
  const threadId = `withdraw-sibling-${loop}`;
  const agent = built.agent as unknown as PumpAgent;
  const pump = new ThreadPump(agent, threadId);
  const detach = built.attachSession(pump.sessions);
  cleanups.push(async () => {
    detach();
    await built.dispose();
  });
  const log = (): readonly SessionEvent[] => pump.sessions.root.events;
  const state = async () =>
    (await agent.getState({ configurable: { thread_id: threadId } })).values as {
      messages: unknown[];
      files?: Record<string, unknown>;
    };
  return { pump, log, state, ran };
}

/** `tool/call` 記下的名字，照 callId 找。 */
function namesOf(events: readonly SessionEvent[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const event of events) {
    if (event.type === 'tool/call') {
      const { callId, name } = (event as SessionEvent<'tool/call'>).data;
      names.set(callId, name);
    }
  }
  return names;
}

/** 每顆呼叫記了幾筆 `tool/result`，鍵是工具名。 */
function resultCounts(events: readonly SessionEvent[]): Record<string, number> {
  const names = namesOf(events);
  const counts: Record<string, number> = {};
  for (const event of events) {
    if (event.type !== 'tool/result') continue;
    const name =
      names.get((event as SessionEvent<'tool/result'>).data.callId) ?? '(沒有 tool/call)';
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

/** 整份日誌的跨筆關係違規。 */
function violations(events: readonly SessionEvent[]): string[] {
  const checker = createSessionRelationshipChecker();
  return events.flatMap((event) => checker.accept(event).map((violation) => violation.message));
}

/** 對話裡 `other` 那顆呼叫的 ToolMessage 文字。 */
async function otherReply(run: Awaited<ReturnType<typeof assemble>>): Promise<string | undefined> {
  const callId = [...namesOf(run.log())].find(([, name]) => name === 'other')?.[0];
  const messages = (await run.state()).messages;
  const reply = messages.find(
    (message): message is ToolMessage =>
      ToolMessage.isInstance(message) && message.tool_call_id === callId,
  );
  return reply === undefined ? undefined : String(reply.content);
}

/** 收回之後的共同斷言。 */
function expectOneResultEach(run: Awaited<ReturnType<typeof assemble>>): void {
  expect(run.pump.awaitingInput).toBe(false);
  expect(run.log().at(-1)).toMatchObject({
    type: 'turn/end',
    data: { reason: { kind: 'aborted' } },
  });
  expect(resultCounts(run.log())).toEqual({ danger: 1, other: 1 });
  expect(violations(run.log())).toEqual([]);
}

/** 停在核准點、停穩之後按一次停止。 */
async function settleThenStop(run: Awaited<ReturnType<typeof assemble>>): Promise<void> {
  await run.pump.submit({ kind: 'message', text: '做' });
  await run.pump.whenIdle();
  expect(run.pump.awaitingInput).toBe(true);
  expect(run.pump.cancel()).toBe('withdrawn');
  await run.pump.whenIdle();
}

describe('停在核准點時收回：兄弟呼叫各一筆結果', () => {
  it.each(
    LOOPS.flatMap((loop) => (['sync', 'async'] as const).map((gate) => [loop, gate] as const)),
  )('%s：%s 閘門裡按停止，排在後面的那顆在這一輪派工前被中止', async (loop, gate) => {
    let landed: string | undefined;
    const run = await assemble(loop, {
      order: 'danger-first',
      gate,
      onGate: () => {
        landed = run.pump.cancel();
      },
    });
    await run.pump.submit({ kind: 'message', text: '做' });
    await run.pump.whenIdle();

    expect(landed).toBe('run');
    expect(run.ran.other).toBe(0);
    expectOneResultEach(run);
    expect(await otherReply(run)).toBe(`Error: tool call aborted before dispatch`);
  });

  it.each(
    LOOPS.flatMap((loop) => (['sync', 'async'] as const).map((gate) => [loop, gate] as const)),
  )('%s：%s 閘門裡按停止，排在前面的那顆已經跑完', async (loop, gate) => {
    let landed: string | undefined;
    const run = await assemble(loop, {
      order: 'other-first',
      gate,
      onGate: () => {
        landed = run.pump.cancel();
      },
    });
    await run.pump.submit({ kind: 'message', text: '做' });
    await run.pump.whenIdle();

    expect(landed).toBe('run');
    expect(run.ran.other).toBe(1);
    expectOneResultEach(run);
    expect(await otherReply(run)).toBe(OTHER_TEXT);
  });

  it.each(LOOPS)('%s：前面那顆跑完，停穩之後按一次停止', async (loop) => {
    const run = await assemble(loop, { order: 'other-first' });
    await settleThenStop(run);

    expect(run.ran.other).toBe(1);
    expectOneResultEach(run);
    expect(await otherReply(run)).toBe(OTHER_TEXT);
  });

  it.each(LOOPS)('%s：前面那顆回 Command，收回之後它寫的 state 還在', async (loop) => {
    const run = await assemble(loop, { order: 'other-first', command: true });
    await settleThenStop(run);

    expect(run.ran.other).toBe(1);
    expectOneResultEach(run);
    expect(await otherReply(run)).toBe(OTHER_TEXT);
    expect(Object.keys((await run.state()).files ?? {})).toEqual([FILE]);
  });

  it.each(LOOPS)('%s：後面那顆還沒起跑，停穩之後按一次停止', async (loop) => {
    const run = await assemble(loop, { order: 'danger-first' });
    await settleThenStop(run);

    expect(run.ran.other).toBe(0);
    expectOneResultEach(run);
    // 收回那一輪裡，它的 `tool/call` 緊接在它的結果前面。
    const resumed = run.log().findLastIndex((event) => event.type === 'turn/start');
    const tail = run.log().slice(resumed);
    const names = namesOf(run.log());
    const at = tail.findIndex(
      (event) =>
        event.type === 'tool/call' && (event as SessionEvent<'tool/call'>).data.name === 'other',
    );
    expect(at).toBeGreaterThan(0);
    expect(tail[at + 1]).toMatchObject({
      type: 'tool/result',
      data: {
        callId: (tail[at] as SessionEvent<'tool/call'>).data.callId,
        isError: true,
        error: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH },
      },
    });
    expect(names.get((tail[at] as SessionEvent<'tool/call'>).data.callId)).toBe('other');
  });

  it.each(
    LOOPS.flatMap((loop) =>
      (['danger-first', 'other-first'] as const).map((order) => [loop, order] as const),
    ),
  )('%s：%s，停在核准點時收線，不寫日誌', async (loop, order) => {
    const run = await assemble(loop, { order });
    await run.pump.submit({ kind: 'message', text: '做' });
    await run.pump.whenIdle();
    expect(run.pump.awaitingInput).toBe(true);
    const before = run.log().length;

    run.pump.close();
    await new Promise((resolve) => setImmediate(resolve));

    expect(run.log().length).toBe(before);
  });
});
