/**
 * 子代理的日誌接得回派它的那一輪與那一顆呼叫（[#1023](https://github.com/DemianLi/nexus-agent/issues/1023)）。
 *
 * **全走產品組裝**：`createNexusAgent`＋腳本模型＋`ThreadPump`＋`attachSession`，日誌經 `attachSessionPersistence` 落到
 * JSONL 後端，再用離線掃描那一份讀法（`readSessionLogs`）讀回來——判準量的是**落盤的那一份**，不是記憶體裡的。
 *
 * - **子 → 父**：讀子日誌 header 的 `parentSession` 打開父日誌，`subagentLinkOf` 解出 `callId`、那顆 `tool/call` 與那一輪的
 *   `turn/start`。**不手組 id**：子會話的 id 長什麼樣子不是這裡的判準。
 * - **父 → 子**：從父日誌那顆 `tool/call` 的 `callId` 找到目錄，`childId` 就是一份讀得到的子日誌 header 的 `id`。
 * - **wire**：即時與歷史（含重開之後只剩磁碟那一份）折出來的工具卡都帶 `subagentSession`。
 *
 * 前景有兩條入口（`task` 與 `subagent` 帶 `run_in_background: false`），背景一條，三條各跑一次。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import {
  attachSessionPersistence,
  replayConversation,
  subagentLinkOf,
  subagentLinks,
} from '@nexus/core';
import type { PluginEntry, SessionEvent, SessionRegistry } from '@nexus/core';
import { createWireClient, emptyConversation, reduceAll } from '@nexus/wire';
import type { ConversationState, Event, ToolEntry } from '@nexus/wire';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { formatScanReport, readSessionLogs, scanSessionLog } from './eval/session-scan.js';
import type { LoadedSessionLog } from './eval/session-scan.js';
import { emptyCommandPoint, loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import { createJsonlSessionStore } from './jsonl-session-store.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { composeAttachSessions } from './session-attach.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';
import type { WireHandler } from './wire-handler.js';

let dir: string;
const opened: WireHandler[] = [];
/**
 * 不變量的違規與 handler 的 warn 收在這裡，每條結尾斷言是空的：新的事件種類若讓哪一個配套入口（core、present……）
 * 不認帳，只會換來一行 warn，套件照樣綠——不收起來看就等於沒驗。
 */
let reported: string[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-subagent-link-'));
  reported = [];
});
afterEach(async () => {
  for (const handler of opened.splice(0)) await handler.close();
  await rm(dir, { recursive: true, force: true });
});

