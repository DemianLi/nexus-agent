import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';
import type { ConversationState, Event, WireClient } from '@nexus/wire';
import {
  appendDecision,
  createWireClient,
  emptyConversation,
  reduceConversation,
  uniformDecisions,
} from '@nexus/wire';
import { createDeepAgent, StateBackend } from 'deepagents';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  approvalAt,
  emptyCommandPoint,
  loopbackRequest,
  noSessions,
  TEST_BROWSER_AUTH,
} from './fixtures.js';
import { PrunedMemorySaver, RETAINED_CHECKPOINTS, RUN_DURABILITY } from './pruned-memory-saver.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

/**
 * 只留最新存檔點——[#1106](https://github.com/DemianLi/nexus-agent/issues/1106)。
 *
 * 三層：存檔器自己的行為（單元）、對著**真的**圖與**真的**線量它有沒有上限（含對照組）、
 * 以及核准的來回在只留一份之下照樣走得通。
 */

const BASE_URL = 'http://retention.test';

/* -------------------------------------------------------------------------- */
/* 存檔器自己                                                                   */
/* -------------------------------------------------------------------------- */

/** 一份夠用的存檔點：存檔器只讀 `id`，其餘照 `MemorySaver.put` 的要求補齊。 */
function checkpointOf(id: string): Checkpoint {
  return {
    v: 4,
    id,
    ts: new Date(0).toISOString(),
    channel_values: { messages: [id] },
    channel_versions: {},
    versions_seen: {},
  };
}

/** 取一條存檔點鏈的 id；鏈不存在就當場失敗，不用非空斷言。 */
function chainIds(saver: MemorySaver, thread: string, ns: string): string[] {
  const chain = saver.storage[thread]?.[ns];
  if (chain === undefined) throw new Error(`沒有 ${thread} / "${ns}" 這條鏈`);
  return Object.keys(chain);
}

const META: CheckpointMetadata = { source: 'loop', step: 0, parents: {} };

function at(thread: string, ns: string, parent?: string) {
  return {
    configurable: {
      thread_id: thread,
      checkpoint_ns: ns,
      ...(parent === undefined ? {} : { checkpoint_id: parent }),
    },
  };
}

/** `MemorySaver` 內部的 writes 鍵（`_generateKey`，沒有匯出）。測試自己寫一份，鍵形狀一變這裡就紅。 */
const writesKeyOf = (thread: string, ns: string, id: string): string =>
  JSON.stringify([thread, ns, id]);

