/**
 * 評分與評語那一條線（[#278](https://github.com/DemianLi/nexus-agent/issues/278)、
 * [#382](https://github.com/DemianLi/nexus-agent/issues/382)）：真的組裝（core 的核准閘門、
 * `@nexus/plugin-feedback`）、真的 handler、真的 pump、真的折疊器。
 *
 * **指名用的一律是折疊器折出來的 `AiEntry.messageId`**——跟瀏覽器拿到的是同一個值。自己從日誌抄一個
 * id 去評的話，畫面那側拿到的 id 跟日誌對不上也照樣綠，而那正是這條線最容易壞的地方：它靠的是串流層給的
 * `message-start.id` 恰好就是日誌記下的那個（最後一段的上游絆索釘住它）。
 *
 * 兩個最容易假綠的地方，各配了對照：
 *
 * - 「查不到回 target-not-found」配著同一條 thread 上 root 那則評得到——不然「整條線都壞了」也長這樣。
 * - 「模型下一輪看不到備註」配著「那一份 prompt 裡有下一句話」——不然「根本沒抓到那一輪」也長這樣。
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';
import { loggedMessageId } from '@nexus/core';
import type { PluginEntry, SessionEvent, SessionLog } from '@nexus/core';
import { createFeedbackPlugin } from '@nexus/plugin-feedback';
import { createCommandExecutor } from '@nexus/plugin-commands';
import type { AiEntry, ConversationState, Event, WireClient } from '@nexus/wire';
import {
  appendDecision,
  createWireClient,
  emptyConversation,
  reduceAll,
  reduceConversation,
  uniformDecisions,
} from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { createCliAgent } from './cli.js';
import { TEST_BROWSER_AUTH, approvalAt, loopbackRequest, shippedPlugins } from './fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';
import type { WireHandler } from './wire-handler.js';

const shipped = await shippedPlugins();

const BASE_URL = 'http://feedback.test';

/** 一顆要核准的工具，外加一個子代理。 */
const fixturePlugin: PluginEntry = {
  plugin: {
    name: 'feedback-fixture',
    apply(registry) {
      registry.tools.register(
        tool(() => '危險的事做完了', {
          name: 'danger',
          description: '要核准。',
          schema: z.object({}),
        }),
      );
      registry.approvals.gate((exec, next) =>
        exec.name === 'danger' ? { kind: 'ask', reason: '危險' } : next(),
      );
      registry.subagents.register({ name: 'worker', description: '幹活的。' });
    },
  },
};

interface Line {
  readonly model: ScriptedChatModel;
  readonly handler: WireHandler;
  /** 一個分頁。`another()` 開第二個，連的是同一個 handler。 */
  readonly client: WireClient;
  another(): WireClient;
  /** 這條 thread 的 root 日誌。**開線之後才有**——pump 是 lazy 建的。 */
  log(): SessionLog;
}

const opened: WireHandler[] = [];

afterEach(async () => {
  for (const handler of opened.splice(0)) await handler.close();
});

async function line(turns: readonly ScriptedTurn[]): Promise<Line> {
  const model = new ScriptedChatModel({ turns });
  const built = await createNexusAgent({
    model,
    checkpointer: new MemorySaver(),
    plugins: [createFeedbackPlugin({ maxNoteBytes: 64 }), fixturePlugin],
  });
  let captured: SessionLog | undefined;
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    createAgent: async () => ({
      agent: built.agent as unknown as PumpAgent,
      commands: built.commands,
      ...(built.feedback !== undefined && { feedback: built.feedback }),
      dispose: built.dispose,
      attachSession: (sessions) => {
        captured = sessions.root;
        return built.attachSession(sessions);
      },
    }),
  });
  opened.push(handler);
  const connect = () =>
    createWireClient({
      baseUrl: BASE_URL,
      fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
    });
  return {
    model,
    handler,
    client: connect(),
    another: connect,
    log: () => {
      if (captured === undefined) throw new Error('這條 thread 還沒建起來');
      return captured;
    },
  };
}