async function until(predicate: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** 三條派法：工具名、參數、要不要開背景宿主、目錄上該記的生命週期。 */
const CASES = [
  {
    label: '前景 task',
    name: 'task',
    args: { description: '幹活', subagent_type: 'worker' },
    background: false,
    mode: 'one-shot',
  },
  {
    label: '前景 subagent（run_in_background: false）',
    name: 'subagent',
    args: { description: '幹活', subagent_type: 'worker', run_in_background: false },
    background: true,
    mode: 'one-shot',
  },
  {
    label: '背景 subagent',
    name: 'subagent',
    args: { description: '幹活', subagent_type: 'worker', run_in_background: true },
    background: true,
    mode: 'continuable',
  },
] as const;
type Case = (typeof CASES)[number];

/** 子代理：叫一次工具再收尾，日誌上才有它自己的 `tool/call`（那一顆的 `callId` 不是父的）。 */
function workerPlugin(): PluginEntry {
  return {
    plugin: {
      name: 'worker-host',
      apply(registry) {
        registry.subagents.register({
          name: 'worker',
          description: '幹活的。',
          systemPrompt: '你是 worker。',
          model: new ScriptedChatModel({
            turns: [
              { content: '', toolCalls: [{ name: 'noop', id: 'inner-call', args: {} }] },
              { content: '做完' },
            ],
          }) as never,
        });
        registry.tools.register(
          tool(() => '好', { name: 'noop', description: '什麼都不做。', schema: z.object({}) }),
        );
      },
    },
  };
}

function rootTurns(entry: Case, warmup: boolean): ScriptedTurn[] {
  return [
    // 前面先開一輪，判準才分得出「那一輪」是第二輪，不是檔頭第一顆 `turn/start`。
    ...(warmup ? [{ content: '先聊聊。' }] : []),
    { content: '委派。', toolCalls: [{ name: entry.name, id: 'root-call', args: entry.args }] },
    { content: '根收尾' },
    // 背景那條在結算之後還會排一輪續行；前景用不到這一輪。
    { content: '收到結算' },
  ];
}

async function build(entry: Case, root: string, warmup = false) {
  return createNexusAgent({
    model: new ScriptedChatModel({ turns: rootTurns(entry, warmup) }),
    checkpointer: new MemorySaver(),
    plugins: [workerPlugin()],
    backend: new ContainedFilesystemBackend({ rootDir: root, mode: 'workspace-write' }),
    ...(entry.background && { backgroundSubagents: {} }),
    onInvariantViolation: (error) => reported.push(`不變量：${error.message}`),
  });
}

/** 子代理那一份寫到收尾（前景跑完就是；背景的要等它自己那一輪收掉）。 */
function childDone(sessions: SessionRegistry): boolean {
  return sessions
    .list()
    .some(
      (each) =>
        each.address.kind === 'subagent' &&
        each.log.events.some(
          (event) => event.type === 'assistant/message' && JSON.stringify(event).includes('做完'),
        ),
    );
}

/** 真的組裝＋pump＋JSONL 落盤跑一次，讀回磁碟上的每一份。 */
async function runAndRead(entry: Case): Promise<readonly LoadedSessionLog[]> {
  const workspace = join(dir, 'workspace');
  const store = createJsonlSessionStore({ rootDir: join(dir, 'logs') });
  const built = await build(entry, workspace, true);
  const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'link-root');
  const detach = built.attachSession(pump.sessions);
  const persistence = attachSessionPersistence(pump.sessions, store);
  try {
    await pump.submit({ kind: 'message', text: '你好' });
    await pump.whenIdle();
    await pump.submit({ kind: 'message', text: '委派' });
    await pump.whenIdle();
    await until(() => childDone(pump.sessions));
  } finally {
    await persistence.dispose();
    detach();
    await built.dispose();
  }
  const { logs, unreadable } = await readSessionLogs([store.directory]);
  expect(unreadable).toEqual([]);
  return logs;
}

function eventAt(events: readonly SessionEvent[], seq: number | undefined): SessionEvent {
  const found = events.find((event) => event.seq === seq);
  if (found === undefined) throw new Error(`日誌上沒有 seq ${String(seq)}`);
  return found;
}

describe.each(CASES)('$label：落盤的日誌兩個方向都接得回去', (entry) => {
  it('子 → 父：header 的 parentSession 打開父日誌，解出派它的那一顆呼叫與那一輪；父 → 子：callId 找得到那一份子日誌', async () => {
    const logs = await runAndRead(entry);
    const children = logs.filter((log) => log.header.parentSession !== undefined);
    expect(children).toHaveLength(1);
    const child = children[0]!;

    // 子 → 父：只從子那一頭出發。
    const parent = logs.find((log) => log.header.id === child.header.parentSession);
    expect(parent).toBeDefined();
    const link = subagentLinkOf(parent!.events, child.header.id);
    expect(link).toMatchObject({ callId: 'root-call', mode: entry.mode });
    const call = eventAt(parent!.events, link?.callSeq);
    expect(call).toMatchObject({
      type: 'tool/call',
      data: { callId: 'root-call', name: entry.name },
    });
    // 那一輪：派它的那一輪起頭的 `turn/start`，是第二輪（人說「委派」那一輪），不是第一輪。
    const turnStart = eventAt(parent!.events, link?.turnSeq);
    expect(turnStart).toMatchObject({
      type: 'turn/start',
      data: { kind: 'message', text: '委派' },
    });
    const turnStarts = parent!.events.filter(
      (event) => event.type === 'turn/start' && event.seq < call.seq,
    );
    expect(turnStarts.at(-1)?.seq).toBe(turnStart.seq);

    // 父 → 子：從那顆 `tool/call` 的 `callId` 出發，目錄指到的就是一份讀得到的子日誌。
    const forCall = subagentLinks(parent!.events).filter((each) => each.callId === 'root-call');
    expect(forCall.map((each) => each.childId)).toEqual([child.header.id]);
    expect(logs.some((log) => log.header.id === forCall[0]?.childId)).toBe(true);

    // 離線掃描的報表兩頭都印出來。
    const text = formatScanReport(
      logs.map((log) => scanSessionLog(log)),
      [],
      { threshold: 5 },
    ).join('\n');
    expect(text).toContain(
      `派它的 呼叫 root-call（tool/call #${call.seq}）｜那一輪 turn/start #${turnStart.seq}`,
    );
    expect(text).toContain(`派出 ${child.header.id}（${entry.mode}）← 呼叫 root-call`);
    expect(reported).toEqual([]);
  }, 30000);
});

