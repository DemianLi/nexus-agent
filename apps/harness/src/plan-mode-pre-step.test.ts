/**
 * 同意之後的待關在 `agent/pre-step` 交出，日誌上的順序（[#2358](https://github.com/DemianLi/nexus-agent/issues/2358)）。
 *
 * `exit_plan_mode` 被同意之後排一格待關，插件經 `ToolThread.on('agent/pre-step')` 在下一步開頭寫 `plan/mode {active:false}`。
 * native 迴圈在整條 `beforeModel` 與 model-call middleware 之前派 pre-step，所以這一步 `beforeModel` 寫的事件排在
 * `plan/mode` 後面。這一支在真的 serve 上（腳本模型、`--agent-loop native`、`/plan` 進模式、人按同意）釘住那幾處：
 *
 * - 基準：同意之後沒有別的事件時，`plan/mode` 緊接在 `exit_plan_mode` 的結果之後。
 * - step-inbox 在 `beforeModel` 領取插話寫的 `inbox/spliced` 與插話的 `user/message`。
 * - 重複提醒在 `beforeModel` 寫的 `user/message`。
 * - 同意時 `next-step` 有插話排著：這一輪不收，同一輪的下一次模型請求已經沒有計劃模式的指引。
 *
 * 圖片省略、摘要器、換模型那幾格在腳本 serve 上不寫事件（沒有型錄、沒到摘要門檻），這裡不量。
 *
 * 另外兩組在兩個 loop 上各跑一次：
 *
 * - 插件的 `agent/pre-step` listener 拋錯：錯原樣往外，這一輪以那個錯收尾，模型沒被叫到。插件是樹上的函式插件，經 serve 的 `--patch` 插進清單。
 * - pre-step 那一刻這一步已經中止（人按停止）：待關不交出，留到下一輪的第一步交出，那一步的請求沒有指引。停止的時機由一位宿主層的
 *   `agent/pre-step` 監聽者卡住：它在同意之後的第一步送 `run.cancel`，等這一步的 signal 中止才往內交。
 *
 * **零憑證、零外部連線**：模型是腳本。
 */

import { readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemorySaver } from '@langchain/langgraph';
import type { PluginEntry, SessionEvent } from '@nexus/core';
import {
  EXIT_PLAN_MODE_TOOL_NAME,
  PLAN_APPROVE_LABEL,
  PLAN_APPROVED_MESSAGE,
  PLAN_REVIEW_QUESTION_ID,
} from '@nexus/plugin-plan-mode';
import {
  answerResponse,
  createWireClient,
  emptyConversation,
  isQuestionPending,
  reduceConversation,
} from '@nexus/wire';
import type { ConversationState, Event, PendingQuestion, WireClient } from '@nexus/wire';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import {
  emptyCommandPoint,
  foldTurn,
  humanChannelPlugin,
  loopbackRequest,
  serveClient,
  shippedPlugins,
  TEST_BROWSER_AUTH,
  TEST_PLAN_GUIDANCE,
  testPlanModePlugin,
} from './fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { startScriptedServe } from './scripted-serve.js';
import type { ScriptedServe } from './scripted-serve.js';
import { sessionEventsOf } from './session-files.fixture.js';
import { composeAttachSessions } from './session-attach.js';
import type { SessionLog, SessionRegistry } from '@nexus/core';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

type Loop = 'langgraph' | 'native';

const PLAN = '# 計劃\n\n先看再改。';
const EXIT = { name: EXIT_PLAN_MODE_TOOL_NAME, args: { plan: PLAN } };
const STEER = '補一句：先不要動 lib/。';
const APPROVE = answerResponse([{ id: PLAN_REVIEW_QUESTION_ID, selected: [PLAN_APPROVE_LABEL] }]);

/** 出貨清單上計劃模式的指引：模式生效時在系統提示詞裡。 */
async function shippedGuidance(): Promise<string> {
  const row = (await shippedPlugins()).find((entry) => entry.id === 'plan-mode');
  const guidance = (row?.config as { guidance?: string } | undefined)?.guidance;
  if (guidance === undefined) throw new Error('出貨清單上沒有 plan-mode 的指引');
  return guidance;
}

let serve: ScriptedServe | undefined;
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await serve?.close();
  serve = undefined;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** 折到 root 收尾那顆 `lifecycle`，每顆 frame 先交給 `onFrame`。同 `foldTurn`，多一個看 frame 的口。 */
