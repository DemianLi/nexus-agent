/**
 * **等人服務接上 pump 與線**（[#2358](https://github.com/DemianLi/nexus-agent/issues/2358)）。
 *
 * 一顆測試用的提問工具：讀得到等人服務（`humanInputOf`）就 await 它，讀不到就呼叫 LangGraph 的 `interrupt()`。同一份檔在
 * `vitest.config.ts`（`langgraph`）與 `vitest.native.config.ts`（`native`）下各跑一次，斷言兩個 loop 共用；只有 native 才有的
 * （掛著的呼叫被收掉、本體只進一次）照 {@link NATIVE} 分開寫。
 *
 * 突變（量過，見 PR 內文；都在 native 下量：`langgraph` 讀不到服務，這幾處它不經過）：
 * - 拿掉 pump `#withdraw` 收掉掛著的 run：屏障「停在前一顆的提問上按停止」、「停在中斷上按停止」、「同一批還有一顆在跑」紅；
 * - 拿掉 pump `close()` 收掉掛著的 run：「收線與重開」紅；
 * - 拿掉 native 接回時換上那一段的中止訊號：屏障「前一顆拿到答覆後被中止」、「接回之後那一段按停止」、「一輪的時鐘」紅；
 * - 拿掉閒置判定的「沒有掛著的中斷」：「閒置驅逐」紅；
 * - 拿掉屏障的 `idle`：「兩顆 exclusive 核准，分兩次答」與屏障四條掛到逾時；
 * - 拿掉圍堵接回時補記 `tool/call`：「問一題」與「日誌整串對齊」三條紅；
 * - 補記只給答到的那顆：「一批兩顆核准，只答一顆」紅。
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
/** 同一個提問工具，但不宣告可並行：同一步兩顆照模型順序一顆一顆跑（屏障，`tool-barrier.ts`）。 */
const ASK_EXCLUSIVE = 'ask_exclusive';
/** 不問人，一直等到這一輪的中止訊號舉起來才回（{@link Probe.holdAfterAbort} 給了就再等它）。 */
const HOLD = 'hold_probe';
/** 回一則日誌記不下的結果（`BigInt`）：`tool/result` 落盤時拋，錯穿過圍堵。 */
const BREAK = 'break_probe';
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
  /** {@link HOLD} 的本體進來時叫。 */
  onHold?: () => void;
  /** 給了，{@link HOLD} 收到中止之後還要等它才回（不理中止的工具）。 */
  holdAfterAbort?: Promise<void>;
}

/** 答覆是這個字串時，提問工具拿到答覆後拋錯（像被拒絕的核准，那顆呼叫以錯誤收）。 */
const REFUSE = '拒絕';

function newProbe(): Probe {
  return { entered: 0, answers: [], withdrawn: 0 };
}