/** 折出來的那張派它的卡。 */
function delegationCard(state: ConversationState): ToolEntry | undefined {
  return state.entries.find(
    (each): each is ToolEntry => each.kind === 'tool' && each.callId === 'root-call',
  );
}

/**
 * 卡上兩組新欄位並存（#1041 的條目時刻與本卡的子會話）：收掉的卡兩個時刻都在、有先後，子會話也在。
 * 時刻的規則本身由 #1041 的 `wire-entry-timestamps.test.ts` 量，這裡只證明目錄那顆 frame 沒有把它們弄丟或改寫成別的形狀。
 */
function expectBoth(found: ToolEntry | undefined, session: ToolEntry['subagentSession']): void {
  expect(found?.status).toBe('done');
  expect(found?.subagentSession).toEqual(session);
  expect(typeof found?.startedAt).toBe('number');
  expect(typeof found?.settledAt).toBe('number');
  expect(found!.settledAt!).toBeGreaterThanOrEqual(found!.startedAt!);
}

describe.each(CASES)('$label：wire 的工具卡帶著子會話，重新整理與重開之後都還在', (entry) => {
  it('即時、歷史、只剩磁碟那一份的歷史，三處折出來的卡都指到同一份子會話', async () => {
    const workspace = join(dir, 'workspace');
    const store = createJsonlSessionStore({ rootDir: join(dir, 'logs') });
    const built = await build(entry, workspace);
    let sessions: SessionRegistry | undefined;
    const handler = createWireHandler({
      auth: TEST_BROWSER_AUTH,
      warn: (message) => reported.push(`handler：${message}`),
      createAgent: async () => ({
        agent: built.agent as unknown as PumpAgent,
        commands: emptyCommandPoint(),
        dispose: () => built.dispose(),
        attachSessions: composeAttachSessions(built),
        attachPersistence: (registry) => {
          sessions = registry;
          return attachSessionPersistence(registry, store);
        },
      }),
    });
    opened.push(handler);
    const client = createWireClient({
      baseUrl: 'http://link.test',
      fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
    });

    const frames: Event[] = [];
    const line = new AbortController();
    const stream = await client.openEvents('t1', { signal: line.signal });
    const draining = (async () => {
      try {
        for await (const frame of stream) frames.push(frame);
      } catch {
        // 中止收線。
      }
    })();
    await client.runStart('t1', '委派');
    await until(() => sessions !== undefined && childDone(sessions));
    await until(
      () => delegationCard(reduceAll(emptyConversation(), frames))?.subagentSession !== undefined,
    );
    const live = delegationCard(reduceAll(emptyConversation(), frames))?.subagentSession;
    // 即時那條：等卡收掉，再看兩組欄位並存。
    await until(() => delegationCard(reduceAll(emptyConversation(), frames))?.status === 'done');
    expectBoth(delegationCard(reduceAll(emptyConversation(), frames)), live);
    line.abort();
    await draining;

    // 子會話的 id 從註冊表那一頭讀，不手組。
    const childId = sessions!.list().find((each) => each.address.kind === 'subagent')
      ?.log.sessionId;
    expect(live).toEqual({ id: childId, mode: entry.mode });

    // 重新整理：歷史路由讀日誌那一份。
    const page = await client.threadHistory('t1');
    if (page.kind !== 'ok') throw new Error(page.message);
    const refreshed = delegationCard(reduceAll(emptyConversation(), page.result.events));
    expect(refreshed?.subagentSession).toEqual(live);
    expectBoth(refreshed, live);

    // 重開：收掉這個行程，只剩磁碟上那一份，交給新的 handler 當 seed 再讀一次歷史。
    opened.splice(opened.indexOf(handler), 1);
    await handler.close();
    const { logs } = await readSessionLogs([store.directory]);
    const rootSeed = logs.find((log) => log.header.id === 't1')?.events;
    expect(rootSeed?.some((event) => event.type === 'subagent/catalog')).toBe(true);
    const rebuilt = await build(entry, workspace);
    const reopened = createWireHandler({
      auth: TEST_BROWSER_AUTH,
      warn: (message) => reported.push(`handler：${message}`),
      createAgent: async () => ({
        agent: rebuilt.agent as unknown as PumpAgent,
        commands: emptyCommandPoint(),
        dispose: () => rebuilt.dispose(),
        attachSessions: composeAttachSessions(rebuilt),
        rootSeed: rootSeed ?? [],
      }),
    });
    opened.push(reopened);
    const again = createWireClient({
      baseUrl: 'http://link.test',
      fetch: async (input, init) => reopened.handle(loopbackRequest(input as string, init)),
    });
    const replayed = await again.threadHistory('t1');
    if (replayed.kind !== 'ok') throw new Error(replayed.message);
    const reopenedCard = delegationCard(reduceAll(emptyConversation(), replayed.result.events));
    expect(reopenedCard?.subagentSession).toEqual(live);
    expectBoth(reopenedCard, live);
    // 兩次歷史讀的是同一份日誌：時刻一樣。
    expect([reopenedCard?.startedAt, reopenedCard?.settledAt]).toEqual([
      refreshed?.startedAt,
      refreshed?.settledAt,
    ]);
    expect(reported).toEqual([]);
  }, 30000);
});