async function foldTurnWatching(
  events: AsyncIterator<Event>,
  onFrame: (frame: Event) => Promise<void>,
): Promise<ConversationState> {
  let state = emptyConversation();
  for (;;) {
    const next = await events.next();
    if (next.done === true) throw new Error('下行在 root 收尾之前就斷了');
    state = reduceConversation(state, next.value);
    await onFrame(next.value);
    const data = next.value.params.data as { event?: unknown; graph_name?: unknown } | null;
    if (
      next.value.method === 'lifecycle' &&
      next.value.params.namespace.length === 0 &&
      data?.graph_name === 'root' &&
      (data.event === 'completed' || data.event === 'failed')
    ) {
      return state;
    }
  }
}

/**
 * 起一台 native serve，`/plan` 進模式、說一句、停在計劃審核上按同意、跑完，回落盤的 root 日誌。
 *
 * @param steer - 給了就在第一次模型串流途中送這句插話（`run.start` 的 `steer`）：那時這一輪還收插話，它進 `next-step`，
 *   排到同意之後那一步才被領走。
 */
async function approveOnServe(
  turns: readonly ScriptedTurn[],
  steer?: string,
): Promise<SessionEvent[]> {
  const logs = await mkdtemp(join(tmpdir(), 'nexus-plan-pre-step-logs-'));
  cleanups.push(() => rm(logs, { recursive: true, force: true }));
  const thread = 'plan-pre-step';
  serve = await startScriptedServe(turns, {
    argv: ['--agent-loop', 'native', '--session-log', logs],
  });
  const client = await serveClient(serve.running);
  const events: AsyncIterator<Event> = await client.openEvents(thread);
  expect(await client.slashRun(thread, '/plan')).toMatchObject({ kind: 'success' });
  await client.runStart(thread, '動手。');
  let sent = false;
  const parked = await foldTurnWatching(events, async (frame) => {
    if (steer === undefined || sent || frame.method !== 'messages') return;
    sent = true;
    await client.runStart(thread, steer, { mode: 'steer' });
  });
  const question = parked.pendings[0];
  if (question === undefined) throw new Error('沒有停在計劃審核上');
  await client.inputRespond(thread, {
    namespace: [...question.namespace],
    interrupt_id: question.interruptId,
    response: APPROVE,
  });
  await foldTurn(events, parked);
  await events.return?.(undefined);
  await serve.close();
  serve = undefined;
  const [project] = readdirSync(logs);
  return sessionEventsOf(join(logs, project!), thread);
}

/** 從同意的那顆 `exit_plan_mode` 結果起，到下一顆 `model/end`（含）為止。 */
function afterApproval(log: readonly SessionEvent[]): SessionEvent[] {
  const exitIds = new Set(
    log.flatMap((event) =>
      event.type === 'tool/call' && event.data.name === EXIT_PLAN_MODE_TOOL_NAME
        ? [event.data.callId]
        : [],
    ),
  );
  const from = log.findLastIndex(
    (event) => event.type === 'tool/result' && exitIds.has(event.data.callId),
  );
  const to = log.findIndex((event, at) => at > from && event.type === 'model/end');
  if (from < 0 || to < 0) throw new Error('日誌上找不到同意之後的那一段');
  return log.slice(from, to + 1);
}

const typesOf = (events: readonly SessionEvent[]): string[] => events.map((event) => event.type);

/** `request/system` 送出的系統提示詞。 */
function systemsOf(events: readonly SessionEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === 'request/system' ? [(event.data as { system: string }).system] : [],
  );
}

function humanTextOf(event: SessionEvent | undefined): unknown {
  return (event?.data as { message?: { data?: { content?: unknown } } } | undefined)?.message?.data
    ?.content;
}

