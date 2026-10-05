/**
 * **核准的問與答落成日誌**——[#1029](https://github.com/DemianLi/nexus-agent/issues/1029) 的驗收。
 *
 * 真的 `createNexusAgent`＋`createWireHandler`＋JSONL 落盤，掛 `@nexus/plugin-trajectory`，核准閘門是產品路徑的
 * `approvals.gate`。量四件事：
 *
 * 1. **人那條路**（核准、拒絕、停在核准點按停止）：日誌上各自長出一對 `approval/asked`＋`approval/decided`，id 就是
 *    中斷的 id、`callId` 配得上 `tool/call`，decided 落在回答它的那一輪裡；拒絕的 `tool/result` 帶碼，**與「工具自己失敗」
 *    分得開**。
 * 2. **不必問人就確定的**（政策關掉、子代理）：閘門在圖內一次寫一對，沒有 `interrupt/raised`。
 * 3. **問答中斷不長核准事件**（`ask_user_question` 同樣是一顆 `interrupt/raised`）。
 * 4. **軌跡投影看得到**：中斷那一列帶 `approval`，即時 = 歷史 = 重開之後。
 *
 * 突變（量過，見 PR 內文）：拿掉碼 → 拒絕那條紅；拿掉 pump 的 asked／decided／收回 → 對應那條紅；拿掉閘門的圖內審計
 * → 政策關掉那條與子代理那條紅。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import {
  APPROVAL_POLICY_NEVER,
  APPROVAL_REJECTED_BY_USER,
  attachSessionPersistence,
} from '@nexus/core';
import type { PluginEntry, SessionEvent, SessionRegistry } from '@nexus/core';
import { ASK_USER_QUESTION_TOOL_NAME, createAskUserPlugin } from '@nexus/plugin-ask-user';
import { createTrajectoryPlugin } from '@nexus/plugin-trajectory';
import {
  appendDecision,
  createWireClient,
  emptyConversation,
  reduceAll,
  reduceConversation,
  TRAJECTORY_PROJECTION,
  uniformDecisions,
} from '@nexus/wire';
import type { ConversationState, Event, TrajectoryView, WireClient } from '@nexus/wire';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { runCli } from './cli.js';
import { readSessionLogs } from './eval/session-scan.js';
import {
  approvalAt,
  emptyCommandPoint,
  humanChannelPlugin,
  loopbackRequest,
  TEST_BROWSER_AUTH,
} from './fixtures.js';
import { createJsonlSessionStore } from './jsonl-session-store.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { composeAttachSessions } from './session-attach.js';
import type { PumpAgent } from './thread-pump.js';
import { scriptedPatchText } from './scripted-serve.js';
import { createWireHandler } from './wire-handler.js';
import type { WireHandler } from './wire-handler.js';

const GATED = 'alpha';
const BASE_URL = 'http://approval-audit.test';

let dir: string;
let ran: string[] = [];
const opened: WireHandler[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-approval-audit-'));
  ran = [];
});
afterEach(async () => {
  for (const handler of opened.splice(0)) await handler.close();
  await rm(dir, { recursive: true, force: true });
});

function spyPlugin(): PluginEntry {
  return {
    plugin: {
      name: 'spy',
      apply(registry) {
        registry.tools.register(
          tool(
            () => {
              ran.push(GATED);
              return `${GATED} 跑過了`;
            },
            { name: GATED, description: `間諜 ${GATED}`, schema: z.object({}) },
          ),
        );
        // 工具自己失敗：對照組，不經核准。
        registry.tools.register(
          tool(
            () => {
              throw new Error('自己炸了');
            },
            { name: 'boom', description: '自己炸。', schema: z.object({}) },
          ),
        );
      },
    },
  };
}

function gatePlugin(): PluginEntry {
  return {
    plugin: {
      name: 'gate',
      apply(registry) {
        registry.approvals.gate((exec, next) =>
          exec.name === GATED ? { kind: 'ask', reason: `${GATED} 要人看過` } : next(),
        );
      },
    },
  };
}

interface Session {
  readonly client: WireClient;
  readonly events: AsyncGenerator<Event, void, undefined>;
  readonly frames: Event[];
  readonly handler: WireHandler;
  readonly sessions: () => SessionRegistry;
  state: ConversationState;
}

async function open(
  threadId: string,
  turns: readonly ScriptedTurn[],
  options: { readonly approvalsEnabled?: boolean; readonly plugins?: readonly PluginEntry[] } = {},
): Promise<Session> {
  const store = createJsonlSessionStore({ rootDir: join(dir, 'logs') });
  const built = await createNexusAgent({
    model: new ScriptedChatModel({ turns }),
    checkpointer: new MemorySaver(),
    plugins: [spyPlugin(), gatePlugin(), createTrajectoryPlugin(), ...(options.plugins ?? [])],
    ...(options.approvalsEnabled === undefined
      ? {}
      : { approvals: { enabled: options.approvalsEnabled } }),
  });
  let registry: SessionRegistry | undefined;
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    createAgent: async () => ({
      agent: built.agent as unknown as PumpAgent,
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
  const events = await client.openEvents(threadId);
  await client.runStart(threadId, '動手');
  return {
    client,
    events,
    frames: [],
    handler,
    sessions: () => {
      if (registry === undefined) throw new Error('日誌還沒接上');
      return registry;
    },
    state: emptyConversation(),
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

const requested = (session: Session): boolean =>
  session.frames.some((frame) => frame.method === 'input.requested');

/** 這一輪收完了：模型講完 `turns` 輪話。 */
const settled =
  (turns: number) =>
  (session: Session): boolean =>
    session.state.status === 'idle' &&
    session.state.entries.filter((entry) => entry.kind === 'ai' && !entry.streaming).length >=
      turns;

