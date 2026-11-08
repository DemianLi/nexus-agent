/**
 * **等人服務接上 pump 與線**（[#2358](https://github.com/DemianLi/nexus-agent/issues/2358)）。
 *
 * 一顆測試用的提問工具：讀得到等人服務（`humanInputOf`）就 await 它，讀不到就呼叫 LangGraph 的 `interrupt()`。同一份檔在
 * `vitest.config.ts`（`langgraph`）與 `vitest.native.config.ts`（`native`）下各跑一次，斷言兩個 loop 共用；只有 native 才有的
 * （掛著的呼叫被收掉、本體只進一次）照 {@link NATIVE} 分開寫。
 *
 * 量的是：掛起與答覆、`no_such_interrupt`、一批兩顆分兩次答、停在中斷上按停止、接回之後那一段按停止與逾時、閒置驅逐、
 * 收線與重開。
 *
 * 突變（量過，見 PR 內文）：
 * - 拿掉 pump `#withdraw` 收掉掛著的 run：「停在中斷上按停止」那條紅；
 * - 拿掉 pump `close()` 收掉掛著的 run：「收線與重開」那條紅；
 * - 拿掉 native 接回時換上那一段的中止訊號：「接回之後那一段」的兩條紅；
 * - 拿掉閒置判定的「沒有掛著的中斷」：閒置驅逐那條紅。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { interrupt, MemorySaver } from '@langchain/langgraph';
import {
  attachSessionPersistence,
  CONCURRENCY_SAFE_METADATA_KEY,
  humanInputOf,
  isHumanInputWithdrawn,
  turnCancelSignalOf,
} from '@nexus/core';
import type { PluginEntry, SessionEvent, SessionRegistry } from '@nexus/core';
import { createWireClient, emptyConversation, reduceConversation } from '@nexus/wire';
import type { ConversationState, Event, WireClient } from '@nexus/wire';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { emptyCommandPoint, loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import { createJsonlSessionStore } from './jsonl-session-store.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { composeAttachSessions } from './session-attach.js';
import type { PumpAgent } from './thread-pump.js';
import type { TurnClock, TurnTimers } from './turn-clock.js';
import { createWireHandler } from './wire-handler.js';
import type { IdleSweepingWireHandler } from './wire-handler.js';

/** 這一輪跑的是哪個 loop：`vitest.native.config.ts` 帶這個變數，組裝沒指定 loop 時一律當 native。 */
const NATIVE = process.env['NEXUS_TEST_AGENT_LOOP'] === 'native';

const ASK = 'ask_probe';
const BASE_URL = 'http://human-input.test';
const TIMEOUT_MS = 1_000;
const GRACE_MS = 50;

/** 提問工具的紀錄。 */
interface Probe {
  /** 本體進來幾次：native 接著跑，只進一次；langgraph 接回時從頭重跑，再進一次。 */
  entered: number;
  readonly answers: unknown[];
  /** 等的時候被收回幾次（`HumanInputWithdrawn`）。只有 native 會發生：langgraph 的中斷當場收掉那次呼叫。 */
  withdrawn: number;
  /** 拿到答覆之後、回結果之前：給了就等它。 */
  afterAnswer?: (config: unknown) => Promise<void>;
}

function newProbe(): Probe {
  return { entered: 0, answers: [], withdrawn: 0 };
}

function askPlugin(probe: Probe): PluginEntry {
  return {
    plugin: {
      name: 'ask-probe',
      apply(registry) {
        registry.tools.register(
          tool(
            async ({ q }, config) => {
              probe.entered += 1;
              // 問答的形狀（`kind: 'question'`），線上的折疊器認得它，不必另造一種卡。
              const question = { kind: 'question', questions: [{ id: q, question: q }] };
              const service = humanInputOf(config);
              let answer: unknown;
              try {
                answer = service === undefined ? interrupt(question) : await service.ask(question);
              } catch (error) {
                if (isHumanInputWithdrawn(error)) probe.withdrawn += 1;
                throw error;
              }
              probe.answers.push(answer);
              await probe.afterAnswer?.(config);
              return `答覆：${JSON.stringify(answer)}`;
            },
            {
              name: ASK,
              description: '問人一個問題。',
              schema: z.object({ q: z.string() }),
              // 同一步兩顆可以一起問（同 `pending-replay.test.ts` 的兩顆核准）。
              metadata: { [CONCURRENCY_SAFE_METADATA_KEY]: true },
            },
          ),
        );
      },
    },
  };
}

