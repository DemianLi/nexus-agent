/**
 * 一輪失敗時，當場替沒配到結果的工具呼叫補錯誤結果（[#2029](https://github.com/DemianLi/nexus-agent/issues/2029)）。
 *
 * 真的 `createNexusAgent`＋真的 `ThreadPump`，掛上不變量配套入口。失敗用遞迴上限造：上限 4 剛好撞在模型那一步之後、
 * 工具那一步之前，日誌上有一則帶兩顆呼叫的 `assistant/message`，兩顆都還沒記 `tool/call`（量過：上限 3 撞在模型呼叫之前，5、6 撞在工具跑完之後）。
 *
 * 量的是：
 * 1. 日誌在 `turn/failed` 之前有兩顆配對的錯誤結果，句子與碼同續接的補結，不變量不報違規。
 * 2. 同一顆呼叫只補一次：同一個行程的下一輪、續接的兩條路（寫回補結、從日誌推歷史）、同一步的兄弟呼叫都量。
 * 3. 補寫也失敗：兩個錯都帶出來，原錯的分類照舊。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import {
  interruptedTurnClosers,
  replayConversation,
  SESSION_EVENT_MAX_DEPTH,
  TOOL_NOT_STARTED,
  TOOL_NOT_STARTED_TEXT,
} from '@nexus/core';
import type { InvariantError, PluginEntry, SessionEvent } from '@nexus/core';
import { createCoreInvariantPlugin } from '@nexus/core/invariant';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { turnFailureOf } from './live-model.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { composeAttachSessions } from './session-attach.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

const THREAD = 'step-failure';
/** 撞在第一次模型呼叫之後、工具那一步之前的遞迴上限（量過）。 */
const FAILS_BEFORE_TOOLS = 4;
/**
 * 撞在**第二次**模型呼叫之後、工具那一步之前的遞迴上限（量過）。下一輪不帶工具也要幾步，上限 4 連下一輪都跑不完，
 * 量「下一輪」的那條用這個：第一輪的工具跑完一次，第二次要的兩顆在開始前失敗。
 */
const FAILS_BEFORE_SECOND_TOOLS = 7;

const PINGS: PluginEntry = {
  plugin: {
    name: 'pings',
    apply(registry) {
      registry.tools.register(
        tool(() => 'pong', { name: 'ping', description: '一次。', schema: z.object({}) }),
      );
      registry.tools.register(
        tool(() => 'pang', { name: 'pang', description: '另一次。', schema: z.object({}) }),
      );
    },
  },
};