/** 開著的一條對話：一條長期下行，加上折到目前為止的狀態。同 `hitl-wire.test.ts`。 */
interface Session {
  readonly events: AsyncGenerator<Event, void, undefined>;
  state: ConversationState;
}

async function open(wired: Line, threadId: string, text: string): Promise<Session> {
  const events = await wired.client.openEvents(threadId);
  await wired.client.runStart(threadId, text);
  return { events, state: emptyConversation() };
}

/** 抽到條件成立為止。**用 `next()` 不用 `for await`**，理由同 `hitl-wire.test.ts`。 */
async function until(session: Session, done: (state: ConversationState) => boolean): Promise<void> {
  while (!done(session.state)) {
    const next = await session.events.next();
    if (next.done === true) break;
    session.state = reduceConversation(session.state, next.value);
  }
}

/** 抽到 root 的下一顆 `lifecycle completed` 為止（含）。 */
async function rootCompleted(session: Session): Promise<void> {
  for (;;) {
    const next = await session.events.next();
    if (next.done === true) throw new Error('下行在 root 收尾之前就斷了');
    session.state = reduceConversation(session.state, next.value);
    const data = next.value.params.data as { event?: unknown; graph_name?: unknown } | null;
    if (
      next.value.method === 'lifecycle' &&
      next.value.params.namespace.length === 0 &&
      data?.graph_name === 'root' &&
      data.event === 'completed'
    )
      return;
  }
}

/** 模型講完幾輪話、而且閒下來了。不能只看 idle，理由同 `hitl-wire.test.ts` 的 `settled`。 */
function settled(turns: number) {
  return (state: ConversationState): boolean =>
    state.status === 'idle' &&
    state.entries.filter((entry) => entry.kind === 'ai' && !entry.streaming).length >= turns;
}

/** 折出來的 AI 條目，依歸屬。 */
function aiEntries(state: ConversationState, kind: 'root' | 'subagent') {
  return state.entries.flatMap((entry) =>
    entry.kind === 'ai' && entry.attribution.kind === kind && entry.text !== '' ? [entry] : [],
  );
}

function feedbackEvents(log: SessionLog): SessionEvent[] {
  return log.events.filter((event) => event.type.startsWith('feedback/'));
}

/** 那則回覆的訊息 id。沒有就是折疊器沒從 `message-start` 拿到，當場講。 */
function messageIdOf(entry: AiEntry | undefined): string {
  if (entry?.messageId === undefined)
    throw new Error(`這則沒有 messageId：${JSON.stringify(entry)}`);
  return entry.messageId;
}

/** root 日誌裡每一顆 `assistant/message` 記的訊息 id，照順序。 */
function loggedIds(log: SessionLog): (string | undefined)[] {
  return log.events.flatMap((event) =>
    event.type === 'assistant/message' ? [loggedMessageId(event.data.message)] : [],
  );
}

/** 重新整理之後的畫面：拿歷史、從空的折。 */
async function reloaded(client: WireClient, threadId: string): Promise<ConversationState> {
  const page = await client.threadHistory(threadId);
  if (page.kind !== 'ok') throw new Error(`拿不到歷史：${JSON.stringify(page)}`);
  return reduceAll(emptyConversation(), page.result.events);
}