/** 一輪問一題，答完再講一句。 */
const ONE_QUESTION: readonly ScriptedTurn[] = [
  { content: '', toolCalls: [{ id: 'q1', name: ASK, args: { q: '哪一個' } }] },
  { content: '收到' },
];

/** 一輪同時問兩題。 */
const TWO_QUESTIONS: readonly ScriptedTurn[] = [
  {
    content: '',
    toolCalls: [
      { id: 'q1', name: ASK, args: { q: '第一題' } },
      { id: 'q2', name: ASK, args: { q: '第二題' } },
    ],
  },
  { content: '兩題都收到' },
];

/** 手動計時器：測試決定一輪的時鐘什麼時候到點。 */
class ManualTimers implements TurnTimers {
  readonly #pending = new Map<number, { readonly callback: () => void; readonly ms: number }>();
  #next = 0;
  readonly set = (callback: () => void, ms: number): unknown => {
    this.#next += 1;
    this.#pending.set(this.#next, { callback, ms });
    return this.#next;
  };
  readonly clear = (handle: unknown): void => {
    this.#pending.delete(handle as number);
  };
  delays(): number[] {
    return [...this.#pending.values()].map((entry) => entry.ms);
  }
  fire(ms: number): void {
    const found = [...this.#pending].find(([, entry]) => entry.ms === ms);
    if (found === undefined) {
      throw new Error(`沒有排 ${String(ms)} 毫秒的計時器（還掛著：${this.delays().join('、')}）`);
    }
    this.#pending.delete(found[0]);
    found[1].callback();
  }
}

let dir: string;
const opened: IdleSweepingWireHandler[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-human-input-'));
});
afterEach(async () => {
  for (const handler of opened.splice(0)) await handler.close();
  await rm(dir, { recursive: true, force: true });
});

interface Session {
  readonly client: WireClient;
  events: AsyncGenerator<Event, void, undefined>;
  readonly frames: Event[];
  readonly handler: IdleSweepingWireHandler;
  readonly sessions: () => SessionRegistry;
  readonly agent: PumpAgent;
  state: ConversationState;
  /** 斷掉下行並等 server 端的訂閱放掉（同 `idle-eviction.fixture.ts` 的 `openLine`）。 */
  readonly hangUp: () => Promise<void>;
}

interface OpenOptions {
  readonly turnClock?: TurnClock;
  readonly idleEvictMs?: number;
  /** 不開第一句（重開之後接舊 thread 用）。 */
  readonly silent?: boolean;
}

async function open(
  threadId: string,
  turns: readonly ScriptedTurn[],
  probe: Probe,
  options: OpenOptions = {},
): Promise<Session> {
  const store = createJsonlSessionStore({ rootDir: join(dir, 'logs') });
  const built = await createNexusAgent({
    model: new ScriptedChatModel({ turns }),
    checkpointer: new MemorySaver(),
    plugins: [askPlugin(probe)],
  });
  const agent = built.agent as unknown as PumpAgent;
  let registry: SessionRegistry | undefined;
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    ...(options.turnClock !== undefined && { turnClock: options.turnClock }),
    ...(options.idleEvictMs !== undefined && {
      idleEvictMs: options.idleEvictMs,
      idleEvictPollMs: 3_600_000,
    }),
    createAgent: async () => ({
      agent,
      commands: emptyCommandPoint(),
      projections: built.projections,
      dispose: () => built.dispose(),
      attachSessions: composeAttachSessions(built),
      attachPersistence: (sessions) => {
        registry = sessions;
        return attachSessionPersistence(sessions, store);
      },
    }),
  });
  opened.push(handler);
  const client = createWireClient({
    baseUrl: BASE_URL,
    fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
  });
  const line = new AbortController();
  const events = await client.openEvents(threadId, { signal: line.signal });
  if (options.silent !== true) await client.runStart(threadId, '問我');
  return {
    client,
    events,
    frames: [],
    handler,
    agent,
    sessions: () => {
      if (registry === undefined) throw new Error('日誌還沒接上');
      return registry;
    },
    state: emptyConversation(),
    hangUp: async () => {
      line.abort();
      try {
        while ((await events.next()).done !== true);
      } catch {
        // 中止就是這樣結束的。
      }
    },
  };
}

