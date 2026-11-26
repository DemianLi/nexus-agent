/**
 * **同一批都在等、沒有一顆在問人時，這一輪收尾之後什麼都不再跑**（[#2642](https://github.com/DemianLi/nexus-agent/issues/2642)）。
 *
 * `stall` 等一件永遠不會兌現的事：native 下經等人服務的 `idle` 等，判成卡死、這一輪失敗；`langgraph` 沒有這個判定，一直等到按停止。
 * 兩條收尾的方式不同，收完之後要一樣：
 *
 * - 這一輪最後一筆事件（`turn/failed` 或 `turn/end`）之後，日誌沒有任何事件；
 * - 每顆呼叫在日誌與對話裡各恰好一筆結果，日誌的跨筆關係 0 違規；
 * - 已經收完的呼叫，它寫的 state 還在；排在 `stall` 後面、還沒起跑的，本體沒有跑。
 *
 * @module
 */

import { ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { Command } from '@langchain/langgraph';
import type { PluginEntry, SessionEvent } from '@nexus/core';
import { createSessionRelationshipChecker, humanInputOf, turnCancelSignalOf } from '@nexus/core';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createNexusAgent } from './agent-factory.js';
import { PrunedMemorySaver } from './pruned-memory-saver.js';
import { ScriptedChatModel, type ScriptedTurn } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

type Loop = 'langgraph' | 'native';