describe('評一則回覆', () => {
  it('點踩、選分類、送出：日誌一顆 message-put，目標是日誌記的那則；模型下一輪看不到它', async () => {
    const wired = await line([{ content: '答。' }, { content: '第二句。' }]);
    const session = await open(wired, 't', '跑。');
    await until(session, settled(1));
    const messageId = messageIdOf(aiEntries(session.state, 'root')[0]);
    // 前提：畫面拿到的 id 就是日誌記的那個。
    expect(loggedIds(wired.log())).toEqual([messageId]);

    const put = await wired.client.feedbackPut('t', {
      messageId,
      rating: 'negative',
      category: 'task-result',
      note: '備註暗號QX7',
      ifVersion: null,
    });
    expect(put.kind).toBe('ok');
    if (put.kind !== 'ok' || !put.result.ok) throw new Error(`評不下去：${JSON.stringify(put)}`);
    expect(put.result.value).toMatchObject({
      messageId,
      rating: 'negative',
      category: 'task-result',
    });
    expect(feedbackEvents(wired.log()).map((event) => [event.type, event.data])).toEqual([
      ['feedback/message-put', { item: put.result.value }],
    ]);

    await wired.client.runStart('t', '再一句。');
    await until(session, settled(2));
    const prompt = JSON.stringify(wired.model.prompts.at(-1));
    // 對照：抓到的是下一輪那一份。
    expect(prompt).toContain('再一句。');
    expect(prompt).not.toContain('QX7');
  });

  it('停在核准點又續接：一輪只有一個收尾，放在續接後那則；停著時照樣評得到', async () => {
    const wired = await line([
      { content: '要動手了。', toolCalls: [{ name: 'danger', args: {} }] },
      { content: '做完了。' },
    ]);
    const session = await open(wired, 't', '做。');
    await until(session, (state) => state.status === 'awaiting-input');
    // 停下來時 root 在 `input.requested` 之後還會發一顆 `completed`。抽到它再按：先按的話那顆晚到的
    // `completed` 會把續接中的這一輪收掉——畫面上人要在那幾毫秒內按才到得了，測試一停就到得了。
    await rootCompleted(session);
    const paused = aiEntries(session.state, 'root')[0];
    // 停在核准點不是收尾。
    expect(paused?.turnTail).toBeUndefined();

    // 停在核准點時照樣評得到（#267 的 Q10）：線上指得到任何一則回覆，同 dsh。
    const early = await wired.client.feedbackPut('t', {
      messageId: messageIdOf(paused),
      rating: 'negative',
      ifVersion: null,
    });
    expect(early.kind === 'ok' && early.result.ok).toBe(true);

    const pending = approvalAt(session.state.pendings);
    session.state = appendDecision(session.state, pending.interruptId, 'approve');
    await wired.client.inputRespond('t', {
      namespace: [...pending.namespace],
      interrupt_id: pending.interruptId,
      response: uniformDecisions(pending, 'approve'),
    });
    await until(session, settled(2));
    const live = aiEntries(session.state, 'root');
    expect(live.map((entry) => [entry.text, entry.turnTail])).toEqual([
      ['要動手了。', undefined],
      ['做完了。', true],
    ]);

    // 重播出來的同一條 thread：收尾放在同一則上（#382 的 (a)：以前重播會在停下來之前那則也長一個）。
    const replayed = aiEntries(await reloaded(wired.client, 't'), 'root');
    expect(replayed.map((entry) => [entry.text, entry.turnTail, entry.messageId])).toEqual(
      live.map((entry) => [entry.text, entry.turnTail, entry.messageId]),
    );

    // 兩則各是自己的目標：續接後那則是新建，不用帶剛才那筆的版本。
    const later = await wired.client.feedbackPut('t', {
      messageId: messageIdOf(live[1]),
      rating: 'positive',
      ifVersion: null,
    });
    expect(later.kind === 'ok' && later.result.ok).toBe(true);
  });
});