describe('PrunedMemorySaver：單元', () => {
  it('預設只留最新那一份，而且 getTuple 給的就是它', async () => {
    const saver = new PrunedMemorySaver();
    let parent: string | undefined;
    for (const id of ['01', '02', '03', '04']) {
      await saver.put(at('t', '', parent), checkpointOf(id), META);
      parent = id;
    }
    expect(chainIds(saver, 't', '')).toEqual(['04']);
    const tuple = await saver.getTuple(at('t', ''));
    expect(tuple?.checkpoint.id).toBe('04');
    expect(RETAINED_CHECKPOINTS).toBe(1);
  });

  it('被修剪的存檔點，連同它的 writes 一起消失；最新那份的 writes 留著', async () => {
    const saver = new PrunedMemorySaver();
    await saver.put(at('t', ''), checkpointOf('01'), META);
    await saver.putWrites(at('t', '', '01'), [['messages', 'a']], 'task-a');
    await saver.put(at('t', '', '01'), checkpointOf('02'), META);
    await saver.putWrites(at('t', '', '02'), [['messages', 'b']], 'task-b');

    expect(saver.writes[writesKeyOf('t', '', '01')]).toBeUndefined();
    expect(saver.writes[writesKeyOf('t', '', '02')]).toBeDefined();
    const tuple = await saver.getTuple(at('t', ''));
    expect(tuple?.pendingWrites?.map(([task]) => task)).toEqual(['task-b']);
  });

  it('晚到的 writes（落在已被修剪的存檔點底下）在下一次 put 被掃掉，不會留成孤兒', async () => {
    const saver = new PrunedMemorySaver();
    await saver.put(at('t', ''), checkpointOf('01'), META);
    await saver.put(at('t', '', '01'), checkpointOf('02'), META);
    // 預設的 `async` 持久化下，01 的 putWrites 可以晚於 02 的 put 到達。
    await saver.putWrites(at('t', '', '01'), [['messages', 'late']], 'task-late');
    expect(saver.writes[writesKeyOf('t', '', '01')]).toBeDefined();
    await saver.put(at('t', '', '02'), checkpointOf('03'), META);
    expect(Object.keys(saver.writes)).toEqual([]);
  });

  it('各 (thread, ns) 各管各的：別條鏈與別的 thread 不受影響', async () => {
    const saver = new PrunedMemorySaver();
    await saver.put(at('t1', ''), checkpointOf('01'), META);
    await saver.put(at('t1', 'tools:x'), checkpointOf('02'), META);
    await saver.put(at('t2', ''), checkpointOf('03'), META);
    await saver.put(at('t1', '', '01'), checkpointOf('04'), META);

    expect(chainIds(saver, 't1', '')).toEqual(['04']);
    expect(chainIds(saver, 't1', 'tools:x')).toEqual(['02']);
    expect(chainIds(saver, 't2', '')).toEqual(['03']);
  });

  it('keep 可以調大：留最新的 N 份', async () => {
    const saver = new PrunedMemorySaver(2);
    let parent: string | undefined;
    for (const id of ['01', '02', '03', '04']) {
      await saver.put(at('t', '', parent), checkpointOf(id), META);
      parent = id;
    }
    expect(chainIds(saver, 't', '').sort()).toEqual(['03', '04']);
  });

  it.each([0, -1, 1.5, Number.NaN])('keep 不合法（%s）在建構時就拋', (keep) => {
    expect(() => new PrunedMemorySaver(keep)).toThrow(RangeError);
  });

  it('碰到 DeltaChannel 的 metadata 就不修剪：刪祖先會讓靠回放重建的通道安靜地壞掉', async () => {
    const saver = new PrunedMemorySaver();
    const delta = { ...META, counters_since_delta_snapshot: { messages: 1 } } as CheckpointMetadata;
    await saver.put(at('t', ''), checkpointOf('01'), delta);
    await saver.put(at('t', '', '01'), checkpointOf('02'), delta);
    expect(chainIds(saver, 't', '').sort()).toEqual(['01', '02']);
  });
});

/* -------------------------------------------------------------------------- */
/* 真的圖、真的線                                                                */
/* -------------------------------------------------------------------------- */

function spy(calls: string[], name: string) {
  return tool(
    () => {
      calls.push(name);
      return `${name} 跑過了`;
    },
    { name, description: `間諜 ${name}`, schema: z.object({}) },
  );
}

function buildAgent(
  saver: MemorySaver,
  turns: readonly ScriptedTurn[],
  interruptOn?: Record<string, { allowedDecisions: readonly string[] }>,
): { agent: PumpAgent; calls: string[] } {
  const calls: string[] = [];
  const agent = createDeepAgent({
    model: new ScriptedChatModel({ turns }),
    tools: [spy(calls, 'alpha')],
    backend: new StateBackend(),
    checkpointer: saver,
    ...(interruptOn === undefined ? {} : { interruptOn: interruptOn as never }),
  });
  return { agent: agent as unknown as PumpAgent, calls };
}

function connect(agent: PumpAgent) {
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    createAgent: async () => ({
      agent,
      attachSessions: noSessions,
      commands: emptyCommandPoint(),
      dispose: async () => undefined,
    }),
  });
  return {
    handler,
    client: createWireClient({
      baseUrl: BASE_URL,
      fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
    }),
  };
}

interface Session {
  readonly client: WireClient;
  readonly events: AsyncGenerator<Event, void, undefined>;
  state: ConversationState;
  close(): Promise<void>;
}