describe('serve --agent-loop native：同意之後的待關在 pre-step 交出，排在這一步 beforeModel 寫的事件之前', () => {
  it('基準：沒有別的事件時，plan/mode 緊接在 exit_plan_mode 的結果之後', async () => {
    const log = await approveOnServe([
      { content: '我先規劃。', toolCalls: [EXIT] },
      { content: '開始動手。' },
    ]);
    const window = afterApproval(log);
    expect(typesOf(window)).toEqual([
      'tool/result',
      'plan/mode',
      'request/system',
      'model/start',
      'assistant/message',
      'model/end',
    ]);
    expect(window[1]?.data).toEqual({ active: false });
  }, 60000);

  it('step-inbox：plan/mode 排在 beforeModel 領取插話寫的 inbox/spliced 與那則 user/message 之前', async () => {
    const log = await approveOnServe(
      [
        { content: '我先規劃一下這件事。', tokenDelayMs: 80, toolCalls: [EXIT] },
        { content: '開始動手。' },
      ],
      STEER,
    );
    const window = afterApproval(log);
    expect(typesOf(window)).toEqual([
      'tool/result',
      'plan/mode',
      'inbox/spliced',
      'user/message',
      'request/system',
      'model/start',
      'assistant/message',
      'model/end',
    ]);
    expect(window[1]?.data).toEqual({ active: false });
    expect(window[2]?.data).toMatchObject({ target: 'next-step', removedCount: 1 });
    expect(humanTextOf(window[3])).toBe(STEER);
  }, 60000);

  it('重複提醒：plan/mode 排在 beforeModel 寫的提醒 user/message 之前', async () => {
    const echo = { name: 'echo', args: { message: 'x' } };
    const log = await approveOnServe([
      // 提醒只看最後一則 AI 訊息、在連續第 3 次（出貨門檻）時發，所以三顆同參數的 echo 跟 exit_plan_mode 同一批。
      { content: '我先規劃。', toolCalls: [EXIT, echo, echo, echo] },
      { content: '開始動手。' },
    ]);
    const window = afterApproval(log);
    expect(typesOf(window)).toEqual([
      'tool/result',
      'tool/call',
      'tool/result',
      'tool/call',
      'tool/result',
      'tool/call',
      'tool/result',
      'plan/mode',
      'user/message',
      'request/system',
      'model/start',
      'assistant/message',
      'model/end',
    ]);
    expect(window[7]?.data).toEqual({ active: false });
    expect(window[8]?.data).toMatchObject({
      source: { kind: 'plugin', plugin: expect.stringMatching(/repeat/iu) },
    });
  }, 60000);

  /**
   * 同一批只有 `exit_plan_mode`、被同意時不收這一輪，所以「同意了、這一批要收、`next-step` 又有插話」那條（跳回模型那次 native 不派
   * pre-step）走不到。量的是實際的行為：插話排著、同意，這一輪沒收，同一輪的下一次請求讀到插話、已經沒有指引。
   */
  it('同意時 next-step 有插話排著：這一輪不收，下一次模型請求帶著插話、已經沒有計劃模式的指引', async () => {
    const guidance = await shippedGuidance();
    const log = await approveOnServe(
      [
        { content: '我先規劃一下這件事。', tokenDelayMs: 80, toolCalls: [EXIT] },
        { content: '開始動手。' },
      ],
      STEER,
    );
    const resumed = log.findLastIndex(
      (event) => event.type === 'turn/start' && event.data.kind === 'resume',
    );
    const turn = log.slice(resumed);
    // 同一輪（resume 那一輪）裡又叫了一次模型、說完才收；收尾不帶理由。
    expect(typesOf(turn).filter((type) => type === 'model/end')).toHaveLength(1);
    expect(turn.filter((event) => event.type === 'turn/end').map((event) => event.data)).toEqual([
      {},
    ]);
    const window = afterApproval(log);
    expect(humanTextOf(window.find((event) => event.type === 'user/message'))).toBe(STEER);
    // 對照：同意之前那次請求有指引。
    const systems = systemsOf(log);
    expect(systems).toHaveLength(2);
    expect(systems[0]).toContain(guidance);
    expect(systemsOf(window)).toEqual([systems[1]]);
    expect(systems[1]).not.toContain(guidance);
  }, 60000);
});

const PRE_STEP_FAILURE = '測試：pre-step listener 壞了';

