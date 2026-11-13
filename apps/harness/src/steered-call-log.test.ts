/**
 * 插話（`steer`）落在一次模型呼叫**進行中**時，日誌上那次呼叫有沒有記 `assistant/message`，而且整份日誌推得回對話。
 *
 * 續接一律從日誌推回對話（`restoreConversation`）；`history-source=log` 時每一次請求也從日誌推。被插話碰到的那次呼叫
 * 要是沒記回覆，推出來的對話就少那一則助手：同一輪後面那次呼叫有回覆，`reply-missing` 擋不到。`steer.test.ts` 沒有一條插話
 * 落在模型呼叫進行中；這裡量的是呼叫還沒回來那一刻（`model/start` 已記、回覆還沒記）：插話先進 `next-step`，那次呼叫照常跑完、
 * 記回覆，下一步才領走插話。
 *
 * 另一半是按停止打斷進行中的模型呼叫：還沒吐字就停時日誌有 `model/start`、沒有回覆；吐到一半就停時記一則 `interrupted` 的半段。
 * 兩種都量日誌推得出什麼，以及下一輪的請求在五格下是不是同一份：state／log × 接著跑／丟掉記憶體狀態只留日誌重建，外加 log 重建
 * 而且不呼叫 `restoreConversation`（只有日誌推導湊得出歷史）。
 *
 * 兩個 loop 各量一次；零憑證、零外部連線。
 */

import { MemorySaver } from '@langchain/langgraph';
import { deriveConversation, shareStoredEvents } from '@nexus/core';
import type { SessionEvent } from '@nexus/core';
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