async function open(agent: PumpAgent, threadId: string): Promise<Session> {
  const { client, handler } = connect(agent);
  return {
    client,
    events: await client.openEvents(threadId),
    state: emptyConversation(),
    close: () => handler.close(),
  };
}

/** 抽到模型講完 `turns` 輪話、而且閒下來為止（刻意用 `next()`，不用會關線的 `break`）。 */
async function settle(session: Session, turns: number): Promise<void> {
  const done = (state: ConversationState): boolean =>
    state.status === 'idle' &&
    state.entries.filter((entry) => entry.kind === 'ai' && !entry.streaming).length >= turns;
  while (!done(session.state)) {
    const next = await session.events.next();
    if (next.done === true) break;
    session.state = reduceConversation(session.state, next.value);
  }
}

const TURNS = 12;
const CHATTY: readonly ScriptedTurn[] = Array.from({ length: TURNS }, (_, i) => ({
  content: `第 ${String(i + 1)} 輪的回覆。`,
}));

/** 跑 `TURNS` 輪，回傳存檔器裡每個 (thread, ns) 留了幾份。 */
async function checkpointsAfterTurns(saver: MemorySaver, threadId: string): Promise<number[]> {
  const { agent } = buildAgent(saver, CHATTY);
  const session = await open(agent, threadId);
  try {
    for (let turn = 1; turn <= TURNS; turn += 1) {
      await session.client.runStart(threadId, `第 ${String(turn)} 句`);
      await settle(session, turn);
    }
  } finally {
    await session.close();
  }
  return Object.values(saver.storage[threadId] ?? {}).map((chain) => Object.keys(chain).length);
}

describe('只留最新存檔點：對著真的圖與真的線', () => {
  it('跑 12 輪，每條鏈都只剩 1 份、writes 也沒有殘留', async () => {
    const saver = new PrunedMemorySaver();
    const counts = await checkpointsAfterTurns(saver, 'bounded');
    expect(counts.length).toBeGreaterThan(0);
    expect(counts.every((count) => count === RETAINED_CHECKPOINTS)).toBe(true);
    expect(Object.keys(saver.writes).length).toBeLessThanOrEqual(counts.length);
  });

  it('對照組：同一條路徑換回 MemorySaver，存檔點隨輪數成長（所以上面那條量得到修剪）', async () => {
    const counts = await checkpointsAfterTurns(new MemorySaver(), 'control');
    expect(Math.max(...counts)).toBeGreaterThanOrEqual(TURNS);
  });

  it('絆索：真的組裝裡 messages 不是 DeltaChannel——哪天是了，修剪就會安靜地弄壞歷史', async () => {
    const saver = new PrunedMemorySaver();
    const { agent } = buildAgent(saver, CHATTY);
    const session = await open(agent, 'no-delta');
    try {
      await session.client.runStart('no-delta', '你好');
      await settle(session, 1);
    } finally {
      await session.close();
    }
    const tuple = await saver.getTuple({ configurable: { thread_id: 'no-delta' } });
    expect(tuple).toBeDefined();
    expect(
      (tuple?.metadata as { counters_since_delta_snapshot?: unknown } | undefined)
        ?.counters_since_delta_snapshot,
    ).toBeUndefined();
    // 完整累加：最新那份存檔點自己就帶著整段對話，不靠祖先回放。
    const messages = tuple?.checkpoint.channel_values['messages'] as unknown[] | undefined;
    expect(Array.isArray(messages)).toBe(true);
    expect(messages!.length).toBeGreaterThanOrEqual(2);
  });

  it('產品路徑每輪只存約 1 份（durability: exit），而不帶它的直接呼叫每輪存很多份', async () => {
    class CountingSaver extends PrunedMemorySaver {
      puts = 0;
      override async put(...args: Parameters<PrunedMemorySaver['put']>) {
        this.puts += 1;
        return super.put(...args);
      }
    }
    // 產品路徑：經 thread-pump，12 輪。
    const wired = new CountingSaver();
    const { agent } = buildAgent(wired, CHATTY);
    const session = await open(agent, 'puts-wired');
    try {
      for (let turn = 1; turn <= TURNS; turn += 1) {
        await session.client.runStart('puts-wired', `第 ${String(turn)} 句`);
        await settle(session, turn);
      }
    } finally {
      await session.close();
    }
    expect(wired.puts).toBeLessThanOrEqual(TURNS * 2);

    // 對照：同一張圖、同一顆存檔器，直接呼叫而不帶 durability——量得到差別，這條才不是空話。
    const direct = new CountingSaver();
    const { agent: bare } = buildAgent(direct, CHATTY);
    await (bare as unknown as { invoke(input: unknown, config: unknown): Promise<unknown> }).invoke(
      { messages: [{ role: 'user', content: '你好' }] },
      { configurable: { thread_id: 'puts-direct' } },
    );
    expect(direct.puts).toBeGreaterThanOrEqual(3);
    expect(RUN_DURABILITY).toBe('exit');
  });
});