async function respond(
  session: Session,
  threadId: string,
  type: 'approve' | 'reject',
): Promise<void> {
  const pending = approvalAt(session.state.pendings);
  await session.client.inputRespond(threadId, {
    namespace: [...pending.namespace],
    interrupt_id: pending.interruptId,
    response: uniformDecisions(pending, type),
  });
  session.state = appendDecision(session.state, pending.interruptId, type);
}

/** root 日誌的事件，只留 `types` 這幾種，照 seq 排。 */
function rootEvents(session: Session, types: readonly string[]): SessionEvent[] {
  const root = session
    .sessions()
    .list()
    .find((each) => each.address.kind === 'root');
  if (root === undefined) throw new Error('沒有 root 日誌');
  return root.log.events.filter((event) => types.includes(event.type));
}

const trajectoryOf = (state: ConversationState): TrajectoryView | undefined =>
  state.projections[TRAJECTORY_PROJECTION]?.view as TrajectoryView | undefined;

async function historyOf(session: Session, threadId: string): Promise<ConversationState> {
  const page = await session.client.threadHistory(threadId);
  if (page.kind !== 'ok') throw new Error(page.message);
  return reduceAll(emptyConversation(), page.result.events);
}

const CALL_ALPHA: ScriptedTurn = {
  content: `動 ${GATED}。`,
  toolCalls: [{ name: GATED, id: 'call-alpha', args: {} }],
};
const SCRIPT_TWO_TURNS: readonly ScriptedTurn[] = [
  CALL_ALPHA,
  { content: '收工。' },
  { content: '再收一次工。' },
];