/** 一顆樹上的函式插件夾具：經 `tools.threadSource` 掛一位一律拋錯的 `agent/pre-step` listener。 */
function throwingPreStepRow(dir: string): string {
  const module = join(dir, 'pre-step-thrower.mjs');
  writeFileSync(
    module,
    `import { z } from 'zod';
export const name = 'pre-step-thrower';
export const inject = { tools: { range: '^2.11.0' } };
export const Config = z.strictObject({});
export const manifest = {
  id: 'pre-step-thrower', version: '1.0.0', owner: 't',
  provides: [], consumes: [{ token: 'tools', range: '^2.11.0' }],
  config: Config, reload: { code: 'restart', config: 'next-thread' }, capabilities: [],
};
export function apply(ctx) {
  ctx.tools.threadSource(async (thread) => {
    thread.on('agent/pre-step', () => { throw new Error(${JSON.stringify(PRE_STEP_FAILURE)}); });
  });
}
`,
    { mode: 0o600 },
  );
  return `- insert:
    - id: pre-step-thrower
      name: 'file://${module}'
      config: {}
`;
}

describe('插件的 agent/pre-step listener 拋錯（serve，樹上的函式插件）', () => {
  it.each(['native', 'langgraph'] as const)(
    '%s：這一輪以那個錯收尾，模型沒被叫到',
    async (loop: Loop) => {
      const dir = await mkdtemp(join(tmpdir(), 'nexus-pre-step-thrower-'));
      const logs = await mkdtemp(join(tmpdir(), 'nexus-pre-step-thrower-logs-'));
      cleanups.push(async () => {
        await rm(dir, { recursive: true, force: true });
        await rm(logs, { recursive: true, force: true });
      });
      const boot: string[] = [];
      serve = await startScriptedServe([{ content: '不該說到這句。' }], {
        argv: ['--agent-loop', loop, '--session-log', logs],
        extraRows: throwingPreStepRow(dir),
        log: (line) => boot.push(line),
      });
      const thread = `pre-step-throw-${loop}`;
      const client = await serveClient(serve.running);
      const events: AsyncIterator<Event> = await client.openEvents(thread);
      await client.runStart(thread, '動手。');
      const done = await foldTurn(events);
      await events.return?.(undefined);
      await serve.close();
      serve = undefined;

      // 那一列真的掛上了（起動時列出的插件裡有它），不是載入時掉了。
      expect(
        boot.some((line) => line.includes('serve plugin：') && line.includes('pre-step-thrower')),
      ).toBe(true);
      expect(JSON.stringify(done)).toContain(PRE_STEP_FAILURE);
      expect(JSON.stringify(done)).not.toContain('不該說到這句。');
      const [project] = readdirSync(logs);
      const log = await sessionEventsOf(join(logs, project!), thread);
      expect(typesOf(log)).not.toContain('model/start');
      expect(typesOf(log)).not.toContain('llm/retry');
      // 這一輪以 `turn/failed` 收尾，帶的就是那個錯；沒有 `turn/end`。
      expect(typesOf(log)).not.toContain('turn/end');
      expect(
        log.filter((event) => event.type === 'turn/failed').map((event) => event.data),
      ).toEqual([
        { message: PRE_STEP_FAILURE, error: { message: PRE_STEP_FAILURE, code: 'UNKNOWN' } },
      ]);
      expect(log.at(-1)?.type).toBe('turn/failed');
    },
    60000,
  );
});

interface WireSession {
  readonly thread: string;
  readonly model: ScriptedChatModel;
  readonly client: WireClient;
  readonly events: AsyncGenerator<Event, void, undefined>;
  state: ConversationState;
  log(): readonly SessionEvent[];
  rootLog(): SessionLog;
}

/** 真的 wire handler 與 pump，組裝是 `createNexusAgent`（計劃模式從一開始就開著），多掛幾顆條目。同 `plan-review-wire.test.ts`。 */
async function openWire(
  loop: Loop,
  turns: readonly ScriptedTurn[],
  extra: readonly PluginEntry[],
): Promise<WireSession> {
  const model = new ScriptedChatModel({ turns });
  const built = await createNexusAgent({
    model,
    checkpointer: new MemorySaver(),
    agentLoop: loop,
    plugins: [humanChannelPlugin(), testPlanModePlugin({ startActive: true }), ...extra],
  });
  let sessions: SessionRegistry | undefined;
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    createAgent: async () => ({
      agent: built.agent as unknown as PumpAgent,
      commands: emptyCommandPoint(),
      attachSessions: (registry, backgroundPort) => {
        sessions = registry;
        return composeAttachSessions(built)(registry, backgroundPort);
      },
      dispose: built.dispose,
    }),
  });
  cleanups.push(() => handler.close());
  const client = createWireClient({
    baseUrl: 'http://plan-pre-step.test',
    fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
  });
  const thread = `plan-pre-step-abort-${loop}`;
  const events = await client.openEvents(thread);
  return {
    thread,
    model,
    client,
    events,
    state: emptyConversation(),
    log: () =>
      sessions
        ?.list()
        .filter((entry) => entry.address.kind === 'root')
        .map((entry) => entry.log.events)[0] ?? [],
    rootLog: () => {
      const root = sessions?.list().find((entry) => entry.address.kind === 'root');
      if (root === undefined) throw new Error('還沒有 root 日誌');
      return root.log;
    },
  };
}