/* -------------------------------------------------------------------------- */
/* 核准的來回，在只留一份之下                                                      */
/* -------------------------------------------------------------------------- */

describe('核准的來回：只留 1 份存檔點仍然停得住、續得回', () => {
  const GATED = { alpha: { allowedDecisions: ['approve', 'reject'] as const } };
  const SCRIPT: readonly ScriptedTurn[] = [
    { content: '動手。', toolCalls: [{ name: 'alpha', args: {} }] },
    { content: '收工。' },
    { content: '第二輪動手。', toolCalls: [{ name: 'alpha', args: {} }] },
    { content: '第二輪收工。' },
  ];

  async function answer(session: Session, threadId: string, decision: string) {
    const pending = approvalAt(session.state.pendings);
    session.state = appendDecision(session.state, pending.interruptId, decision);
    await session.client.inputRespond(threadId, {
      namespace: [...pending.namespace],
      interrupt_id: pending.interruptId,
      response: uniformDecisions(pending, decision),
    });
  }

  async function untilPending(session: Session): Promise<void> {
    while (session.state.pendings.length === 0) {
      const next = await session.events.next();
      if (next.done === true) break;
      session.state = reduceConversation(session.state, next.value);
    }
  }

  it('核准：停在核准點、答了之後工具真的跑；下一輪再停、再核准，一樣走得通', async () => {
    const saver = new PrunedMemorySaver();
    const { agent, calls } = buildAgent(saver, SCRIPT, GATED);
    const session = await open(agent, 'approve');
    try {
      await session.client.runStart('approve', '做第一件');
      await untilPending(session);
      expect(calls).toEqual([]); // 停在核准點，工具還沒跑
      await answer(session, 'approve', 'approve');
      await settle(session, 2);
      expect(calls).toEqual(['alpha']);

      await session.client.runStart('approve', '做第二件');
      await untilPending(session);
      await answer(session, 'approve', 'approve');
      await settle(session, 4);
      expect(calls).toEqual(['alpha', 'alpha']);
    } finally {
      await session.close();
    }
    const counts = Object.values(saver.storage['approve'] ?? {}).map(
      (chain) => Object.keys(chain).length,
    );
    expect(counts.every((count) => count === RETAINED_CHECKPOINTS)).toBe(true);
  });

  it('拒絕：工具沒跑，而且之後的一輪照常', async () => {
    const saver = new PrunedMemorySaver();
    const { agent, calls } = buildAgent(saver, SCRIPT, GATED);
    const session = await open(agent, 'reject');
    try {
      await session.client.runStart('reject', '做第一件');
      await untilPending(session);
      await answer(session, 'reject', 'reject');
      await settle(session, 2);
      expect(calls).toEqual([]);

      await session.client.runStart('reject', '再來一次');
      await untilPending(session);
      await answer(session, 'reject', 'approve');
      await settle(session, 4);
      expect(calls).toEqual(['alpha']);
    } finally {
      await session.close();
    }
  });
});