async function until(session: Session, done: (session: Session) => boolean): Promise<void> {
  while (!done(session)) {
    const next = await session.events.next();
    if (next.done === true) break;
    session.frames.push(next.value);
    session.state = reduceConversation(session.state, next.value);
  }
}

const awaiting =
  (count = 1) =>
  (session: Session): boolean =>
    session.state.status === 'awaiting-input' && session.state.pendings.length === count;

/** 這一輪收完了：模型講完 `turns` 輪話。 */
const settled =
  (turns: number) =>
  (session: Session): boolean =>
    session.state.status === 'idle' &&
    session.state.entries.filter((entry) => entry.kind === 'ai' && !entry.streaming).length >=
      turns;

/** 停下來了：停止或逾時收掉的那一輪，線上是 `stopped`。 */
const stopped = (session: Session): boolean =>
  session.state.status === 'stopped' && session.state.pendings.length === 0;

function pendingOf(session: Session, q?: string) {
  const found = session.state.pendings.find(
    (pending) =>
      q === undefined ||
      (pending.kind === 'question' && (pending.questions[0] as { id?: unknown })?.id === q),
  );
  if (found === undefined) throw new Error(`沒有掛著的提問${q === undefined ? '' : `「${q}」`}`);
  return found;
}

async function answer(session: Session, threadId: string, value: unknown, q?: string) {
  const pending = pendingOf(session, q);
  return session.client.inputRespond(threadId, {
    namespace: [...pending.namespace],
    interrupt_id: pending.interruptId,
    response: value,
  });
}

/** root 日誌的事件，只留 `types` 這幾種，照 seq 排。 */
function rootEvents(session: Session, types?: readonly string[]): SessionEvent[] {
  const root = session
    .sessions()
    .list()
    .find((each) => each.address.kind === 'root');
  if (root === undefined) throw new Error('沒有 root 日誌');
  return root.log.events.filter((event) => types === undefined || types.includes(event.type));
}

/**
 * 等 root 日誌寫到第 `count` 顆 `type`。pump 收一輪的尾巴（`turn/end`、清掉這一輪的時鐘、放掉這一輪）在最後一顆 frame 之後才做；
 * 那之前按的停止落在已經跑完的那一輪上，照 pump 的規則作廢。
 */