async function until(session: WireSession, done: () => boolean): Promise<void> {
  while (!done()) {
    const next = await session.events.next();
    if (next.done === true) throw new Error('下行斷了');
    session.state = reduceConversation(session.state, next.value);
  }
}

/** 送給模型的那一份請求裡的系統訊息。 */
function systemPromptOf(
  prompt: readonly { getType(): string; text: string }[] | undefined,
): string {
  return (prompt ?? [])
    .filter((message) => message.getType() === 'system')
    .map((message) => message.text)
    .join('\n');
}

/** 日誌上收尾（`turn/end` 或 `turn/failed`）的顆數。 */
const turnEnds = (session: WireSession): number =>
  session.log().filter((event) => event.type === 'turn/end' || event.type === 'turn/failed').length;

describe('pre-step 那一刻這一步已經中止（人按停止）', () => {
  it.each(['native', 'langgraph'] as const)(
    '%s：同意之後那一步不交待關；下一輪第一步交出，那一步的請求沒有指引',
    async (loop: Loop) => {
      // 宿主層的監聽者，排在計劃模式那一位的內側：上膛之後第一次被叫時送停止，等這一步的 signal 中止才往內交。
      let fire: ((signal: AbortSignal) => Promise<void>) | undefined;
      let fired = 0;
      const stopper: PluginEntry = {
        plugin: {
          name: 'pre-step-stopper',
          apply(registry) {
            registry.events.on('agent/pre-step', async (payload, next) => {
              const armed = fire;
              fire = undefined;
              if (armed !== undefined) {
                fired += 1;
                await armed(payload.signal);
              }
              return next();
            });
          },
        },
      };
      const session = await openWire(
        loop,
        // langgraph 那一次被中止的呼叫也吃掉一格腳本，所以多備一格。
        [
          { content: '我先規劃。', toolCalls: [EXIT] },
          { content: '繼續做。' },
          { content: '繼續做。' },
        ],
        [stopper],
      );
      await session.client.runStart(session.thread, '幫我改一下');
      await until(session, () => session.state.status === 'awaiting-input');
      const pending = session.state.pendings[0] as PendingQuestion | undefined;
      if (pending === undefined || !isQuestionPending(pending)) throw new Error('沒有掛著的提問');
      // 停在提問上的那一輪已經收了一顆 `turn/end`。
      await until(session, () => turnEnds(session) === 1);

      fire = async (signal) => {
        void session.client.runCancel(session.thread);
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
      };
      const before = session.log().length;
      await session.client.inputRespond(session.thread, {
        namespace: [...pending.namespace],
        interrupt_id: pending.interruptId,
        response: APPROVE,
      });
      await until(session, () => turnEnds(session) === 2);

      expect(fired).toBe(1);
      const stopped = session.log().slice(before);
      // native 在整條 model-call middleware 之前派 pre-step，中止的那一步沒有 `model/start`；langgraph 的轉接格在 `wrapModelCall` 裡、
      // 起訖紀錄器的外側，往內交之後照樣叫模型，所以那一次呼叫記了一對 `model/start`／`model/end`（`outcome: 'aborted'`）。
      expect(typesOf(stopped)).toEqual(
        loop === 'native'
          ? ['turn/start', 'tool/call', 'tool/result', 'turn/end']
          : ['turn/start', 'tool/call', 'tool/result', 'model/start', 'model/end', 'turn/end'],
      );
      expect(stopped[0]?.data).toEqual({ kind: 'resume' });
      expect(
        (stopped[2]?.data as { message?: { data?: { content?: unknown } } }).message?.data?.content,
      ).toBe(PLAN_APPROVED_MESSAGE);
      if (loop === 'langgraph') expect(stopped[4]?.data).toMatchObject({ outcome: 'aborted' });
      expect(stopped.at(-1)?.data).toEqual({
        reason: { kind: 'aborted', cause: { kind: 'user' } },
      });
      expect(typesOf(session.log())).not.toContain('plan/mode');
      // native 中止的那一步沒叫模型。langgraph 的轉接格往內交之後照叫：模型收到了請求（這時還沒交待關，請求裡仍是計劃模式），
      // 隨即以中止收掉，就是上面那顆 `outcome: 'aborted'`。
      expect(session.model.prompts).toHaveLength(loop === 'native' ? 1 : 2);
      expect(systemPromptOf(session.model.prompts.at(-1))).toContain(TEST_PLAN_GUIDANCE);

      // 下一輪：第一步交出待關，那一次請求已經沒有指引。
      const next = session.log().length;
      await session.client.runStart(session.thread, '那就繼續。');
      await until(session, () => turnEnds(session) === 3);
      const resumed = session.log().slice(next);
      expect(typesOf(resumed)).toEqual([
        'inbox/spliced',
        'turn/start',
        'inbox/spliced',
        'plan/mode',
        'request/system',
        'model/start',
        'assistant/message',
        'model/end',
        'context/measure',
        'turn/end',
      ]);
      expect(resumed[3]?.data).toEqual({ active: false });
      expect(session.model.prompts).toHaveLength(loop === 'native' ? 2 : 3);
      expect(systemPromptOf(session.model.prompts.at(-1))).not.toContain(TEST_PLAN_GUIDANCE);
      expect(systemsOf(session.log())).toHaveLength(2);
      expect(systemsOf(session.log())[0]).toContain(TEST_PLAN_GUIDANCE);
      expect(systemsOf(resumed)[0]).not.toContain(TEST_PLAN_GUIDANCE);
    },
    60000,
  );
});