describe.each(CASES)('$label：子日誌記不記得它收到的那一句話', (entry) => {
  it(
    entry.background && entry.mode === 'continuable'
      ? '背景：輸入由 turn/start 記，子日誌不多出 user/message'
      : '前景：出生就記一顆來源 user 的 user/message，落在它的第一次叫模型與叫工具之前，照日誌推得出同一句',
    async () => {
      const logs = await runAndRead(entry);
      const child = logs.find((log) => log.header.parentSession !== undefined)!;
      const inputs = child.events.filter((event) => event.type === 'user/message');
      if (entry.mode === 'continuable') {
        expect(inputs).toEqual([]);
        expect(child.events.some((event) => event.type === 'turn/start')).toBe(true);
      } else {
        // 刻意只認一顆：目錄與 `tool/call` 之外，子日誌不該有第二個地方記這句話。
        expect(inputs).toHaveLength(1);
        expect(inputs[0]).toMatchObject({
          data: { source: { kind: 'user' }, message: { data: { content: '幹活' } } },
        });
        const at = child.events.indexOf(inputs[0]!);
        const firstWork = child.events.findIndex(
          (event) => event.type === 'model/start' || event.type === 'tool/call',
        );
        expect(firstWork).toBeGreaterThan(at);
        // 照日誌推這個子代理第一次叫模型的歷史，開頭就是那一句話。
        const replayed = replayConversation(child.events.slice(0, firstWork));
        expect(replayed.kind).toBe('replayed');
        if (replayed.kind === 'replayed') {
          expect(replayed.messages.map((message) => [message.getType(), message.content])).toEqual([
            ['human', '幹活'],
          ]);
        }
      }
      expect(reported).toEqual([]);
    },
    30000,
  );
});