describe('重新整理之後（list、重播的回覆）', () => {
  it('評過的分讀得回來、重播的回覆評得了，而且評到的是即時那則同一個目標', async () => {
    const wired = await line([{ content: '第一答。' }, { content: '第二答。' }]);
    const session = await open(wired, 't', '跑。');
    await until(session, settled(1));
    await wired.client.runStart('t', '再一句。');
    await until(session, settled(2));
    const [first, second] = aiEntries(session.state, 'root').map(messageIdOf);

    const put = await wired.client.feedbackPut('t', {
      messageId: first!,
      rating: 'negative',
      ifVersion: null,
    });
    if (put.kind !== 'ok' || !put.result.ok) throw new Error('評不下去');

    // 重新整理：畫面從歷史折，messageId 跟即時那兩則一樣，兩輪各一個收尾。
    const replayed = aiEntries(await reloaded(wired.client, 't'), 'root');
    expect(replayed.map((entry) => [entry.messageId, entry.turnTail])).toEqual([
      [first, true],
      [second, true],
    ]);
    // entry 的 key 不是訊息 id（同即時：key 是 run_id），評分不看它。
    expect(replayed.every((entry) => entry.id.startsWith('history-'))).toBe(true);

    expect(await wired.client.feedbackList('t')).toEqual({
      kind: 'ok',
      result: { ok: true, value: { items: [put.result.value] } },
    });

    // 重播的那則評得了，評到的就是即時那一筆（版本接得上）。
    const again = await wired.client.feedbackPut('t', {
      messageId: messageIdOf(replayed[0]),
      rating: 'positive',
      ifVersion: put.result.value.version,
    });
    expect(again.kind === 'ok' && again.result.ok).toBe(true);
    const fresh = await wired.client.feedbackPut('t', {
      messageId: messageIdOf(replayed[1]),
      rating: 'negative',
      ifVersion: null,
    });
    expect(fresh.kind === 'ok' && fresh.result.ok).toBe(true);
    const listed = await wired.client.feedbackList('t');
    if (listed.kind !== 'ok') throw new Error('讀不回來');
    expect(listed.result.value.items.map((item) => [item.messageId, item.rating])).toEqual([
      [first, 'positive'],
      [second, 'negative'],
    ]);
  });

  it('沒開過的 thread：list 是空的', async () => {
    const wired = await line([{ content: '答。' }]);
    expect(await wired.client.feedbackList('never-opened')).toEqual({
      kind: 'ok',
      result: { ok: true, value: { items: [] } },
    });
  });
});

describe('收回、不重記、兩個分頁', () => {
  it('再點一次已選的那顆是一顆 message-delete；同樣內容再送不多記；收回不存在的不記', async () => {
    const wired = await line([{ content: '答。' }]);
    const session = await open(wired, 't', '跑。');
    await until(session, settled(1));
    const messageId = messageIdOf(aiEntries(session.state, 'root')[0]);

    const first = await wired.client.feedbackPut('t', {
      messageId,
      rating: 'negative',
      ifVersion: null,
    });
    if (first.kind !== 'ok' || !first.result.ok) throw new Error('評不下去');
    const version = first.result.value.version;
    const same = await wired.client.feedbackPut('t', {
      messageId,
      rating: 'negative',
      ifVersion: version,
    });
    expect(same).toEqual(first);

    expect(await wired.client.feedbackDelete('t', { messageId, ifVersion: version })).toEqual({
      kind: 'ok',
      result: { ok: true, value: { absent: true } },
    });
    expect(await wired.client.feedbackDelete('t', { messageId, ifVersion: version })).toEqual({
      kind: 'ok',
      result: { ok: true, value: { absent: true } },
    });
    expect(feedbackEvents(wired.log()).map((event) => event.type)).toEqual([
      'feedback/message-put',
      'feedback/message-delete',
    ]);
  });

  it('兩個分頁先後改同一則：後到的拿到 version-conflict 與目前那筆', async () => {
    const wired = await line([{ content: '答。' }]);
    const session = await open(wired, 't', '跑。');
    await until(session, settled(1));
    const messageId = messageIdOf(aiEntries(session.state, 'root')[0]);
    const other = wired.another();

    const winner = await wired.client.feedbackPut('t', {
      messageId,
      rating: 'positive',
      ifVersion: null,
    });
    if (winner.kind !== 'ok' || !winner.result.ok) throw new Error('評不下去');
    expect(
      await other.feedbackPut('t', { messageId, rating: 'negative', ifVersion: null }),
    ).toEqual({
      kind: 'ok',
      result: { ok: false, error: { code: 'version-conflict', current: winner.result.value } },
    });
    expect(feedbackEvents(wired.log())).toHaveLength(1);
  });
});