/** 5 秒內沒等到就丟錯，免得測試卡到逾時才報。 */
function within<T>(promise: Promise<T>, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等不到${what}`)), 5000);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** 訂下行的 `messages`：第一段字（`content-block-delta`）到時 `firstDelta` 解開；沒有字就一直不解開、也不 reject，要套 `within`。`draining` 在訂閱結束時落定，收尾先中止 `signal` 再等它。 */
function watchFirstDelta(pump: ThreadPump, signal: AbortSignal) {
  let reached!: () => void;
  const firstDelta = new Promise<void>((resolve) => (reached = resolve));
  const draining = (async () => {
    for await (const frame of pump.subscribe(['messages'], signal)) {
      if ((frame.params.data as { event?: unknown }).event === 'content-block-delta') reached();
    }
  })();
  return { firstDelta, draining };
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

/**
 * 第 1 次呼叫吐出第一段字之後（`model/start` 已記、回覆還沒記）插一句話，跑完回日誌與每次請求送出的對話；
 * `source` 決定請求的歷史從哪來。
 */
async function steerDuringCall(agentLoop: 'langgraph' | 'native', source: 'state' | 'log') {
  const model = new ScriptedChatModel({
    turns: [{ content: '第一次回覆的字吐得很慢。', tokenDelayMs: 20 }, { content: '第二次回覆' }],
  });
  const built = await createNexusAgent({
    model,
    checkpointer: new MemorySaver(),
    summarization: false,
    observationPolicy: false,
    plugins: [],
    stepInbox: true,
    agentLoop,
    historySource: source,
  });
  const pump = new ThreadPump(
    built.agent as unknown as PumpAgent,
    `steered-call-${agentLoop}-${source}`,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    built.stepInbox,
  );
  const detach = built.attachSession(pump.sessions);
  const line = new AbortController();
  const { firstDelta, draining } = watchFirstDelta(pump, line.signal);
  cleanups.push(async () => {
    pump.close();
    line.abort();
    await draining;
    detach();
    await built.dispose();
  });

  const running = pump.submit({ kind: 'message', text: '開始', id: 'm1' });
  await within(firstDelta, '第 1 次呼叫的第一段字');
  await pump.submit({ kind: 'message', text: '改用 X', id: 's1', steer: true });
  await running;
  await pump.whenIdle();
  return {
    events: pump.sessionLog.events,
    prompts: model.prompts.map((prompt) =>
      prompt.map((message) => `${message.getType()}:${message.text}`),
    ),
  };
}

describe.each(['langgraph', 'native'] as const)('插話落在模型呼叫進行中（%s）', (agentLoop) => {
  it('被插話碰到的那次呼叫照常記回覆，下一步領走插話，日誌推得出對話；state 與 log 兩邊送出的請求相同', async () => {
    const state = await steerDuringCall(agentLoop, 'state');
    const log = await steerDuringCall(agentLoop, 'log');
    const events = log.events;
    expect(skeleton(events)).toEqual([
      'model/start',
      'assistant/message',
      'user:改用 X',
      'model/start',
      'assistant/message',
    ]);
    // 插話確實落在第 1 次呼叫進行中：排進 `next-step` 的那一顆在第 1 顆 `model/start` 之後、第 1 則回覆之前。
    const firstStart = events.find((event) => event.type === 'model/start')?.seq;
    const firstReply = events.find((event) => event.type === 'assistant/message')?.seq;
    const queued = events.find(
      (event) =>
        event.type === 'inbox/spliced' &&
        event.data.target === 'next-step' &&
        event.data.removedCount === undefined,
    )?.seq;
    expect(firstStart).toBeDefined();
    expect(queued).toBeGreaterThan(firstStart as number);
    expect(queued).toBeLessThan(firstReply as number);
    expect(log.prompts).toHaveLength(2);
    expect(log.prompts[1]).toContain('human:改用 X');
    expect(log.prompts).toEqual(state.prompts);

    const derived = deriveConversation(events);
    expect(derived.kind).toBe('replayed');
    const messages = derived.kind === 'replayed' ? derived.messages : [];
    expect(messages.map((message) => `${message.type}:${textOf(message.data.content)}`)).toEqual([
      'human:開始',
      'ai:第一次回覆的字吐得很慢。',
      'human:改用 X',
      'ai:第二次回覆',
    ]);
  }, 30000);
});

type Resume = 'continue' | 'rebuild' | 'rebuild-without-restore';

interface StoppedRun {
  /** 第 1 輪停下之後、第 2 輪之前的日誌。 */
  readonly afterStop: readonly SessionEvent[];
  /** 日誌裡那段被切斷的半段回覆文字；還沒吐字就停時是 `undefined`。 */
  readonly partial: string | undefined;
  /** 第 2 輪送進模型的對話（半段回覆以 `<半段>` 代替，其餘逐字）。 */
  readonly secondPrompt: readonly string[];
  /** 第 2 輪結束後，那份日誌推出來的訊息（半段回覆同樣以 `<半段>` 代替）。 */
  readonly derivedAfter: readonly string[];
}

interface Assembled {
  readonly model: ScriptedChatModel;
  readonly built: Awaited<ReturnType<typeof createNexusAgent>>;
  readonly pump: ThreadPump;
  /** 第一段字到的時候解開。 */
  readonly firstDelta: Promise<void>;
}

/** 一套組裝：真組裝加一條 pump，`seed` 是前一套留下的日誌，`restore` 為真時照續接把它推回 agent。 */
async function startAssembly(
  agentLoop: 'langgraph' | 'native',
  source: 'state' | 'log',
  turns: readonly ScriptedTurn[],
  resume?: { readonly seed: readonly SessionEvent[]; readonly restore: boolean },
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
  // 續接照 CLI 的 `--resume` 與 serve：第一輪之前用 `restoreConversation` 把日誌推回 agent，根日誌拿同一份當 seed
  // （serve 經 `ThreadAgent.rootSeed` 交給 pump，CLI 交給組裝建的註冊表）。兩個入口在這之前都先 `resumeClosingInterruptedTurn`
  // 補收尾；這兩種停止形狀的日誌已經以 `turn/end` 收尾，那一步沒有東西可補（見下面對 `afterStop` 的斷言）。
  if (resume?.restore === true) await restoreConversation(built.agent, THREAD_ID, resume.seed);
  const pump = new ThreadPump(
    built.agent as unknown as PumpAgent,
    THREAD_ID,
    undefined,
    resume?.seed,
  );
  const detach = built.attachSession(pump.sessions);
  const line = new AbortController();
  const { firstDelta, draining } = watchFirstDelta(pump, line.signal);
  const close = async () => {
    pump.close();
    line.abort();
    await draining;
    detach();
    await built.dispose();
  };
  cleanups.push(close);
  return { model, built, pump, firstDelta };
}

const THREAD_ID = 'stopped-call';

const FULL_REPLY = '這一句回覆吐得很慢。'.repeat(20);
/** 腳本模型每個字（含第一個）都先等 `tokenDelayMs` 才吐：還沒吐字就停靠這個延遲，停止才一定搶在第一個字之前。 */
const SLOW: ScriptedTurn = { content: FULL_REPLY, tokenDelayMs: 20 };
const SECOND: ScriptedTurn = { content: '第二輪回覆' };

interface InterruptedData {
  readonly interrupted?: boolean;
  readonly message: { readonly data: { readonly content: unknown } };
}

/** 被切斷的半段回覆那一顆（`interrupted: true` 的 `assistant/message`）。 */
function interruptedReply(events: readonly SessionEvent[]): InterruptedData | undefined {
  for (const event of events) {
    if (event.type !== 'assistant/message') continue;
    const data = event.data as unknown as InterruptedData;
    if (data.interrupted === true) return data;
  }
  return undefined;
}

/**
 * 第 1 輪在模型呼叫進行中按停止（`delta` 為真就等第一段字吐出來再停），接著送第 2 輪；`source` 決定請求的歷史從哪來。
 * `resume` 不是 `continue` 時，第 2 輪由丟掉記憶體狀態、只留日誌重建的 agent 接手（全新的 agent 與 checkpointer，同一個 OS 行程），
 * 模擬按停止後關掉程式、之後再續接；`rebuild-without-restore` 連 `restoreConversation` 都不做，只有日誌推導湊得出歷史。
 *
 * 半段回覆吐到哪裡取決於計時，所以每次執行的半段長度不同：這裡只要求它非空、是完整回覆的開頭、第 2 輪送出的就是日誌裡
 * 那一段，之後把它換成 `<半段>` 再跨組比對。
 */
async function stopMidCall(
  agentLoop: 'langgraph' | 'native',
  source: 'state' | 'log',
  delta: boolean,
  resume: Resume,
): Promise<StoppedRun> {
  const first = await startAssembly(agentLoop, source, [SLOW, SECOND]);
  // 還沒吐字的形狀：日誌同步通知 `model/start` 時排一顆 microtask 去停。microtask 先於之後才到點的任何計時器回呼，
  // 而腳本模型每個字（含第一個）都先等 `tokenDelayMs` 的計時器才吐，所以停止一定先生效，與事件迴圈多忙無關。
  const unsubscribe = first.pump.sessionLog.subscribe((event) => {
    if (delta || event.type !== 'model/start') return;
    unsubscribe(); // 只停第 1 輪：`continue` 的第 2 輪用同一條 pump，它的 `model/start` 不能再觸發停止。
    queueMicrotask(() => first.pump.cancel());
  });
  cleanups.push(async () => unsubscribe());
  const submitted = first.pump.submit({ kind: 'message', text: '講長一點', id: 'm1' });
  if (delta) {
    await within(first.firstDelta, '第 1 輪的第一段字');
    first.pump.cancel();
  }
  await submitted;
  await first.pump.whenIdle();
  const afterStop = [...first.pump.sessionLog.events];

  // 續接不必補收尾：停下來的那一輪已經有 `turn/end`。被切斷的那次呼叫有一顆 `outcome: 'aborted'` 的 `model/end`（按停止記的，
  // 不是補結的 `'error'`）：帶 `outcome` 的不算模型正常回來，沒有回覆也不會以 `reply-missing` 拒推。
  expect(afterStop.at(-1)?.type).toBe('turn/end');
  const modelEnds = afterStop.filter((event) => event.type === 'model/end');
  expect(modelEnds).toHaveLength(1);
  expect(modelEnds[0]?.data).toMatchObject({ outcome: 'aborted' });

  const interrupted = interruptedReply(afterStop);
  const partialContent = interrupted?.message.data.content;
  const partial = interrupted === undefined ? undefined : textOf(partialContent);
  if (partial !== undefined) {
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.length).toBeLessThan(FULL_REPLY.length);
    expect(FULL_REPLY.startsWith(partial)).toBe(true);
  }
  const masked = (line: string) =>
    partial !== undefined && line.endsWith(`:${partial}`) ? line.replace(partial, '<半段>') : line;

  const second =
    resume === 'continue'
      ? first
      : await startAssembly(agentLoop, source, [SECOND], {
          // 落盤再讀回來是 JSON，讀方拿到的是深凍、標成可共用的那一份：重建時只剩這個。
          seed: shareStoredEvents(JSON.parse(JSON.stringify(afterStop)) as SessionEvent[]),
          restore: resume === 'rebuild',
        });
  await second.pump.submit({ kind: 'message', text: '再來', id: 'm2' });
  await second.pump.whenIdle();
  const derived = deriveConversation(second.pump.sessionLog.events);
  return {
    afterStop,
    partial,
    secondPrompt: (second.model.prompts.at(-1) ?? [])
      .map((message) => `${message.getType()}:${message.text}`)
      .map(masked),
    derivedAfter:
      derived.kind === 'replayed'
        ? derived.messages.map((message) =>
            masked(`${message.type}:${textOf(message.data.content)}`),
          )
        : [],
  };
}

/** 同一個形狀的每一格：state／log × 接著跑／只留日誌重建，外加 log 重建但不呼叫 `restoreConversation`。 */
async function allWays(agentLoop: 'langgraph' | 'native', delta: boolean) {
  const runs = {
    stateContinue: await stopMidCall(agentLoop, 'state', delta, 'continue'),
    logContinue: await stopMidCall(agentLoop, 'log', delta, 'continue'),
    stateRebuild: await stopMidCall(agentLoop, 'state', delta, 'rebuild'),
    logRebuild: await stopMidCall(agentLoop, 'log', delta, 'rebuild'),
    logRebuildWithoutRestore: await stopMidCall(agentLoop, 'log', delta, 'rebuild-without-restore'),
  };
  return { runs, all: Object.values(runs) };
}

describe.each(['langgraph', 'native'] as const)('按停止打斷進行中的模型呼叫（%s）', (agentLoop) => {
  it('還沒吐字就停：日誌有 model/start 沒有回覆，推得出來（少一則助手）；五格（接著跑／重建、state／log、log 不灌 state）下一輪的請求都相同', async () => {
    const { runs, all } = await allWays(agentLoop, false);
    const types = runs.logContinue.afterStop.map((event) => event.type);
    expect(types).toContain('model/start');
    expect(types).not.toContain('assistant/message');
    const derived = deriveConversation(runs.logContinue.afterStop);
    expect(derived.kind).toBe('replayed');
    expect(
      derived.kind === 'replayed' ? derived.messages.map((message) => message.type) : [],
    ).toEqual(['human']);
    expect(runs.logContinue.secondPrompt.map((line) => line.split(':')[0])).toEqual([
      'system',
      'human',
      'human',
    ]);
    for (const run of all) {
      expect(run.partial).toBeUndefined();
      expect(run.secondPrompt).toEqual(runs.stateContinue.secondPrompt);
      expect(run.derivedAfter).toEqual(['human:講長一點', 'human:再來', 'ai:第二輪回覆']);
    }
  }, 30000);

  it('吐到一半才停：半段回覆記成 interrupted 的 assistant/message，推得出來；五格（接著跑／重建、state／log、log 不灌 state）下一輪的請求都相同', async () => {
    const { runs, all } = await allWays(agentLoop, true);
    const derived = deriveConversation(runs.logContinue.afterStop);
    expect(derived.kind).toBe('replayed');
    expect(
      derived.kind === 'replayed' ? derived.messages.map((message) => message.type) : [],
    ).toEqual(['human', 'ai']);
    expect(runs.logContinue.secondPrompt.map((line) => line.split(':')[0])).toEqual([
      'system',
      'human',
      'ai',
      'human',
    ]);
    for (const run of all) {
      expect(run.partial).toBeDefined();
      expect(run.secondPrompt).toEqual(runs.stateContinue.secondPrompt);
      expect(run.derivedAfter).toEqual([
        'human:講長一點',
        'ai:<半段>',
        'human:再來',
        'ai:第二輪回覆',
      ]);
    }
  }, 30000);
});