function askPlugin(probe: Probe): PluginEntry {
  const body = async (
    { q, approval }: { q: string; approval?: boolean | undefined },
    config: unknown,
  ): Promise<string> => {
    probe.entered += 1;
    // 線上的折疊器認得的兩種形狀：問答（`kind: 'question'`），或核准（`kind: 'approval'`，pump 為它記
    // `approval/asked`／`approval/decided`）。
    const question =
      approval === true
        ? {
            kind: 'approval',
            actionRequests: [{ name: ASK, args: { q } }],
            reviewConfigs: [{ actionName: ASK, allowedDecisions: ['approve', 'reject'] }],
          }
        : { kind: 'question', questions: [{ id: q, question: q }] };
    const service = humanInputOf(config);
    let answer: unknown;
    try {
      answer = service === undefined ? interrupt(question) : await service.ask(question);
    } catch (error) {
      if (isHumanInputWithdrawn(error)) probe.withdrawn += 1;
      throw error;
    }
    probe.answers.push(answer);
    if (answer === REFUSE) throw new Error(`「${q}」被拒絕`);
    await probe.afterAnswer?.(config);
    return `答覆：${JSON.stringify(answer)}`;
  };
  const schema = z.object({ q: z.string(), approval: z.boolean().optional() });
  // 同一步兩顆可以一起問（同 `pending-replay.test.ts` 的兩顆核准）。
  const parallel = { [CONCURRENCY_SAFE_METADATA_KEY]: true };
  return {
    plugin: {
      name: 'ask-probe',
      apply(registry) {
        registry.tools.register(
          tool(body, { name: ASK, description: '問人一個問題。', schema, metadata: parallel }),
        );
        registry.tools.register(
          tool(body, { name: ASK_EXCLUSIVE, description: '問人一個問題，一次一顆。', schema }),
        );
        registry.tools.register(
          tool(
            async (_input, config) =>
              new ToolMessage({
                content: '結果',
                tool_call_id: (config as { toolCall?: { id?: string } }).toolCall?.id ?? '',
                additional_kwargs: { n: BigInt(1) },
              }),
            {
              name: BREAK,
              description: '回一則記不進日誌的結果。',
              schema: z.object({}),
              metadata: parallel,
            },
          ),
        );
        registry.tools.register(
          tool(
            async (_input, config) => {
              probe.onHold?.();
              await untilAborted(config);
              await probe.holdAfterAbort;
              return '停了';
            },
            {
              name: HOLD,
              description: '等到這一輪停下。',
              schema: z.object({}),
              metadata: parallel,
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
      (pending.kind === 'question' && (pending.questions[0] as { id?: unknown })?.id === q) ||
      (pending.kind === 'approval' && (pending.actions[0]?.args as { q?: unknown })?.q === q),
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
      rootEvents(session, ['tool/result']).map(
        (event) => (event.data as { callId: string }).callId,
      ),
    ).toEqual(['q1']);

    await answer(session, 'h3', '二', '第二題');
    await until(session, settled(2));
    expect(probe.answers).toEqual(['一', '二']);
    expect(
      rootEvents(session, ['tool/result']).map(
        (event) => (event.data as { callId: string }).callId,
      ),
    ).toEqual(['q1', 'q2']);
  });
});

/** 同一步兩顆 exclusive 的提問。 */
const TWO_EXCLUSIVE: readonly ScriptedTurn[] = [
  {
    content: '',
    toolCalls: [
      { id: 'e1', name: ASK_EXCLUSIVE, args: { q: '甲' } },
      { id: 'e2', name: ASK_EXCLUSIVE, args: { q: '乙' } },
    ],
  },
  { content: '兩顆都收到' },
  { content: '好' },
];

const APPROVE = { decisions: [{ type: 'approve' }] };

/** 等到只掛著「q」那一顆，而且 pump 收完了第 `turns` 輪。 */
async function untilAsked(session: Session, q: string, turns: number): Promise<void> {
  await until(session, (s) => {
    if (!awaiting(1)(s)) return false;
    try {
      pendingOf(s, q);
      return true;
    } catch {
      return false;
    }
  });
  await untilLogged(session, 'turn/end', turns);
}

/** 日誌整串的形狀：每顆事件的種類，帶 `callId` 或 `kind` 的再帶上它。 */
function shapeOf(session: Session): string[] {
  return rootEvents(session).map((event) => {
    const data = event.data as { callId?: unknown; kind?: unknown; outcome?: unknown };
    const tag = data.callId ?? data.kind ?? data.outcome;
    return typeof tag === 'string' ? `${event.type}:${tag}` : event.type;
  });
}

/** 同一個 `callId` 的每一顆 `tool/call`，逐欄位相同（接回那一輪補記的那顆，對 langgraph 是重進時記的那顆）。 */
function expectSameCalls(session: Session, callId: string, count: number): void {
  const calls = rootEvents(session, ['tool/call']).filter(
    (event) => (event.data as { callId: string }).callId === callId,
  );
  expect(calls).toHaveLength(count);
  for (const call of calls) expect(call.data).toEqual(calls[0]?.data);
}

const MODEL_ROUND = ['model/start', 'assistant/message', 'model/end', 'context/measure'];
const OPENING = [
  'inbox/spliced',
  'turn/start:message',
  'inbox/spliced',
  'session/title',
  'request/system',
  'request/header',
];

describe('日誌整串對齊：兩個 loop 同一個情境，事件的種類與順序一樣', () => {
  it('單顆核准', async () => {
    const probe = newProbe();
    const session = await open(
      'a1',
      [
        {
          content: '',
          toolCalls: [{ id: 'p1', name: ASK, args: { q: '可以嗎', approval: true } }],
        },
        { content: '收到' },
      ],
      probe,
    );
    await untilAsked(session, '可以嗎', 1);
    await answer(session, 'a1', APPROVE, '可以嗎');
    await until(session, settled(2));
    await untilLogged(session, 'turn/end', 2);

    expect(shapeOf(session)).toEqual([
      ...OPENING,
      ...MODEL_ROUND,
      'tool/call:p1',
      'interrupt/raised',
      'approval/asked',
      'turn/end',
      'turn/start:resume',
      'approval/decided:allowed-once',
      'tool/call:p1',
      'tool/result:p1',
      ...MODEL_ROUND,
      'turn/end',
    ]);
    expectSameCalls(session, 'p1', 2);
    expect(rootEvents(session, ['tool/call'])[0]?.data).toEqual({
      callId: 'p1',
      name: ASK,
      arguments: JSON.stringify({ q: '可以嗎', approval: true }),
    });
  });

  it('兩顆 exclusive 核准，分兩次答', async () => {
    const probe = newProbe();
    const session = await open(
      'a2',
      [
        {
          content: '',
          toolCalls: [
            { id: 'e1', name: ASK_EXCLUSIVE, args: { q: '甲', approval: true } },
            { id: 'e2', name: ASK_EXCLUSIVE, args: { q: '乙', approval: true } },
          ],
        },
        { content: '收到' },
      ],
      probe,
    );
    await untilAsked(session, '甲', 1);
    await answer(session, 'a2', APPROVE, '甲');
    await untilAsked(session, '乙', 2);
    await answer(session, 'a2', APPROVE, '乙');
    await until(session, settled(2));
    await untilLogged(session, 'turn/end', 3);

    expect(shapeOf(session)).toEqual([
      ...OPENING,
      ...MODEL_ROUND,
      'tool/call:e1',
      'interrupt/raised',
      'approval/asked',
      'turn/end',
      'turn/start:resume',
      'approval/decided:allowed-once',
      'tool/call:e1',
      'tool/result:e1',
      'tool/call:e2',
      'interrupt/raised',
      'approval/asked',
      'turn/end',
      'turn/start:resume',
      'approval/decided:allowed-once',
      'tool/call:e2',
      'tool/result:e2',
      ...MODEL_ROUND,
      'turn/end',
    ]);
    expectSameCalls(session, 'e1', 2);
    expectSameCalls(session, 'e2', 2);
  });

  it('一批兩顆核准，只答一顆、再答另一顆', async () => {
    const probe = newProbe();
    const session = await open(
      'a3',
      [
        {
          content: '',
          toolCalls: [
            { id: 'p1', name: ASK, args: { q: '一', approval: true } },
            { id: 'p2', name: ASK, args: { q: '二', approval: true } },
          ],
        },
        { content: '收到' },
      ],
      probe,
    );
    await until(session, awaiting(2));
    await untilLogged(session, 'turn/end', 1);
    await answer(session, 'a3', APPROVE, '一');
    await untilAsked(session, '二', 2);
    await answer(session, 'a3', APPROVE, '二');
    await until(session, settled(2));
    await untilLogged(session, 'turn/end', 3);

    // 第一次接回時沒答到的 p2 也再記一顆：langgraph 把同一批還沒收完的都從頭重進。
    expect(shapeOf(session)).toEqual([
      ...OPENING,
      ...MODEL_ROUND,
      'tool/call:p1',
      'tool/call:p2',
      'interrupt/raised',
      'approval/asked',
      'interrupt/raised',
      'approval/asked',
      'turn/end',
      'turn/start:resume',
      'approval/decided:allowed-once',
      'tool/call:p1',
      'tool/call:p2',
      'tool/result:p1',
      'interrupt/raised',
      'turn/end',
      'turn/start:resume',
      'approval/decided:allowed-once',
      'tool/call:p2',
      'tool/result:p2',
      ...MODEL_ROUND,
      'turn/end',
    ]);
    expectSameCalls(session, 'p1', 2);
    expectSameCalls(session, 'p2', 3);
  });
});

describe('屏障：同一步兩顆 exclusive 都問人', () => {
  it('一次只掛一顆：前一顆答完才輪到後一顆問；兩次都答完才收', async () => {
    const probe = newProbe();
    const session = await open('x1', TWO_EXCLUSIVE, probe);
    await until(session, awaiting(1));
    expect(pendingOf(session, '甲')).toBeDefined();
    await untilLogged(session, 'turn/end', 1);

    await answer(session, 'x1', 'A', '甲');
    await until(
      session,
      (s) =>
        awaiting(1)(s) &&
        s.state.pendings[0]?.kind === 'question' &&
        (s.state.pendings[0].questions[0] as { id?: unknown }).id === '乙',
    );
    await untilLogged(session, 'turn/end', 2);
    await answer(session, 'x1', 'B', '乙');
    await until(session, settled(2));

    expect(probe.answers).toEqual(['A', 'B']);
  });

  it('前一顆拿到答覆後失敗：後一顆照屏障往下跑、照常問人', async () => {
    const probe = newProbe();
    const session = await open('x2', TWO_EXCLUSIVE, probe);
    await until(session, awaiting(1));
    await untilLogged(session, 'turn/end', 1);

    await answer(session, 'x2', REFUSE, '甲');
    await until(
      session,
      (s) =>
        awaiting(1)(s) &&
        (s.state.pendings[0] as { questions?: { id?: unknown }[] }).questions?.[0]?.id === '乙',
    );
    await untilLogged(session, 'turn/end', 2);
    await answer(session, 'x2', 'B', '乙');
    await until(session, settled(2));

    expect(probe.answers).toEqual([REFUSE, 'B']);
  });

  it('前一顆拿到答覆後被中止：後一顆不再等它、照中止的規則收，不留在 idle', async () => {
    const probe = newProbe();
    let reached!: () => void;
    const answered = new Promise<void>((resolve) => (reached = resolve));
    probe.afterAnswer = (config) => {
      reached();
      return untilAborted(config);
    };
    const session = await open('x3', TWO_EXCLUSIVE, probe);
    await until(session, awaiting(1));
    await untilLogged(session, 'turn/end', 1);

    await answer(session, 'x3', 'A', '甲');
    await answered;
    await session.client.runCancel('x3');
    await until(session, stopped);
    await untilLogged(session, 'turn/end', 2);

    expect(rootEvents(session, ['turn/end']).at(-1)?.data).toEqual({
      reason: { kind: 'aborted', cause: { kind: 'user' } },
    });
    expect(probe.entered).toBe(NATIVE ? 1 : 2);

    await session.client.runStart('x3', '再來');
    await until(session, settled(2));
  });

  it('停在前一顆的提問上按停止：兩顆都放掉，後一顆的本體沒進去過', async () => {
    const probe = newProbe();
    const session = await open('x4', TWO_EXCLUSIVE, probe);
    await until(session, awaiting(1));
    await untilLogged(session, 'turn/end', 1);

    await session.client.runCancel('x4');
    await until(session, stopped);
    await untilLogged(session, 'turn/end', 2);

    expect(probe.entered).toBe(1);
    expect(probe.withdrawn).toBe(NATIVE ? 1 : 0);

    await session.client.runStart('x4', '再來');
    await until(session, settled(2));
  });
});

describe('停止', () => {
  it('停在中斷上按停止：收回那一輪照停在核准點時收回的形狀寫（turn/start resume → tool/result → turn/end aborted），之後沒有任何晚到的寫入，下一句照常跑', async () => {
    const probe = newProbe();
    const session = await open(
      's1',
      [...ONE_QUESTION.slice(0, 1), { content: '好，換一題' }],
      probe,
    );
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

describe('一輪的時鐘：同一批還有一顆在跑', () => {
  it('一顆在問人、一顆不理中止還在跑時到點：等那顆落定，這一批照常停在中斷上；按停止才收掉', async () => {
    const timers = new ManualTimers();
    const probe = newProbe();
    let holding!: () => void;
    const held = new Promise<void>((resolve) => (holding = resolve));
    probe.onHold = () => holding();
    let letGo!: () => void;
    probe.holdAfterAbort = new Promise<void>((resolve) => (letGo = resolve));
    const session = await open(
      't2',
      [
        {
          content: '',
          toolCalls: [
            { id: 'q1', name: ASK, args: { q: '哪一個' } },
            { id: 'h1', name: HOLD, args: {} },
          ],
        },
        { content: '好' },
      ],
      probe,
      { turnClock: { timeoutMs: TIMEOUT_MS, graceMs: GRACE_MS, timers } },
    );
    await held;
    for (let i = 0; i < 1_000 && probe.entered === 0; i += 1) await drain();
    expect(probe.entered).toBe(1);

    timers.fire(TIMEOUT_MS);
    await drain();
    // 中止不砍還在跑的工具，等它落定（`turn-cancel.ts`）：這一輪還沒收。
    expect(rootEvents(session, ['turn/end'])).toEqual([]);
    letGo();
    await until(session, awaiting(1));
    await untilLogged(session, 'turn/end', 1);
    // 收尾那顆 frame 是中斷，不是中止：這一輪照停在中斷上收（同 pump「中止照上線那顆收尾 frame 判」）。
    expect(rootEvents(session, ['turn/end']).at(-1)?.data).toEqual({});
    expect(probe.withdrawn).toBe(0);

    await session.client.runCancel('t2');
    await until(session, stopped);
    await untilLogged(session, 'turn/end', 2);
    expect(probe.withdrawn).toBe(NATIVE ? 1 : 0);
    expect(rootEvents(session, ['turn/end']).at(-1)?.data).toEqual({
      reason: { kind: 'aborted', cause: { kind: 'user' } },
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

describe('同一批一顆的結果記不進日誌、一顆在問人', () => {
  // TODO(#2594)：`langgraph` 在這裡交出中斷、同時記 `turn/failed`，人答了也沒有東西收下。修好之後拿掉跳過，這條就是那張卡的驗收。
  it.skipIf(!NATIVE)(
    '這一輪失敗：沒有中斷、沒有掛著的提問，問人那顆被收回，下一句照常跑',
    async () => {
      const probe = newProbe();
      const session = await open(
        't-break',
        [
          {
            content: '',
            toolCalls: [
              { id: 'q1', name: ASK, args: { q: '哪一個', approval: true } },
              { id: 'b1', name: BREAK, args: {} },
            ],
          },
          { content: '收到' },
        ],
        probe,
      );
      await until(session, (each) => each.state.status === 'failed');
      await untilLogged(session, 'turn/failed', 1);
      expect(shapeOf(session)).toEqual([
        ...OPENING,
        ...MODEL_ROUND,
        'tool/call:q1',
        'tool/call:b1',
        'tool/result:b1',
        'tool/result:q1',
        'turn/failed',
      ]);
      expect(
        rootEvents(session, ['interrupt/raised', 'approval/asked', 'approval/decided']),
      ).toEqual([]);
      const results = Object.fromEntries(
        rootEvents(session, ['tool/result']).map((event) => {
          const data = event.data as {
            callId: string;
            isError: boolean;
            error?: { code?: string };
          };
          return [data.callId, { isError: data.isError, code: data.error?.code }];
        }),
      );
      expect(results).toEqual({
        b1: { isError: true, code: 'TOOL_OUTCOME_UNKNOWN' },
        q1: { isError: true, code: 'ABORTED' },
      });
      expect(probe.withdrawn).toBe(1);
      expect(probe.answers).toEqual([]);

      // 線上：這一輪是失敗收的，沒交出過提問；拿一顆形狀相同的 id 去答也沒有東西收下。
      expect(session.state.status).toBe('failed');
      expect(session.state.pendings).toEqual([]);
      expect(session.frames.filter((frame) => frame.method === 'input.requested')).toEqual([]);
      expect(
        await session.client.inputRespond('t-break', {
          namespace: ['tools:q1'],
          interrupt_id: '0'.repeat(32),
          response: APPROVE,
        }),
      ).toMatchObject({
        type: 'error',
        error: 'no_such_interrupt',
        message: '這條 thread 上沒有等著回答的中斷',
      });
      expect(probe.answers).toEqual([]);

      await session.client.runStart('t-break', '再一句');
      await until(session, settled(1));
      expect(session.state.status).toBe('idle');
    },
  );
});