const TWO_CALLS: ScriptedTurn = {
  content: '',
  toolCalls: [
    { name: 'ping', args: {}, id: 'call-a' },
    { name: 'pang', args: {}, id: 'call-b' },
  ],
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function assemble(
  turns: readonly ScriptedTurn[],
  options: {
    readonly plugins?: readonly PluginEntry[];
    readonly recursionLimit?: number;
    readonly wrapAgent?: (agent: PumpAgent) => PumpAgent;
  } = {},
) {
  const violations: InvariantError[] = [];
  const model = new ScriptedChatModel({ turns });
  const built = await createNexusAgent({
    model,
    checkpointer: new MemorySaver(),
    plugins: [...(options.plugins ?? [PINGS]), createCoreInvariantPlugin()],
    recursionLimit: options.recursionLimit ?? FAILS_BEFORE_TOOLS,
    onInvariantViolation: (error) => violations.push(error),
  });
  const agent = built.agent as unknown as PumpAgent;
  const pump = new ThreadPump(options.wrapAgent?.(agent) ?? agent, THREAD);
  // 產品接線那一口：不變量要經它才掛得上（`built.attachSession` 只接參與者）。
  const attachment = composeAttachSessions(built)(pump.sessions);
  cleanups.push(async () => {
    await attachment.detach();
    await built.dispose();
  });
  return { model, pump, agent, violations };
}

const typesWithCall = (events: readonly SessionEvent[]): string[] =>
  events.map((event) =>
    event.type === 'tool/call' || event.type === 'tool/result'
      ? `${event.type}:${(event.data as { callId: string }).callId}`
      : event.type,
  );

const resultsOf = (events: readonly SessionEvent[], callId: string) =>
  events.filter(
    (event) => event.type === 'tool/result' && (event.data as { callId: string }).callId === callId,
  );

describe('一輪失敗時補上沒配到結果的呼叫（#2029）', () => {
  it('一步兩顆呼叫、工具還沒開始就失敗：turn/failed 之前有兩顆「還沒開始」的錯誤結果，不變量不報違規', async () => {
    const { pump, violations } = await assemble([TWO_CALLS, { content: '收尾。' }]);
    const failure = await pump
      .submit({ kind: 'message', text: '跑' })
      .catch((error: unknown) => error);
    await pump.whenIdle();
    expect((failure as Error).name).toBe('GraphRecursionError');

    const events = pump.sessions.root.events;
    const tail = typesWithCall(events).slice(-4);
    expect(tail).toEqual([
      'context/measure',
      'tool/result:call-a',
      'tool/result:call-b',
      'turn/failed',
    ]);
    for (const callId of ['call-a', 'call-b']) {
      const [result] = resultsOf(events, callId);
      expect(result?.data).toMatchObject({
        callId,
        isError: true,
        error: { name: 'ToolNotStartedError', code: TOOL_NOT_STARTED },
      });
    }
    expect(violations).toEqual([]);
  });

  it('同一個行程的下一輪：模型看到每顆呼叫恰好一則結果，是補的那一句（不是基座補的）', async () => {
    const first: ScriptedTurn = {
      content: '',
      toolCalls: [{ name: 'ping', args: {}, id: 'call-first' }],
    };
    const { model, pump } = await assemble([first, TWO_CALLS, { content: '好。' }], {
      recursionLimit: FAILS_BEFORE_SECOND_TOOLS,
    });
    await pump.submit({ kind: 'message', text: '跑' }).catch(() => undefined);
    await pump.whenIdle();
    await pump.submit({ kind: 'message', text: '再來' });
    await pump.whenIdle();

    const prompt = model.prompts.at(-1) ?? [];
    const answers = prompt.filter((message): message is ToolMessage =>
      ToolMessage.isInstance(message),
    );
    expect(answers.map((message) => [message.tool_call_id, message.text])).toEqual([
      ['call-first', 'pong'],
      ['call-a', TOOL_NOT_STARTED_TEXT],
      ['call-b', TOOL_NOT_STARTED_TEXT],
    ]);
  });

  it('續接的兩條路不再補一次：寫回的補結是空的，從日誌推回的歷史每顆呼叫恰好一則', async () => {
    const { pump } = await assemble([TWO_CALLS, { content: '收尾。' }]);
    await pump.submit({ kind: 'message', text: '跑' }).catch(() => undefined);
    await pump.whenIdle();

    const events = pump.sessions.root.events;
    expect(interruptedTurnClosers(events)).toEqual([]);
    const replay = replayConversation(events);
    expect(replay.kind).toBe('replayed');
    const answers =
      replay.kind === 'replayed'
        ? replay.messages.filter((message): message is ToolMessage =>
            ToolMessage.isInstance(message),
          )
        : [];
    expect(answers.map((message) => [message.tool_call_id, message.text])).toEqual([
      ['call-a', TOOL_NOT_STARTED_TEXT],
      ['call-b', TOOL_NOT_STARTED_TEXT],
    ]);
  });

  it('補寫也失敗：拋出的錯帶著兩個錯、cause 是原錯，turn/failed 的分類同原錯', async () => {
    const { pump } = await assemble([TWO_CALLS, { content: '收尾。' }], {
      wrapAgent: (agent) =>
        new Proxy(agent, {
          get(target, key, receiver) {
            if (key === 'updateState') {
              return () => Promise.reject(new Error('存檔點寫不進去'));
            }
            const value: unknown = Reflect.get(target, key, receiver);
            return typeof value === 'function'
              ? (value as (...args: unknown[]) => unknown).bind(target)
              : value;
          },
        }),
    });
    const failure = await pump
      .submit({ kind: 'message', text: '跑' })
      .catch((error: unknown) => error);
    await pump.whenIdle();

    expect(failure).toBeInstanceOf(AggregateError);
    const [original, recovery] = (failure as AggregateError).errors as Error[];
    expect(original?.name).toBe('GraphRecursionError');
    expect(recovery?.message).toBe('存檔點寫不進去');
    expect((failure as AggregateError).cause).toBe(original);

    const [failed] = pump.sessions.root.events.filter((event) => event.type === 'turn/failed');
    const data = failed?.data as { message: string; error?: { code: string } };
    expect(data.error?.code).toBe(turnFailureOf(original).error.code);
    expect(data.message).toContain('存檔點寫不進去');
  });

  it('補寫失敗包成的 AggregateError 沿 cause 認得出原錯：原錯是 429，分類照舊是 429 那一類', () => {
    // 上一條的原錯（遞迴上限）本來就分不出類，碼一樣不代表沿 cause 認得出來；這一條拿一個分得出類的原錯。
    const original = Object.assign(new Error('太多請求'), { status: 429 });
    const wrapped = new AggregateError(
      [original, new Error('存檔點寫不進去')],
      '這一輪失敗，沒配到結果的工具呼叫也補不進去',
      { cause: original },
    );
    const code = turnFailureOf(original).error.code;
    expect(code).not.toBe('UNKNOWN');
    expect(turnFailureOf(wrapped).error.code).toBe(code);
  });
});

/** 剛好超過日誌深度上限的值（同 `tool-result-rejected.test.ts`）：結果記不進日誌，這一步失敗。 */
function pastLogDepthCap(): unknown {
  let value: unknown = 'leaf';
  for (let level = 0; level < SESSION_EVENT_MAX_DEPTH; level++) {
    value = level % 2 ? { next: value } : [value];
  }
  return value;
}

describe('同一步的兄弟呼叫不會在補過之後再記一次結果（#2029）', () => {
  for (const [label, safe, order] of [
    ['獨佔：兄弟排在失敗那顆後面', false, ['deep_probe', 'slow']],
    ['可重疊：兄弟先開跑、失敗那顆在它跑的時候拋', true, ['slow', 'deep_probe']],
  ] as const) {
    it(label, async () => {
      let release: () => void = () => {};
      const plugin: PluginEntry = {
        plugin: {
          name: 'siblings',
          apply(registry) {
            registry.tools.register(
              tool(() => ['好了', pastLogDepthCap()] as [string, unknown], {
                name: 'deep_probe',
                description: '結果記不進日誌。',
                schema: z.object({}),
                responseFormat: 'content_and_artifact',
                metadata: { concurrencySafe: safe },
              }),
            );
            registry.tools.register(
              tool(
                async () => {
                  await new Promise<void>((resolve) => {
                    release = resolve;
                  });
                  return '慢的跑完了';
                },
                {
                  name: 'slow',
                  description: '慢。',
                  schema: z.object({}),
                  metadata: { concurrencySafe: safe },
                },
              ),
            );
          },
        },
      };
      const { pump } = await assemble(
        [
          {
            content: '',
            toolCalls: order.map((name) => ({ name, args: {}, id: `call-${name}` })),
          },
          { content: '收尾。' },
        ],
        { plugins: [plugin], recursionLimit: 100 },
      );
      await pump.submit({ kind: 'message', text: '跑' }).catch(() => undefined);
      await pump.whenIdle();
      release();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const events = pump.sessions.root.events;
      const failedAt = events.findIndex((event) => event.type === 'turn/failed');
      expect(failedAt).toBe(events.length - 1);
      for (const name of order) {
        expect(resultsOf(events, `call-${name}`)).toHaveLength(1);
      }
    });
  }
});
