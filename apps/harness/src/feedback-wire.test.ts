/**
 * 評分與評語那一條線（[#278](https://github.com/DemianLi/nexus-agent/issues/278)）：真的組裝（core 的
 * 核准閘門、`@nexus/plugin-feedback`）、真的 handler、真的 pump、真的折疊器。
 *
 * **指名用的一律是折疊器折出來的 `AiEntry.id`**——跟瀏覽器拿到的是同一個值。自己拼一個 run id
 * 去評的話，pump 那張表的鍵跟畫面各算各的也照樣綠，而那正是這條線最容易壞的地方。
 *
 * 兩個最容易假綠的地方，各配了對照：
 *
 * - 「查不到回 target-not-found」配著同一條 thread 上 root 那則評得到——不然「整條線都壞了」也長這樣。
 * - 「模型下一輪看不到備註」配著「那一份 prompt 裡有下一句話」——不然「根本沒抓到那一輪」也長這樣。
 */

import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import type { NexusPlugin, SessionEvent, SessionLog } from '@nexus/core';
import { createFeedbackPlugin } from '@nexus/plugin-feedback';
import { createCommandExecutor } from '@nexus/plugin-commands';
import type { ConversationState, Event, WireClient } from '@nexus/wire';
import {
  appendDecision,
  appendHumanTurn,
  createWireClient,
  emptyConversation,
  reduceConversation,
  uniformDecisions,
} from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { DEFAULT_PLUGINS, createCliAgent } from './cli.js';
import { approvalAt, loopbackRequest } from './fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';
import type { WireHandler } from './wire-handler.js';

const BASE_URL = 'http://feedback.test';

/** 一顆要核准的工具，外加一個子代理。 */
const fixturePlugin: NexusPlugin = {
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
  return { events, state: appendHumanTurn(emptyConversation(), text) };
}