async function untilLogged(session: Session, type: string, count: number): Promise<void> {
  for (let i = 0; i < 1_000 && rootEvents(session, [type]).length < count; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await drain();
}

/** 讓掛著的 microtask 與 `setImmediate` 都跑完：收掉的 run 若還會寫東西，這段時間裡就會寫。 */
async function drain(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** 一直等到這一輪的中止訊號舉起來；沒舉就一直等（測試會逾時，那就是紅）。 */
function untilAborted(config: unknown): Promise<void> {
  const signal = turnCancelSignalOf(config);
  return new Promise<void>((resolve) => {
    if (signal === undefined) return;
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

const TURN_SHAPE = ['turn/start', 'tool/call', 'interrupt/raised', 'tool/result', 'turn/end'];

describe('掛起與答覆', () => {
  it('問一題：input.requested 帶問題，答了接著跑完；日誌是兩輪，接回那一輪同一個 callId 再記一對', async () => {
    const probe = newProbe();
    const session = await open('h1', ONE_QUESTION, probe);
    await until(session, awaiting());
    expect(pendingOf(session)).toMatchObject({
      kind: 'question',
      questions: [{ id: '哪一個', question: '哪一個' }],
    });

    expect(await answer(session, 'h1', { pick: 'A' })).toMatchObject({ type: 'success' });
    await until(session, settled(2));

    expect(probe.answers).toEqual([{ pick: 'A' }]);
    // native 從等的那一行接著跑；langgraph 接回時把本體從頭再跑一次。
    expect(probe.entered).toBe(NATIVE ? 1 : 2);
    const events = rootEvents(session, TURN_SHAPE);
    expect(events.map((event) => event.type)).toEqual([
      'turn/start',
      'tool/call',
      'interrupt/raised',
      'turn/end',
      'turn/start',
      'tool/call',
      'tool/result',
      'turn/end',
    ]);
    expect(events[4]?.data).toMatchObject({ kind: 'resume' });
    // 結果跟呼叫落在同一輪（`session-log.ts` 的 `tool/call`：配對取最後那一顆）。
    expect(events[5]?.data).toMatchObject({ callId: 'q1', name: ASK });
    expect(events[6]?.data).toMatchObject({ callId: 'q1', isError: false });
    expect(events.at(-1)?.data).toEqual({});
  });

  it('no_such_interrupt：不認得的 id、答過的 id 都退回，掛著的那顆不受影響', async () => {
    const probe = newProbe();
    const session = await open('h2', ONE_QUESTION, probe);
    await until(session, awaiting());
    const pending = pendingOf(session);

    expect(
      await session.client.inputRespond('h2', {
        namespace: [...pending.namespace],
        interrupt_id: '不存在的那一顆',
        response: { pick: 'X' },
      }),
    ).toMatchObject({
      type: 'error',
      error: 'no_such_interrupt',
      message: 'interrupt_id "不存在的那一顆" 不在這條 thread 掛著的那些中斷裡',
    });
    expect(probe.answers).toEqual([]);

    expect(await answer(session, 'h2', { pick: 'A' })).toMatchObject({ type: 'success' });
    await until(session, settled(2));
    expect(
      await session.client.inputRespond('h2', {
        namespace: [...pending.namespace],
        interrupt_id: pending.interruptId,
        response: { pick: 'B' },
      }),
    ).toMatchObject({
      type: 'error',
      error: 'no_such_interrupt',
      message: '這條 thread 上沒有等著回答的中斷',
    });
    expect(probe.answers).toEqual([{ pick: 'A' }]);
  });

  it('同一步兩題分兩次答：答了一題仍停著、另一題帶原 id 再交一次；兩題都答完才收', async () => {
    const probe = newProbe();
    const session = await open('h3', TWO_QUESTIONS, probe);
    await until(session, awaiting(2));
    const second = pendingOf(session, '第二題').interruptId;

    await answer(session, 'h3', '一', '第一題');
    await until(session, (s) => awaiting(1)(s) && rootEvents(s, ['turn/end']).length === 2);
    expect(pendingOf(session).interruptId).toBe(second);
    // 答了的那顆接著跑完、先記它的結果；沒答的那顆照舊掛著。
    expect(
      rootEvents(session, ['tool/result']).map((event) => (event.data as { callId: string }).callId),
    ).toEqual(['q1']);

    await answer(session, 'h3', '二', '第二題');
    await until(session, settled(2));
    expect(probe.answers).toEqual(['一', '二']);
    expect(
      rootEvents(session, ['tool/result']).map((event) => (event.data as { callId: string }).callId),
    ).toEqual(['q1', 'q2']);
  });
});

describe('停止', () => {
  it('停在中斷上按停止：收回那一輪照今天的形狀寫，之後沒有任何晚到的寫入，下一句照常跑', async () => {
    const probe = newProbe();
    const session = await open('s1', [...ONE_QUESTION.slice(0, 1), { content: '好，換一題' }], probe);
    await until(session, awaiting());
    await untilLogged(session, 'turn/end', 1);

    await session.client.runCancel('s1');
    await until(session, stopped);
    await drain();

    const afterStop = rootEvents(session);
    const tail = afterStop.slice(afterStop.findLastIndex((event) => event.type === 'turn/start'));
    expect(tail.map((event) => event.type)).toEqual(['turn/start', 'tool/result', 'turn/end']);
    expect(tail[0]?.data).toMatchObject({ kind: 'resume' });
    expect(tail[1]?.data).toMatchObject({ callId: 'q1', isError: true });
    expect(tail[2]?.data).toEqual({ reason: { kind: 'aborted', cause: { kind: 'user' } } });
    // native：那顆還在等的呼叫被收掉了（收掉的 run 不發事件、不改 state）。
    expect(probe.withdrawn).toBe(NATIVE ? 1 : 0);

    await session.client.runStart('s1', '換一題');
    await until(session, settled(2));
    expect(rootEvents(session, ['turn/failed'])).toEqual([]);
    const values = (await session.agent.getState({ configurable: { thread_id: 's1' } })).values as {
      messages: unknown[];
    };
    // 那顆呼叫的結果只有收回寫的那一則。
    expect(
      values.messages.filter(
        (message) => ToolMessage.isInstance(message) && message.tool_call_id === 'q1',
      ),
    ).toHaveLength(1);
  });

  it('接回之後那一段按停止：還在跑的那顆呼叫收得到這一輪的中止', async () => {
    const probe = newProbe();
    let reached!: () => void;
    const answered = new Promise<void>((resolve) => (reached = resolve));
    probe.afterAnswer = (config) => {
      reached();
      return untilAborted(config);
    };
    const session = await open('s2', ONE_QUESTION, probe);
    await until(session, awaiting());

    await answer(session, 's2', 'A');
    await answered;
    await session.client.runCancel('s2');
    await until(session, stopped);

    const ends = rootEvents(session, ['turn/end']);
    expect(ends.at(-1)?.data).toEqual({ reason: { kind: 'aborted', cause: { kind: 'user' } } });
    expect(rootEvents(session, ['tool/result']).at(-1)?.data).toMatchObject({
      callId: 'q1',
      isError: true,
    });
  });
});

describe('一輪的時鐘', () => {
  it('停在中斷上不計時；接回之後那一段重新計時，到點中止還在跑的那顆呼叫', async () => {
    const timers = new ManualTimers();
    const probe = newProbe();
    let reached!: () => void;
    const answered = new Promise<void>((resolve) => (reached = resolve));
    probe.afterAnswer = (config) => {
      reached();
      return untilAborted(config);
    };
    const session = await open('c1', ONE_QUESTION, probe, {
      turnClock: { timeoutMs: TIMEOUT_MS, graceMs: GRACE_MS, timers },
    });
    await until(session, awaiting());
    await untilLogged(session, 'turn/end', 1);
    // 等人的時間不算：中斷那一輪收了，時鐘跟著清掉。
    expect(timers.delays()).toEqual([]);

    await answer(session, 'c1', 'A');
    await answered;
    expect(timers.delays()).toEqual([TIMEOUT_MS]);
    timers.fire(TIMEOUT_MS);
    await until(session, stopped);

    expect(rootEvents(session, ['turn/end']).at(-1)?.data).toEqual({
      reason: { kind: 'aborted', cause: { kind: 'hook', reason: 'turn-timeout' } },
    });
  });
});

describe('閒置驅逐', () => {
  it('停在中斷上不撤；按停止收回之後才撤', async () => {
    const probe = newProbe();
    const session = await open('e1', ONE_QUESTION, probe, { idleEvictMs: 1 });
    await until(session, awaiting());
    await untilLogged(session, 'turn/end', 1);
    // 下行掛著也算不閒：斷掉它，只剩「掛著的中斷」擋著。
    await session.hangUp();

    await session.handler.sweepIdle();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await session.handler.sweepIdle();
    expect(session.handler.threadCount()).toBe(1);

    await session.client.runCancel('e1');
    await untilLogged(session, 'turn/end', 2);
    await session.handler.sweepIdle();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await session.handler.sweepIdle();
    expect(session.handler.threadCount()).toBe(0);
    expect(probe.withdrawn).toBe(NATIVE ? 1 : 0);
  });
});

describe('收線與重開', () => {
  it('停在中斷上收線：那次 run 一起收掉；重開之後答那顆舊 id 是 no_such_interrupt', async () => {
    const probe = newProbe();
    const first = await open('r1', ONE_QUESTION, probe);
    await until(first, awaiting());
    const pending = pendingOf(first);
    await first.hangUp();
    await first.handler.close();
    opened.splice(opened.indexOf(first.handler), 1);
    await drain();
    expect(probe.withdrawn).toBe(NATIVE ? 1 : 0);

    const second = await open('r1', ONE_QUESTION, newProbe(), { silent: true });
    expect(
      await second.client.inputRespond('r1', {
        namespace: [...pending.namespace],
        interrupt_id: pending.interruptId,
        response: 'A',
      }),
    ).toMatchObject({
      type: 'error',
      error: 'no_such_interrupt',
      message: '這條 thread 上沒有等著回答的中斷',
    });
  });
});