describe('人那條路：asked 在中斷的那一刻、decided 在回答的那一輪', () => {
  it('核准 → allowed-once；id 是中斷的 id、callId 配得上 tool/call；軌跡的中斷列帶 approval，即時 = 歷史', async () => {
    const session = await open('a1', SCRIPT_TWO_TURNS);
    await until(session, requested);
    const interruptId = approvalAt(session.state.pendings).interruptId;
    await respond(session, 'a1', 'approve');
    await until(session, settled(2));

    // 前提：工具真的跑了（核准那條走完），不是閘門根本沒觸發。
    expect(ran).toEqual([GATED]);
    const events = rootEvents(session, [
      'interrupt/raised',
      'approval/asked',
      'approval/decided',
      'turn/start',
      'turn/end',
    ]);
    const asked = events.find((event) => event.type === 'approval/asked');
    const decided = events.find((event) => event.type === 'approval/decided');
    expect(asked?.data).toEqual({
      id: interruptId,
      toolName: GATED,
      callId: 'call-alpha',
      reason: `${GATED} 要人看過`,
    });
    expect(decided?.data).toEqual({ id: interruptId, outcome: 'allowed-once' });
    // 兩顆都標可略過（純審計，不升格式版本，#507）。
    expect(asked?.ignorable).toBe(true);
    expect(decided?.ignorable).toBe(true);
    // 順序：raised → asked → turn/end（停在核准點）→ 下一輪 turn/start(resume) → decided。
    const order = events.map((event) =>
      event.type === 'turn/start'
        ? `turn/start:${String((event.data as { kind?: string }).kind)}`
        : event.type,
    );
    expect(order).toEqual([
      'turn/start:message',
      'interrupt/raised',
      'approval/asked',
      'turn/end',
      'turn/start:resume',
      'approval/decided',
      'turn/end',
    ]);
    // asked 的 callId 配得上日誌上的 tool/call。
    expect(
      rootEvents(session, ['tool/call']).map((event) => (event.data as { callId: string }).callId),
    ).toContain('call-alpha');

    // 軌跡：中斷那一列帶 approval。
    await until(session, (each) =>
      (trajectoryOf(each.state)?.turns ?? []).some((turn) =>
        turn.decisions.some(
          (decision) => decision.kind === 'interrupt' && decision.approval?.outcome !== undefined,
        ),
      ),
    );
    const row = trajectoryOf(session.state)!
      .turns.flatMap((turn) => turn.decisions)
      .find((decision) => decision.kind === 'interrupt');
    expect(row).toMatchObject({
      kind: 'interrupt',
      id: interruptId,
      approval: { tool: GATED, callId: 'call-alpha', outcome: 'allowed-once' },
    });
    expect(row?.kind === 'interrupt' ? row.approval?.decidedAt : undefined).toBeTypeOf('number');
    // 即時 = 歷史：歷史頁重折一遍，等即時這邊把收尾的 frame 收完（它們晚幾顆）。
    let refreshed = await historyOf(session, 'a1');
    for (let tries = 0; tries < 100; tries += 1) {
      if (JSON.stringify(refreshed.projections) === JSON.stringify(session.state.projections))
        break;
      const next = await Promise.race([
        session.events.next(),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 20)),
      ]);
      if (next !== undefined && next.done !== true) {
        session.frames.push(next.value);
        session.state = reduceConversation(session.state, next.value);
      }
      refreshed = await historyOf(session, 'a1');
    }
    expect(refreshed.projections).toEqual(session.state.projections);
  });

  it('拒絕 → rejected；tool/result 帶 APPROVAL_REJECTED_BY_USER，與「工具自己失敗」分得開', async () => {
    const session = await open('a2', [
      CALL_ALPHA,
      { content: '再來一個。', toolCalls: [{ name: 'boom', id: 'call-boom', args: {} }] },
      { content: '收工。' },
      { content: '再收一次工。' },
    ]);
    await until(session, requested);
    await respond(session, 'a2', 'reject');
    await until(session, settled(3));

    expect(ran).toEqual([]);
    const decided = rootEvents(session, ['approval/decided']);
    expect(decided.map((event) => (event.data as { outcome: string }).outcome)).toEqual([
      'rejected',
    ]);
    const results = rootEvents(session, ['tool/result']).map(
      (event) =>
        event.data as {
          callId: string;
          isError: boolean;
          error?: { name: string; code: string };
        },
    );
    const rejected = results.find((result) => result.callId === 'call-alpha' && result.isError);
    const failed = results.find((result) => result.callId === 'call-boom');
    // 被人拒的帶碼……
    expect(rejected?.error).toEqual({ name: 'ApprovalDenied', code: APPROVAL_REJECTED_BY_USER });
    // ……工具自己炸的是錯誤結果，但不是核准的碼。
    expect(failed?.isError).toBe(true);
    expect(failed?.error?.code).not.toBe(APPROVAL_REJECTED_BY_USER);
    expect(failed?.error?.name).not.toBe('ApprovalDenied');
  });

  it('停在核准點按停止 → cancelled，落在收回的那一輪裡（turn/start 之後、turn/end 之前）', async () => {
    const session = await open('a3', SCRIPT_TWO_TURNS);
    await until(session, requested);
    // 停在核准點的那一輪先在日誌上收完，這時按停止走的才是收回那條路（不是中止一輪正在跑的）。
    await vi.waitFor(() => {
      expect(rootEvents(session, ['turn/end'])).toHaveLength(1);
    });
    await session.client.runCancel('a3');
    await until(session, (each) => each.state.status === 'stopped');

    expect(ran).toEqual([]);
    const order = rootEvents(session, [
      'approval/asked',
      'approval/decided',
      'turn/start',
      'turn/end',
    ]).map((event) =>
      event.type === 'turn/start'
        ? `turn/start:${String((event.data as { kind?: string }).kind)}`
        : event.type,
    );
    expect(order).toEqual([
      'turn/start:message',
      'approval/asked',
      'turn/end',
      'turn/start:resume',
      'approval/decided',
      'turn/end',
    ]);
    const decided = rootEvents(session, ['approval/decided'])[0]!;
    const asked = rootEvents(session, ['approval/asked'])[0]!;
    expect(decided.data).toEqual({ id: (asked.data as { id: string }).id, outcome: 'cancelled' });
  });

  it('一輪兩顆都要核准、分兩次答：兩對各自配對，軌跡兩列（沒答的那顆以同 id 再掛不長第二列）各帶自己的結局', async () => {
    const session = await open('a4', [
      {
        content: '兩顆。',
        toolCalls: [
          { name: GATED, id: 'call-one', args: {} },
          { name: GATED, id: 'call-two', args: {} },
        ],
      },
      { content: '收工。' },
      { content: '再收一次工。' },
    ]);
    await until(session, requested);
    const first = approvalAt(session.state.pendings).interruptId;
    await respond(session, 'a4', 'approve');
    // 第二顆以**同一個 id** 再掛上來（resume 輪），等它出現在 pendings 才答。
    await until(session, (each) =>
      each.state.pendings.some(
        (pending) => pending.kind === 'approval' && pending.interruptId !== first,
      ),
    );
    const second = approvalAt(session.state.pendings).interruptId;
    expect(second).not.toBe(first);
    await respond(session, 'a4', 'reject');
    await until(session, settled(2));

    const asked = rootEvents(session, ['approval/asked']).map((event) => event.data);
    expect(asked).toEqual([
      expect.objectContaining({ id: first, callId: 'call-one' }),
      expect.objectContaining({ id: second, callId: 'call-two' }),
    ]);
    expect(rootEvents(session, ['approval/decided']).map((event) => event.data)).toEqual([
      { id: first, outcome: 'allowed-once' },
      { id: second, outcome: 'rejected' },
    ]);

    const rows = () =>
      (trajectoryOf(session.state)?.turns ?? [])
        .flatMap((turn) => turn.decisions)
        .filter((decision) => decision.kind === 'interrupt');
    await until(
      session,
      () => rows().every((row) => row.approval?.outcome !== undefined) && rows().length >= 2,
    );
    expect(rows().map((row) => [row.id, row.approval?.callId, row.approval?.outcome])).toEqual([
      [first, 'call-one', 'allowed-once'],
      [second, 'call-two', 'rejected'],
    ]);
  });
});

