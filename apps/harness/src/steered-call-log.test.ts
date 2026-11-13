/**
 * 插話（`steer`）落在一次模型呼叫**進行中**時，日誌上那次呼叫有沒有記 `assistant/message`，而且整份日誌推得回對話。
 *
 * 續接一律從日誌推回對話（`restoreConversation`）；`history-source=log` 時每一次請求也從日誌推。被插話碰到的那次呼叫
 * 要是沒記回覆，推導就以 `reply-missing` 失敗。`steer.test.ts` 的插話都從模型呼叫剛回來、或工具本體裡送；這裡量的是
 * 呼叫還沒回來那一刻：插話先進 `next-step`，那次呼叫照常跑完、記回覆，下一步才領走插話。
 *
 * 另一半是按停止打斷進行中的模型呼叫：還沒吐字就停時日誌有 `model/start`、沒有回覆；吐到一半就停時記一則 `interrupted` 的半段。
 * 兩種都量日誌推得出什麼，以及下一輪的請求在 state／log × 同行程／換行程四種組合下是不是同一份。
 *
 * 兩個 loop 各量一次；零憑證、零外部連線。
 */

import { MemorySaver } from '@langchain/langgraph';
import { deriveConversation, withModelCallStep } from '@nexus/core';
import type { PluginEntry, SessionEvent } from '@nexus/core';
import { createMiddleware } from 'langchain';
import { afterEach, describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { restoreConversation } from './conversation-restore.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** 第 `at` 次模型呼叫**送出之前**呼叫 `onCall`：那一刻呼叫還沒回來，插話落在它進行中。 */
function beforeModelCall(at: number, onCall: () => void): PluginEntry {
  let calls = 0;
  return {
    plugin: {
      name: 'steer-during-call',
      apply(registry) {
        registry.middleware.use(
          withModelCallStep(
            async (request, next) => {
              calls += 1;
              if (calls === at) onCall();
              return next(request);
            },
            (wrapModelCall) =>
              createMiddleware({ name: 'steerDuringCall', wrapModelCall: wrapModelCall as never }),
          ),
        );
      },
    },
  };
}

/** 日誌上的骨架：每次呼叫與它的回覆、領走的插話（開頭那句話記在 `turn/start`，不在這裡）。 */
function skeleton(events: readonly SessionEvent[]): string[] {
  return events.flatMap((event) => {
    switch (event.type) {
      case 'model/start':
        return ['model/start'];
      case 'assistant/message':
        return ['assistant/message'];
      case 'user/message':
        return event.data.source.kind === 'user'
          ? [`user:${String(event.data.message.data.content)}`]
          : [];
      default:
        return [];
    }
  });
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block: { type?: string; text?: string }) => (block.type === 'text' ? block.text : ''))
    .join('');
}

describe.each(['langgraph', 'native'] as const)('插話落在模型呼叫進行中（%s）', (agentLoop) => {
  it('被插話碰到的那次呼叫照常記回覆，下一步領走插話，日誌推得出對話', async () => {
    // 插話從外掛裡送，那時 pump 已經建好；外掛先於 pump 建構，所以用容器接。
    const ref: { pump?: ThreadPump } = {};
    const model = new ScriptedChatModel({
      turns: [{ content: '第一次回覆' }, { content: '第二次回覆' }],
    });
    const built = await createNexusAgent({
      model,
      checkpointer: new MemorySaver(),
      summarization: false,
      observationPolicy: false,
      plugins: [
        beforeModelCall(1, () => {
          void ref.pump?.submit({ kind: 'message', text: '改用 X', id: 's1', steer: true });
        }),
      ],
      stepInbox: true,
      agentLoop,
    });
    const pump = new ThreadPump(
      built.agent as unknown as PumpAgent,
      `steered-call-${agentLoop}`,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      built.stepInbox,
    );
    ref.pump = pump;
    const detach = built.attachSession(pump.sessions);
    cleanups.push(async () => {
      pump.close();
      detach();
      await built.dispose();
    });

    await pump.submit({ kind: 'message', text: '開始', id: 'm1' });
    await pump.whenIdle();

    const events = pump.sessionLog.events;
    expect(skeleton(events)).toEqual([
      'model/start',
      'assistant/message',
      'user:改用 X',
      'model/start',
      'assistant/message',
    ]);
    expect(model.prompts).toHaveLength(2);
    expect(
      model.prompts[1]?.some(
        (message) => message.getType() === 'human' && message.text === '改用 X',
      ),
    ).toBe(true);

    const derived = deriveConversation(events);
    expect(derived.kind).toBe('replayed');
    const messages = derived.kind === 'replayed' ? derived.messages : [];
    expect(messages.map((message) => `${message.type}:${textOf(message.data.content)}`)).toEqual([
      'human:開始',
      'ai:第一次回覆',
      'human:改用 X',
      'ai:第二次回覆',
    ]);
  }, 20000);
});