describe('查不到的目標', () => {
  it('不存在的 id、人那一則、子代理的回覆、沒開過的 thread：target-not-found，日誌不動', async () => {
    const wired = await line([
      {
        content: '派出去。',
        toolCalls: [{ name: 'task', args: { description: '做', subagent_type: 'worker' } }],
      },
      { content: '子代理做完了。' },
      { content: '收工。' },
    ]);
    const session = await open(wired, 't', '跑。');
    await until(session, settled(3));
    const [sub] = aiEntries(session.state, 'subagent');
    expect(sub?.text).toBe('子代理做完了。');
    // 重播出來人那一則的 key（`history-<seq>`）：它也是 `turn/start` 的 seq，以前的輪判法會收下它。
    const human = (await reloaded(wired.client, 't')).entries.find(
      (entry) => entry.kind === 'human',
    );
    expect(human?.id).toMatch(/^history-\d+$/);

    for (const [threadId, messageId] of [
      ['t', 'no-such-message'],
      ['t', human!.id],
      ['t', messageIdOf(sub)],
      ['never-opened', 'no-such-message'],
    ] as const) {
      expect(
        await wired.client.feedbackPut(threadId, {
          messageId,
          rating: 'negative',
          ifVersion: null,
        }),
      ).toEqual({
        kind: 'ok',
        result: { ok: false, error: { code: 'target-not-found', messageId } },
      });
    }
    // 收回不存在的照 dsh 是成功、不記；沒開過的 thread 講 target-not-found。
    expect(
      await wired.client.feedbackDelete('never-opened', { messageId: 'x', ifVersion: 'x' }),
    ).toEqual({
      kind: 'ok',
      result: { ok: false, error: { code: 'target-not-found', messageId: 'x' } },
    });
    expect(feedbackEvents(wired.log())).toEqual([]);

    // 對照：同一條 thread 上 root 那則評得到。
    const root = aiEntries(session.state, 'root').at(-1)!;
    const put = await wired.client.feedbackPut('t', {
      messageId: messageIdOf(root),
      rating: 'negative',
      ifVersion: null,
    });
    expect(put.kind === 'ok' && put.result.ok).toBe(true);
  });
});

/**
 * 真的 `ChatOpenAI` 對著本機的 Chat Completions 端點，走 web 那條路（pump、v3 串流）。`chunkId` 為假時
 * chunk 不帶 `id`——供應商沒給 id 的那一種。
 */