const APPEND_FAILURE = '測試：plan/mode 寫不進去';

describe('同意之後那一步寫 plan/mode 拋錯', () => {
  it.each(['native', 'langgraph'] as const)(
    '%s：這一輪以那個錯收尾，待關沒了，下一輪照樣有指引',
    async (loop: Loop) => {
      const session = await openWire(
        loop,
        [
          { content: '我先規劃。', toolCalls: [EXIT] },
          { content: '繼續做。' },
          { content: '繼續做。' },
        ],
        [],
      );
      await session.client.runStart(session.thread, '幫我改一下');
      await until(session, () => session.state.status === 'awaiting-input');
      const pending = session.state.pendings[0] as PendingQuestion | undefined;
      if (pending === undefined || !isQuestionPending(pending)) throw new Error('沒有掛著的提問');
      await until(session, () => turnEnds(session) === 1);

      // 只有第一次寫 `plan/mode` 拋錯，之後照常：待關還在的話，下一次就寫得進去。
      const log = session.rootLog();
      const append = log.append.bind(log);
      let thrown = 0;
      vi.spyOn(log, 'append').mockImplementation(((type, data, options) => {
        if (type === 'plan/mode' && thrown === 0) {
          thrown += 1;
          throw new Error(APPEND_FAILURE);
        }
        return append(type, data, options);
      }) as SessionLog['append']);

      const before = session.log().length;
      await session.client.inputRespond(session.thread, {
        namespace: [...pending.namespace],
        interrupt_id: pending.interruptId,
        response: APPROVE,
      });
      await until(session, () => turnEnds(session) === 2);

      expect(thrown).toBe(1);
      const failed = session.log().slice(before);
      expect(typesOf(failed)).toEqual(['turn/start', 'tool/call', 'tool/result', 'turn/failed']);
      expect(failed.at(-1)?.data).toMatchObject({ message: APPEND_FAILURE });
      expect(session.model.prompts).toHaveLength(1);

      const next = session.log().length;
      await session.client.runStart(session.thread, '那就繼續。');
      await until(session, () => turnEnds(session) === 3);
      const resumed = session.log().slice(next);
      expect(typesOf(resumed)).not.toContain('plan/mode');
      expect(typesOf(session.log())).not.toContain('plan/mode');
      expect(systemPromptOf(session.model.prompts.at(-1))).toContain(TEST_PLAN_GUIDANCE);
    },
    60000,
  );
});