interface StoppedRun {
  /** 第 1 輪停下之後、第 2 輪之前的日誌。 */
  readonly afterStop: readonly SessionEvent[];
  readonly secondPrompt: readonly string[];
  /** 第 2 輪結束後，那份日誌推出來的訊息類別。 */
  readonly derivedAfter: readonly string[];
}

interface Assembled {
  readonly model: ScriptedChatModel;
  readonly built: Awaited<ReturnType<typeof createNexusAgent>>;
  readonly pump: ThreadPump;
  readonly deltas: unknown[];
}

/** 一個行程：真組裝加一條 pump，`seed` 是上一個行程留下的日誌。 */
async function startProcess(
  agentLoop: 'langgraph' | 'native',
  source: 'state' | 'log',
  turns: readonly ScriptedTurn[],
  seed?: readonly SessionEvent[],
): Promise<Assembled> {
  const model = new ScriptedChatModel({ turns });
  const built = await createNexusAgent({
    model,
    checkpointer: new MemorySaver(),
    summarization: false,
    observationPolicy: false,
    plugins: [],
    agentLoop,
    historySource: source,
  });
  // 續接：同 serve，第一輪之前用 `restoreConversation` 把日誌推回 graph state，pump 拿同一份日誌當 seed（CLI 的 `--resume` 只做前一半）。
  if (seed !== undefined) await restoreConversation(built.agent, THREAD_ID, seed);
  const pump = new ThreadPump(built.agent as unknown as PumpAgent, THREAD_ID, undefined, seed);
  const detach = built.attachSession(pump.sessions);
  const deltas: unknown[] = [];
  const line = new AbortController();
  const draining = (async () => {
    for await (const frame of pump.subscribe(['messages'], line.signal)) {
      if ((frame.params.data as { event?: unknown }).event === 'content-block-delta') {
        deltas.push(frame);
      }
    }
  })();
  const close = async () => {
    pump.close();
    line.abort();
    await draining;
    detach();
    await built.dispose();
  };
  cleanups.push(close);
  return { model, built, pump, deltas };
}

const THREAD_ID = 'stopped-call';

const SLOW: ScriptedTurn = { content: '這一句回覆吐得很慢。'.repeat(20), tokenDelayMs: 20 };
const SECOND: ScriptedTurn = { content: '第二輪回覆' };

/**
 * 第 1 輪在模型呼叫進行中按停止（`delta` 為真就等第一段字吐出來再停），接著送第 2 輪；`source` 決定請求的歷史從哪來。
 * `crossProcess` 為真時，第 2 輪由**另一個行程**接手：全新的 agent 與 checkpointer，只拿日誌，模擬按停止後關掉程式、之後再續接。
 */