/**
 * 重開：收掉行程，只剩磁碟上的日誌；另一個 handler 以 root 的 seed 起來，第一次開歷史就要有軌跡。
 * 回重開後歷史折出來的軌跡中斷列。
 */
async function interruptRowsAfterReopen(session: Session, threadId: string) {
  opened.splice(opened.indexOf(session.handler), 1);
  await session.handler.close();
  const { logs } = await readSessionLogs([join(dir, 'logs')]);
  const rootSeed = logs.find((log) => log.header.id === threadId)?.events ?? [];
  expect(rootSeed.some((event) => event.type === 'approval/asked')).toBe(true);
  const rebuilt = await createNexusAgent({
    model: new ScriptedChatModel({ turns: [{ content: '不會被叫到。' }] }),
    checkpointer: new MemorySaver(),
    plugins: [spyPlugin(), gatePlugin(), createTrajectoryPlugin()],
  });
  const reopened = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    createAgent: async () => ({
      agent: rebuilt.agent as unknown as PumpAgent,
      commands: emptyCommandPoint(),
      projections: rebuilt.projections,
      dispose: () => rebuilt.dispose(),
      attachSessions: composeAttachSessions(rebuilt),
      rootSeed,
    }),
  });
  opened.push(reopened);
  const client = createWireClient({
    baseUrl: BASE_URL,
    fetch: async (input, init) => reopened.handle(loopbackRequest(input as string, init)),
  });
  const page = await client.threadHistory(threadId);
  if (page.kind !== 'ok') throw new Error(page.message);
  const state = reduceAll(emptyConversation(), page.result.events);
  return (trajectoryOf(state)?.turns ?? [])
    .flatMap((turn) => turn.decisions)
    .filter((decision) => decision.kind === 'interrupt');
}