async function fakeOpenAi(texts: readonly string[], chunkId: boolean) {
  let served = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      served += 1;
      const text = texts[served - 1] ?? '（腳本用完）';
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
        `data: ${JSON.stringify({
          ...(chunkId && { id: `chatcmpl-${served}` }),
          object: 'chat.completion.chunk',
          created: 0,
          model: 'fake',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(chunk({ role: 'assistant', content: text }));
      res.write(chunk({}, 'stop'));
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('上游絆索：串流 message-start 的 id 就是日誌 assistant/message 記的那個', () => {
  // 評分整條線靠這一條：畫面拿 `message-start.id` 當目標，server 拿日誌記的 id 驗。兩者由 LangGraph 的
  // `messages-v2.js` 與 `@nexus/core` 的 `model-calls.ts` 各自產生；升級任何一邊時這裡先紅。
  for (const chunkId of [true, false]) {
    it(`供應商${chunkId ? '給了' : '沒給'} id`, async () => {
      const upstream = await fakeOpenAi(['第一答。', '第二答。'], chunkId);
      const built = await createNexusAgent({
        model: new ChatOpenAI({
          model: 'fake',
          apiKey: 'sk-loopback',
          maxRetries: 0,
          configuration: { baseURL: upstream.baseURL },
        }),
        checkpointer: new MemorySaver(),
        plugins: [],
      });
      const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'tripwire');
      const detach = built.attachSession(pump.sessions);
      const frames: Event[] = [];
      const stop = new AbortController();
      const stream = pump.subscribe(['messages', 'lifecycle'], stop.signal);
      const draining = (async () => {
        for await (const frame of stream) frames.push(frame);
      })();
      try {
        await pump.submit({ kind: 'message', text: '一。' });
        await pump.submit({ kind: 'message', text: '二。' });
        const state = frames.reduce(reduceConversation, emptyConversation());
        const onScreen = aiEntries(state, 'root').map((entry) => entry.messageId);
        const logged = loggedIds(pump.sessions.root);
        expect(onScreen).toHaveLength(2);
        expect(new Set(onScreen).size).toBe(2);
        expect(onScreen).toEqual(logged);
        if (chunkId) expect(onScreen).toEqual(['chatcmpl-1', 'chatcmpl-2']);
        else expect(onScreen.every((id) => id?.startsWith('run-'))).toBe(true);
      } finally {
        stop.abort();
        await draining;
        detach();
        await built.dispose();
        await upstream.close();
      }
    });
  }
});

describe('/feedback 與零 plugin 設定', () => {
  /** 產品路徑上的組裝：出貨清單，一個 plugin 都不多掛。 */
  async function productLine() {
    const built = await createCliAgent({ live: false }, shipped);
    let captured: SessionLog | undefined;
    const handler = createWireHandler({
      auth: TEST_BROWSER_AUTH,
      createAgent: async () => ({
        agent: built.agent as unknown as PumpAgent,
        commands: built.commands,
        ...(built.feedback !== undefined && { feedback: built.feedback }),
        dispose: built.dispose,
        attachSession: (sessions) => {
          captured = sessions.root;
          return built.attachSession(sessions);
        },
      }),
    });
    opened.push(handler);
    const client = createWireClient({
      baseUrl: BASE_URL,
      fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
    });
    return { built, client, log: () => captured! };
  }

  it('serve：預設清單就掛著回饋；`/feedback 很慢` 記一顆 record，那段文字在日誌裡只出現一次', async () => {
    const { built, client, log } = await productLine();
    expect(built.feedback).toBeDefined();
    await client.openEvents('t');

    const ran = await client.slashRun('t', '/feedback 很慢');
    expect(ran).toMatchObject({ kind: 'success' });
    const events = log().events;
    expect(
      events.filter((event) => event.type === 'feedback/record').map((event) => event.data),
    ).toEqual([{ text: '很慢' }]);
    const run = events.find((event) => event.type === 'command/run');
    expect(run?.data).not.toHaveProperty('args');
    expect(JSON.stringify(events).split('很慢')).toHaveLength(2);

    // 空的一行回用法說明、不記。
    expect(await client.slashRun('t', '/feedback')).toMatchObject({ kind: 'error' });
    expect(log().events.filter((event) => event.type === 'feedback/record')).toHaveLength(1);
  });

  it('serve：回饋對話框走 feedback.record，任何時候都收', async () => {
    const { client, log } = await productLine();
    await client.openEvents('t');
    expect(await client.feedbackRecord('t', { text: '  對話框  ', category: 'other' })).toEqual({
      kind: 'ok',
      result: { ok: true, value: { recorded: true } },
    });
    expect(
      log()
        .events.filter((event) => event.type === 'feedback/record')
        .map((event) => event.data),
    ).toEqual([{ text: '對話框', category: 'other' }]);
  });

  it('CLI：預設清單的 `/feedback 很慢` 同樣記一顆 record、command/run 不帶原文', async () => {
    const built = await createCliAgent({ live: false }, shipped);
    const detach = built.attachSession(built.sessions);
    try {
      const executor = createCommandExecutor({
        commands: built.commands,
        sessionLog: built.sessionLog,
      });
      const execution = await executor.execute('/feedback 很慢', new AbortController().signal);
      expect(execution?.result.kind).toBe('success');
      const events = built.sessionLog.events;
      expect(
        events.filter((event) => event.type === 'feedback/record').map((event) => event.data),
      ).toEqual([{ text: '很慢' }]);
      expect(events.find((event) => event.type === 'command/run')?.data).not.toHaveProperty('args');
    } finally {
      detach();
      await built.dispose();
    }
  });
});