async function stopMidCall(
  agentLoop: 'langgraph' | 'native',
  source: 'state' | 'log',
  delta: boolean,
  crossProcess: boolean,
): Promise<StoppedRun> {
  const first = await startProcess(agentLoop, source, [SLOW, SECOND]);
  const submitted = first.pump.submit({ kind: 'message', text: '講長一點', id: 'm1' });
  const started = Date.now();
  const reached = () =>
    delta
      ? first.deltas.length > 0
      : first.pump.sessionLog.events.some((event) => event.type === 'model/start');
  while (!reached()) {
    if (Date.now() - started > 5000) throw new Error('等不到第 1 輪的 model/start 或第一段字');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  first.pump.cancel();
  await submitted;
  await first.pump.whenIdle();
  const afterStop = [...first.pump.sessionLog.events];

  // 落盤再讀回來是 JSON：換行程時只剩這個。
  const second = crossProcess
    ? await startProcess(
        agentLoop,
        source,
        [SECOND],
        JSON.parse(JSON.stringify(afterStop)) as SessionEvent[],
      )
    : first;
  await second.pump.submit({ kind: 'message', text: '再來', id: 'm2' });
  await second.pump.whenIdle();
  const derived = deriveConversation(second.pump.sessionLog.events);
  return {
    afterStop,
    secondPrompt: (second.model.prompts.at(-1) ?? []).map(
      (message) => `${message.getType()}:${message.text}`,
    ),
    derivedAfter:
      derived.kind === 'replayed' ? derived.messages.map((message) => message.type) : [],
  };
}

/** 同一個形狀在 state／log × 同行程／換行程 四種組合下各跑一次。 */
async function allWays(agentLoop: 'langgraph' | 'native', delta: boolean) {
  const runs = {
    stateSame: await stopMidCall(agentLoop, 'state', delta, false),
    logSame: await stopMidCall(agentLoop, 'log', delta, false),
    stateCross: await stopMidCall(agentLoop, 'state', delta, true),
    logCross: await stopMidCall(agentLoop, 'log', delta, true),
  };
  return { runs, all: Object.values(runs) };
}

describe.each(['langgraph', 'native'] as const)('按停止打斷進行中的模型呼叫（%s）', (agentLoop) => {
  it('還沒吐字就停：日誌有 model/start 沒有回覆，推得出來（少一則助手）；同行程與換行程續跑、state 與 log，下一輪的請求都相同', async () => {
    const { runs, all } = await allWays(agentLoop, false);
    const types = runs.logSame.afterStop.map((event) => event.type);
    expect(types).toContain('model/start');
    expect(types).not.toContain('assistant/message');
    const derived = deriveConversation(runs.logSame.afterStop);
    expect(derived.kind).toBe('replayed');
    expect(
      derived.kind === 'replayed' ? derived.messages.map((message) => message.type) : [],
    ).toEqual(['human']);
    expect(runs.logSame.secondPrompt.map((line) => line.split(':')[0])).toEqual([
      'system',
      'human',
      'human',
    ]);
    for (const run of all) {
      expect(run.secondPrompt).toEqual(runs.stateSame.secondPrompt);
      expect(run.derivedAfter).toEqual(['human', 'human', 'ai']);
    }
  }, 30000);

  it('吐到一半才停：半段回覆記成 interrupted 的 assistant/message，推得出來；同行程與換行程續跑、state 與 log，下一輪的請求都相同', async () => {
    const { runs, all } = await allWays(agentLoop, true);
    const kept = runs.logSame.afterStop.find((event) => event.type === 'assistant/message');
    expect((kept?.data as { interrupted?: boolean } | undefined)?.interrupted).toBe(true);
    const derived = deriveConversation(runs.logSame.afterStop);
    expect(derived.kind).toBe('replayed');
    expect(
      derived.kind === 'replayed' ? derived.messages.map((message) => message.type) : [],
    ).toEqual(['human', 'ai']);
    expect(runs.logSame.secondPrompt.map((line) => line.split(':')[0])).toEqual([
      'system',
      'human',
      'ai',
      'human',
    ]);
    for (const run of all) {
      expect(run.secondPrompt).toEqual(runs.stateSame.secondPrompt);
      expect(run.derivedAfter).toEqual(['human', 'ai', 'human', 'ai']);
    }
  }, 30000);
});