describe('重開之後', () => {
  it('答完的：中斷列帶著 approval 與結局，和即時一樣', async () => {
    const session = await open('r1', SCRIPT_TWO_TURNS);
    await until(session, requested);
    const interruptId = approvalAt(session.state.pendings).interruptId;
    await respond(session, 'r1', 'approve');
    await until(session, settled(2));
    const rows = await interruptRowsAfterReopen(session, 'r1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: interruptId,
      approval: { tool: GATED, callId: 'call-alpha', outcome: 'allowed-once' },
    });
  });

  it('停在核准點沒人答就關掉的：asked 開著、沒有結局（不憑空推一個），也不當掉', async () => {
    const session = await open('r2', SCRIPT_TWO_TURNS);
    await until(session, requested);
    await vi.waitFor(() => {
      expect(rootEvents(session, ['turn/end'])).toHaveLength(1);
    });
    const interruptId = approvalAt(session.state.pendings).interruptId;
    // 前提：日誌上有 asked、沒有 decided。
    expect(rootEvents(session, ['approval/decided'])).toEqual([]);
    const rows = await interruptRowsAfterReopen(session, 'r2');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: interruptId, approval: { tool: GATED } });
    expect(rows[0]?.kind === 'interrupt' ? rows[0].approval?.outcome : 'x').toBeUndefined();
  });
});

describe('不必問人就確定的：閘門在圖內一次寫一對', () => {
  it('政策關掉 → asked＋decided(rejected) 落在 tool/call 與 tool/result 之間，沒有 interrupt/raised；碼是 APPROVAL_POLICY_NEVER', async () => {
    const session = await open('p1', SCRIPT_TWO_TURNS, { approvalsEnabled: false });
    await until(session, settled(2));

    expect(ran).toEqual([]);
    expect(rootEvents(session, ['interrupt/raised'])).toEqual([]);
    const order = rootEvents(session, [
      'tool/call',
      'approval/asked',
      'approval/decided',
      'tool/result',
    ]).map((event) => event.type);
    expect(order).toEqual(['tool/call', 'approval/asked', 'approval/decided', 'tool/result']);
    const [asked, decided] = rootEvents(session, ['approval/asked', 'approval/decided']);
    expect(asked?.data).toMatchObject({ toolName: GATED, callId: 'call-alpha' });
    expect(decided?.data).toEqual({
      id: (asked?.data as { id: string }).id,
      outcome: 'rejected',
    });
    expect(
      (rootEvents(session, ['tool/result'])[0]?.data as { error?: { code: string } }).error?.code,
    ).toBe(APPROVAL_POLICY_NEVER);
    // 沒有人被擋下來等：軌跡上沒有中斷列。
    expect(
      trajectoryOf(session.state)
        ?.turns.flatMap((turn) => turn.decisions)
        .filter((decision) => decision.kind === 'interrupt'),
    ).toEqual([]);
  });

  it('子代理的閘門一律 policy-never：這一對寫進子代理自己的日誌，不寫進 root', async () => {
    const worker: PluginEntry = {
      plugin: {
        name: 'worker-host',
        apply(registry) {
          registry.subagents.register({
            name: 'worker',
            description: '幹活的。',
            systemPrompt: '你是 worker。',
            model: new ScriptedChatModel({
              turns: [
                { content: '', toolCalls: [{ name: GATED, id: 'child-alpha', args: {} }] },
                { content: '子代理收工' },
              ],
            }) as never,
          });
        },
      },
    };
    const session = await open(
      's1',
      [
        {
          content: '委派。',
          toolCalls: [
            {
              name: 'task',
              id: 'root-task',
              args: { description: '幹活', subagent_type: 'worker' },
            },
          ],
        },
        { content: '根收尾' },
        { content: '再收' },
      ],
      { plugins: [worker] },
    );
    await until(session, settled(2));

    expect(ran).toEqual([]);
    const child = session
      .sessions()
      .list()
      .find((each) => each.address.kind === 'subagent');
    expect(child).toBeDefined();
    const childPair = child!.log.events.filter(
      (event) => event.type === 'approval/asked' || event.type === 'approval/decided',
    );
    expect(childPair.map((event) => event.type)).toEqual(['approval/asked', 'approval/decided']);
    expect(childPair[0]?.data).toMatchObject({ toolName: GATED, callId: 'child-alpha' });
    expect(childPair[1]?.data).toMatchObject({ outcome: 'rejected' });
    const childResult = child!.log.events.find((event) => event.type === 'tool/result');
    expect((childResult?.data as { error?: { code: string } }).error?.code).toBe(
      APPROVAL_POLICY_NEVER,
    );
    // root 的日誌沒有這一對（各折各的）。
    expect(rootEvents(session, ['approval/asked', 'approval/decided'])).toEqual([]);
  });
});