const LOOPS = ['langgraph', 'native'] as const;
const OTHER_TEXT = '另一顆做完';
const FILE = '/stuck.txt';
const TERMINAL = new Set(['turn/end', 'turn/failed']);
const SWALLOWED = '吞掉了';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const plugin = (ran: { other: number }, options: { goto?: boolean } = {}): PluginEntry => ({
  plugin: {
    name: 'stuck-run-stops',
    apply(registry) {
      registry.tools.register(
        tool(
          (_input: unknown, config: { toolCall?: { id?: string } }) => {
            ran.other += 1;
            const stamp = '2026-11-10T00:00:00Z';
            return new Command({
              ...(options.goto === true ? { goto: 'elsewhere' } : {}),
              update: {
                files: { [FILE]: { content: ['寫了'], created_at: stamp, modified_at: stamp } },
                messages: [
                  new ToolMessage({ content: OTHER_TEXT, tool_call_id: config.toolCall?.id ?? '' }),
                ],
              },
            });
          },
          { name: 'other', description: '寫一個檔。', schema: z.object({}) },
        ),
      );
      registry.tools.register(
        tool(
          (_input: unknown, config: unknown) => {
            const human = humanInputOf(config);
            if (human !== undefined) return human.idle(new Promise<string>(() => {}));
            const signal = turnCancelSignalOf(config);
            return new Promise<string>((_resolve, reject) => {
              signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
          },
          { name: 'stall', description: '等一件不會來的事。', schema: z.object({}) },
        ),
      );
      // 把收回的拒絕接住、正常回傳：外掛工具常見的 try/catch。
      for (const name of ['asker', 'idler'] as const) {
        registry.tools.register(
          tool(
            async (_input: unknown, config: unknown) => {
              const human = humanInputOf(config)!;
              try {
                if (name === 'asker') await human.ask({ q: '可以嗎' });
                else await human.idle(new Promise<string>(() => {}));
              } catch {
                return SWALLOWED;
              }
              return '不該走到';
            },
            { name, description: '等，被收回就吞掉。', schema: z.object({}) },
          ),
        );
      }
    },
  },
});

async function assemble(loop: Loop, turns: ScriptedTurn[], options: { goto?: boolean } = {}) {
  const ran = { other: 0 };
  const built = await createNexusAgent({
    model: new ScriptedChatModel({ turns }),
    checkpointer: new PrunedMemorySaver(),
    agentLoop: loop,
    plugins: [plugin(ran, options)],
  });
  const threadId = `stuck-run-stops-${loop}`;
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

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 送一句、等這一輪收尾。native 由卡死判定收尾；`langgraph` 等到 `ready` 成立就按停止。
 *
 * @param ready - 日誌到了可以按停止的地方。
 */
async function runToEnd(
  loop: Loop,
  run: Awaited<ReturnType<typeof assemble>>,
  ready: (events: readonly SessionEvent[]) => boolean,
): Promise<void> {
  const submitted = run.pump.submit({ kind: 'message', text: '做' }).catch(() => undefined);
  if (loop === 'langgraph') {
    while (!ready(run.log())) await settle(5);
    expect(run.pump.cancel()).toBe('run');
  }
  await submitted;
  await run.pump.whenIdle();
  // 收尾之後還在跑的東西要有機會露面：跑過的模型與工具都是同步或幾拍內落定。
  await settle(50);
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

/** 共同斷言：最後一筆是這一輪的收尾，之後沒有事件；每顆呼叫日誌與對話各一筆結果；0 違規。 */
async function expectEndedCleanly(loop: Loop, run: Awaited<ReturnType<typeof assemble>>) {
  const events = run.log();
  const end = events.findIndex((event) => TERMINAL.has(event.type));
  expect(end).toBeGreaterThan(0);
  expect(events.slice(end + 1).map((event) => event.type)).toEqual([]);
  expect(events[end]?.type).toBe(loop === 'native' ? 'turn/failed' : 'turn/end');

  const results: Record<string, number> = {};
  for (const callId of namesOf(events).keys()) results[callId] = 0;
  for (const event of events) {
    if (event.type !== 'tool/result') continue;
    const { callId } = (event as SessionEvent<'tool/result'>).data;
    results[callId] = (results[callId] ?? 0) + 1;
  }
  expect(Object.values(results)).toEqual([1, 1]);

  const checker = createSessionRelationshipChecker();
  expect(events.flatMap((event) => checker.accept(event).map((v) => v.message))).toEqual([]);

  const replies: Record<string, number> = {};
  for (const callId of namesOf(events).keys()) replies[callId] = 0;
  for (const message of (await run.state()).messages) {
    if (ToolMessage.isInstance(message)) {
      replies[message.tool_call_id] = (replies[message.tool_call_id] ?? 0) + 1;
    }
  }
  expect(Object.values(replies)).toEqual([1, 1]);
}

/** 對話裡 `other` 那顆呼叫的 ToolMessage 文字。 */
async function otherReply(run: Awaited<ReturnType<typeof assemble>>): Promise<string | undefined> {
  const callId = [...namesOf(run.log())].find(([, name]) => name === 'other')?.[0];
  const reply = (await run.state()).messages.find(
    (message): message is ToolMessage =>
      ToolMessage.isInstance(message) && message.tool_call_id === callId,
  );
  return reply === undefined ? undefined : String(reply.content);
}

const otherSettled = (events: readonly SessionEvent[]) =>
  events.some((event) => event.type === 'tool/result') &&
  events.some(
    (event) =>
      event.type === 'tool/call' && (event as SessionEvent<'tool/call'>).data.name === 'stall',
  );

describe('同一批都在等、沒有一顆在問人：這一輪收尾之後什麼都不再跑', () => {
  it.each(LOOPS)('%s：前面那顆收完，它寫的 state 還在', async (loop) => {
    const run = await assemble(loop, [
      {
        content: '動手。',
        toolCalls: [
          { name: 'other', args: {} },
          { name: 'stall', args: {} },
        ],
      },
      { content: '不該走到。' },
    ]);
    await runToEnd(loop, run, otherSettled);

    await expectEndedCleanly(loop, run);
    expect(run.ran.other).toBe(1);
    expect(await otherReply(run)).toBe(OTHER_TEXT);
    expect(Object.keys((await run.state()).files ?? {})).toEqual([FILE]);
    expect(run.log().filter((event) => event.type === 'assistant/message')).toHaveLength(1);
  });

  it.each(LOOPS)('%s：收尾之後不再叫模型，模型下一步要叫的工具不會跑', async (loop) => {
    const run = await assemble(loop, [
      {
        content: '動手。',
        toolCalls: [
          { name: 'other', args: {} },
          { name: 'stall', args: {} },
        ],
      },
      { content: '再一顆。', toolCalls: [{ name: 'other', args: {} }] },
      { content: '不該走到。' },
    ]);
    await runToEnd(loop, run, otherSettled);

    await expectEndedCleanly(loop, run);
    expect(run.ran.other).toBe(1);
    expect(run.log().filter((event) => event.type === 'assistant/message')).toHaveLength(1);
  });

  it.each(LOOPS)('%s：排在屏障上等的那顆，本體不會跑', async (loop) => {
    const run = await assemble(loop, [
      {
        content: '動手。',
        toolCalls: [
          { name: 'stall', args: {} },
          { name: 'other', args: {} },
        ],
      },
      { content: '不該走到。' },
    ]);
    await runToEnd(loop, run, (events) =>
      events.some(
        (event) =>
          event.type === 'tool/call' && (event as SessionEvent<'tool/call'>).data.name === 'stall',
      ),
    );

    await expectEndedCleanly(loop, run);
    expect(run.ran.other).toBe(0);
    expect((await run.state()).files ?? {}).toEqual({});
    expect(run.log().filter((event) => event.type === 'assistant/message')).toHaveLength(1);
  });
});

/**
 * 工具接住拒絕、正常回傳之後：收尾之後不再叫模型、不再起新的呼叫；對話裡每顆呼叫恰好一則 ToolMessage。
 * 那顆工具晚到的 `tool/result` 仍會記進日誌，這裡不斷言日誌在收尾之後是空的。
 */
async function expectStoppedOnce(run: Awaited<ReturnType<typeof assemble>>, terminal: string) {
  const events = run.log();
  const end = events.findLastIndex((event) => event.type === terminal);
  expect(end).toBeGreaterThan(0);
  expect(
    events
      .slice(end + 1)
      .map((event) => event.type)
      .filter((type) => type !== 'tool/result'),
  ).toEqual([]);
  const replies: Record<string, number> = {};
  for (const callId of namesOf(events).keys()) replies[callId] = 0;
  for (const message of (await run.state()).messages) {
    if (ToolMessage.isInstance(message)) {
      replies[message.tool_call_id] = (replies[message.tool_call_id] ?? 0) + 1;
    }
  }
  expect(Object.values(replies)).toEqual([1, 1]);
}

const TWO_CALLS_THEN_MORE = (second: string): ScriptedTurn[] => [
  {
    content: '動手。',
    toolCalls: [
      { name: 'other', args: {} },
      { name: second, args: {} },
    ],
  },
  { content: '再一顆。', toolCalls: [{ name: 'other', args: {} }] },
  { content: '不該走到。' },
];

describe('native：工具把收回的拒絕接住、正常回傳', () => {
  it('判成卡死：收完的寫入只套一次，不再叫模型', async () => {
    const run = await assemble('native', TWO_CALLS_THEN_MORE('idler'));
    await runToEnd('native', run, () => true);

    await expectStoppedOnce(run, 'turn/failed');
    expect(run.ran.other).toBe(1);
    expect(await otherReply(run)).toBe(OTHER_TEXT);
    expect(run.log().filter((event) => event.type === 'assistant/message')).toHaveLength(1);
  });

  it('收回：收完的寫入只套一次，不再叫模型', async () => {
    const run = await assemble('native', TWO_CALLS_THEN_MORE('asker'));
    await run.pump.submit({ kind: 'message', text: '做' });
    await run.pump.whenIdle();
    expect(run.pump.awaitingInput).toBe(true);
    expect(run.pump.cancel()).toBe('withdrawn');
    await run.pump.whenIdle();
    await settle(50);

    await expectStoppedOnce(run, 'turn/end');
    expect(run.ran.other).toBe(1);
    expect(await otherReply(run)).toBe(OTHER_TEXT);
    expect(run.log().filter((event) => event.type === 'assistant/message')).toHaveLength(1);
  });
});

describe('native：判成卡死時套寫入拋錯', () => {
  it('這一輪以錯誤收尾，行程不會多一個未捕捉例外', async () => {
    const run = await assemble(
      'native',
      [
        {
          content: '動手。',
          toolCalls: [
            { name: 'other', args: {} },
            { name: 'stall', args: {} },
          ],
        },
        { content: '不該走到。' },
      ],
      { goto: true },
    );
    await runToEnd('native', run, () => true);

    const events = run.log();
    expect(events.at(-1)?.type).toBe('turn/failed');
    expect(run.log().filter((event) => event.type === 'assistant/message')).toHaveLength(1);
  });
});