/** 抽到條件成立為止。**用 `next()` 不用 `for await`**，理由同 `hitl-wire.test.ts`。 */
async function until(session: Session, done: (state: ConversationState) => boolean): Promise<void> {
  while (!done(session.state)) {
    const next = await session.events.next();
    if (next.done === true) break;
    session.state = reduceConversation(session.state, next.value);
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

/** 起頭的那幾顆 `turn/start`（不是 `resume` 的）的 `seq`，照順序。 */
function originTurns(log: SessionLog): number[] {
  return log.events.flatMap((event) =>
    event.type === 'turn/start' && event.data.kind !== 'resume' ? [event.seq] : [],
  );
}

describe('評一輪', () => {
  it('點踩、選分類、送出：日誌一顆 message-put，turn 是起頭那顆；模型下一輪看不到它', async () => {
    const wired = await line([{ content: '答。' }, { content: '第二句。' }]);
    const session = await open(wired, 't', '跑。');
    await until(session, settled(1));
    const [entry] = aiEntries(session.state, 'root');

    const put = await wired.client.feedbackPut('t', {
      runId: entry!.id,
      rating: 'negative',
      category: 'task-result',
      note: '備註暗號QX7',
      ifVersion: null,
    });
    expect(put.kind).toBe('ok');
    if (put.kind !== 'ok' || !put.result.ok) throw new Error(`評不下去：${JSON.stringify(put)}`);
    const [origin] = originTurns(wired.log());
    expect(put.result.value).toMatchObject({
      turn: origin,
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

  it('停在核准點又續接：跑著也評得到，續接後那則評到的仍是起頭那顆，不是 resume', async () => {
    const wired = await line([
      { content: '要動手了。', toolCalls: [{ name: 'danger', args: {} }] },
      { content: '做完了。' },
    ]);
    const session = await open(wired, 't', '做。');
    await until(session, (state) => state.status === 'awaiting-input');
    const [paused] = aiEntries(session.state, 'root');
    const [origin] = originTurns(wired.log());

    // 停在核准點時照樣評得到（#267 的 Q10）。
    const early = await wired.client.feedbackPut('t', {
      runId: paused!.id,
      rating: 'negative',
      ifVersion: null,
    });
    if (early.kind !== 'ok' || !early.result.ok)
      throw new Error(`評不下去：${JSON.stringify(early)}`);
    expect(early.result.value.turn).toBe(origin);

    const pending = approvalAt(session.state.pendings);
    session.state = appendDecision(session.state, pending.interruptId, 'approve');
    await wired.client.inputRespond('t', {
      namespace: [...pending.namespace],
      interrupt_id: pending.interruptId,
      response: uniformDecisions(pending, 'approve'),
    });
    await until(session, settled(2));
    const resumed = aiEntries(session.state, 'root').at(-1)!;
    expect(resumed.text).toBe('做完了。');

    const resumeSeq = wired
      .log()
      .events.find((event) => event.type === 'turn/start' && event.data.kind === 'resume')?.seq;
    expect(resumeSeq).toBeDefined();
    // 兩則指的是同一輪，所以要帶著剛才那筆的版本。
    const later = await wired.client.feedbackPut('t', {
      runId: resumed.id,
      rating: 'positive',
      ifVersion: early.result.value.version,
    });
    if (later.kind !== 'ok' || !later.result.ok)
      throw new Error(`評不下去：${JSON.stringify(later)}`);
    expect(later.result.value.turn).toBe(origin);
    expect(later.result.value.turn).not.toBe(resumeSeq);
  });
});

describe('收回、不重記、兩個分頁', () => {
  it('再點一次已選的那顆是一顆 message-delete；同樣內容再送不多記；收回不存在的不記', async () => {
    const wired = await line([{ content: '答。' }]);
    const session = await open(wired, 't', '跑。');
    await until(session, settled(1));
    const runId = aiEntries(session.state, 'root')[0]!.id;

    const first = await wired.client.feedbackPut('t', {
      runId,
      rating: 'negative',
      ifVersion: null,
    });
    if (first.kind !== 'ok' || !first.result.ok) throw new Error('評不下去');
    const version = first.result.value.version;
    const same = await wired.client.feedbackPut('t', {
      runId,
      rating: 'negative',
      ifVersion: version,
    });
    expect(same).toEqual(first);

    expect(await wired.client.feedbackDelete('t', { runId, ifVersion: version })).toEqual({
      kind: 'ok',
      result: { ok: true, value: { absent: true } },
    });
    expect(await wired.client.feedbackDelete('t', { runId, ifVersion: version })).toEqual({
      kind: 'ok',
      result: { ok: true, value: { absent: true } },
    });
    expect(feedbackEvents(wired.log()).map((event) => event.type)).toEqual([
      'feedback/message-put',
      'feedback/message-delete',
    ]);
  });

  it('兩個分頁先後改同一輪：後到的拿到 version-conflict 與目前那筆', async () => {
    const wired = await line([{ content: '答。' }]);
    const session = await open(wired, 't', '跑。');
    await until(session, settled(1));
    const runId = aiEntries(session.state, 'root')[0]!.id;
    const other = wired.another();

    const winner = await wired.client.feedbackPut('t', {
      runId,
      rating: 'positive',
      ifVersion: null,
    });
    if (winner.kind !== 'ok' || !winner.result.ok) throw new Error('評不下去');
    expect(await other.feedbackPut('t', { runId, rating: 'negative', ifVersion: null })).toEqual({
      kind: 'ok',
      result: { ok: false, error: { code: 'version-conflict', current: winner.result.value } },
    });
    expect(feedbackEvents(wired.log())).toHaveLength(1);
  });
});

describe('查不到的目標', () => {
  it('不存在的 run id、子代理的回覆、沒開過的 thread：target-not-found，日誌不動', async () => {
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

    for (const [threadId, runId] of [
      ['t', 'no-such-run'],
      ['t', sub!.id],
      ['never-opened', 'no-such-run'],
    ] as const) {
      expect(
        await wired.client.feedbackPut(threadId, { runId, rating: 'negative', ifVersion: null }),
      ).toEqual({
        kind: 'ok',
        result: { ok: false, error: { code: 'target-not-found', runId } },
      });
      expect(await wired.client.feedbackDelete(threadId, { runId, ifVersion: 'x' })).toEqual({
        kind: 'ok',
        result: { ok: false, error: { code: 'target-not-found', runId } },
      });
    }
    expect(feedbackEvents(wired.log())).toEqual([]);

    // 對照：同一條 thread 上 root 那則評得到。
    const root = aiEntries(session.state, 'root').at(-1)!;
    const put = await wired.client.feedbackPut('t', {
      runId: root.id,
      rating: 'negative',
      ifVersion: null,
    });
    expect(put.kind === 'ok' && put.result.ok).toBe(true);
  });
});

describe('/feedback 與零 plugin 設定', () => {
  /** 產品路徑上的組裝：`DEFAULT_PLUGINS`，一個 plugin 都不多掛。 */
  async function productLine() {
    const built = await createCliAgent({ live: false }, DEFAULT_PLUGINS);
    let captured: SessionLog | undefined;
    const handler = createWireHandler({
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
    const built = await createCliAgent({ live: false }, DEFAULT_PLUGINS);
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