describe('問答中斷不長核准事件', () => {
  it('ask_user_question 同樣是 interrupt/raised，但沒有 approval/*，軌跡的中斷列沒有 approval', async () => {
    const session = await open(
      'q1',
      [
        {
          content: '我先問。',
          toolCalls: [
            {
              name: ASK_USER_QUESTION_TOOL_NAME,
              id: 'ask-1',
              args: {
                questions: [{ id: 'day', question: '哪一天？', options: [{ label: '週一' }] }],
              },
            },
          ],
        },
        { content: '收工。' },
      ],
      { plugins: [humanChannelPlugin(), createAskUserPlugin()] },
    );
    await until(session, requested);
    // 前提：中斷真的發生了，且記進日誌。
    await until(session, () => rootEvents(session, ['interrupt/raised']).length === 1);
    expect(rootEvents(session, ['interrupt/raised'])).toHaveLength(1);
    expect(rootEvents(session, ['approval/asked', 'approval/decided'])).toEqual([]);
    await until(session, (each) => {
      const row = trajectoryOf(each.state)
        ?.turns.flatMap((turn) => turn.decisions)
        .find((decision) => decision.kind === 'interrupt');
      return row !== undefined;
    });
    const row = trajectoryOf(session.state)!
      .turns.flatMap((turn) => turn.decisions)
      .find((decision) => decision.kind === 'interrupt');
    expect(row).not.toHaveProperty('approval');
  });
});

describe('CLI 那條產品路徑', () => {
  it('CLI 關掉人工核准（HEADLESS_APPROVALS）：被擋的 echo 在日誌上長出一對 asked＋decided(rejected)，碼是 APPROVAL_POLICY_NEVER', async () => {
    const script: readonly ScriptedTurn[] = [
      { content: '回聲。', toolCalls: [{ name: 'echo', id: 'cli-echo', args: { message: '嗨' } }] },
      { content: '收工。' },
    ];
    const patch = join(dir, 'scripted.patch.yml');
    await writeFile(patch, scriptedPatchText(script), 'utf8');
    // 出貨的核准示範 gate：把 echo 與 write_file 標成要人核准（`approval.patch.yml`）。
    const approvalPatch = fileURLToPath(new URL('./approval.patch.yml', import.meta.url));
    const logs = join(dir, 'cli-logs');

    await runCli({
      argv: ['--patch', patch, '--patch', approvalPatch, '--session-log', logs, '請回聲。'],
      input: new PassThrough(),
      output: new PassThrough(),
      printer: { log: () => undefined, error: () => undefined },
      env: { NEXUS_AGENT_HOME: join(dir, 'home') },
    });

    const loaded = await readSessionLogs([logs]);
    expect(loaded.unreadable).toEqual([]);
    const events = loaded.logs.flatMap((log) => log.events);
    // 前提：工具確實被擋了（結果是錯誤），不是閘門根本沒觸發。
    const result = events.find((event) => event.type === 'tool/result');
    expect(result?.data).toMatchObject({
      callId: 'cli-echo',
      isError: true,
      error: { code: APPROVAL_POLICY_NEVER },
    });
    const order = events
      .filter((event) =>
        ['tool/call', 'approval/asked', 'approval/decided', 'tool/result'].includes(event.type),
      )
      .map((event) => event.type);
    expect(order).toEqual(['tool/call', 'approval/asked', 'approval/decided', 'tool/result']);
    const [asked, decided] = events.filter((event) => event.type.startsWith('approval/'));
    expect(asked?.data).toMatchObject({ toolName: 'echo', callId: 'cli-echo' });
    expect(decided?.data).toEqual({ id: (asked?.data as { id: string }).id, outcome: 'rejected' });
  }, 60000);
});
