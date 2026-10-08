/**
 * **用量投影走真的產品組裝**——[#1028](https://github.com/DemianLi/nexus-agent/issues/1028) 的驗收。
 *
 * 真的 `createNexusAgent`＋`createWireHandler`＋JSONL 落盤，掛 `@nexus/plugin-token-meter`；前景（`task`、`subagent` 帶
 * `run_in_background: false`）與背景子代理各跑一輪。量四件事：
 *
 * 1. **即時 = 歷史 = 重開之後**：root 的 `projections['token-meter']` 與每個子代理的 `subagentProjections[runId]['token-meter']`，
 *    三處折出來是同一份（重開時 root 的 seed 與子日誌的冷讀都經 #1073 的通道）。
 * 2. **子代理分列、連得回去**：子代理的數字在它自己那一格（步數、用量、依名的工具次數），root 的 `links` 指得到它（`runId`、`callId`、`mode`）。
 * 3. **不另造總帳**：root 這份的逐輪加總跟 web 已有的 `tokenUsage`／`sessionStats` frame 逐項對得上。
 * 4. **失敗那一列是真的進帳**：失敗呼叫由真的 `createLiveModel` 對假 SSE 端點產生，不是手寫進日誌——拿掉 #1022 的失敗進帳，這一條會紅。
 *
 * 規則與手算的數字在 `packages/nexus-plugin-token-meter/src/fold.test.ts`。
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { attachSessionPersistence } from '@nexus/core';
import type { PluginEntry, SessionRegistry } from '@nexus/core';
import { createTokenMeterPlugin, tokenMeterUnit } from '@nexus/plugin-token-meter';
import {
  createWireClient,
  emptyConversation,
  reduceAll,
  TOKEN_METER_PROJECTION,
} from '@nexus/wire';
import type { ConversationState, Event, TokenMeterView } from '@nexus/wire';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { readSessionLogs } from './eval/session-scan.js';
import { readStoredSubagentSession } from './session-list.js';
import { emptyCommandPoint, loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import { createJsonlSessionStore } from './jsonl-session-store.js';
import { createLiveModel, LIVE_API_KEY_ENV } from './live-model.js';
import { ScriptedChatModel } from './scripted-model.js';
import { composeAttachSessions } from './session-attach.js';
import { liveModelConfigSchema } from './settings/live-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';
import type { WireHandler } from './wire-handler.js';

let dir: string;
const opened: WireHandler[] = [];
let reported: string[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-token-meter-'));
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

/** 子代理：叫兩次工具再收尾，每次呼叫都報用量。 */
function hostPlugin(): PluginEntry {
  return {
    plugin: {
      name: 'meter-host',
      apply(registry) {
        registry.subagents.register({
          name: 'worker',
          description: '幹活的。',
          systemPrompt: '你是 worker。',
          model: new ScriptedChatModel({
            turns: [
              {
                content: '',
                toolCalls: [{ name: 'noop', id: 'inner-1', args: {} }],
                usage: { inputTokens: 50, outputTokens: 5 },
              },
              {
                content: '',
                toolCalls: [{ name: 'noop', id: 'inner-2', args: {} }],
                usage: { inputTokens: 60, outputTokens: 6 },
              },
              { content: '做完', usage: { inputTokens: 70, outputTokens: 7 } },
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

async function build(entry: Case) {
  return createNexusAgent({
    model: new ScriptedChatModel({
      turns: [
        {
          content: '委派。',
          toolCalls: [{ name: entry.name, id: 'root-call', args: entry.args }],
          usage: { inputTokens: 100, outputTokens: 10 },
        },
        { content: '根收尾', usage: { inputTokens: 120, outputTokens: 20 } },
        { content: '收到結算', usage: { inputTokens: 140, outputTokens: 5 } },
      ],
    }),
    checkpointer: new MemorySaver(),
    plugins: [hostPlugin(), createTokenMeterPlugin()],
    backend: new ContainedFilesystemBackend({
      rootDir: join(dir, 'workspace'),
      mode: 'workspace-write',
    }),
    ...(entry.background && { backgroundSubagents: {} }),
  });
}

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

const meterOf = (state: ConversationState): TokenMeterView | undefined =>
  state.projections[TOKEN_METER_PROJECTION]?.view as TokenMeterView | undefined;
const childMeterOf = (state: ConversationState, runId: string): TokenMeterView | undefined =>
  state.subagentProjections[runId]?.[TOKEN_METER_PROJECTION]?.view as TokenMeterView | undefined;

describe.each(CASES)('$label：用量投影', (entry) => {
  it('子代理分列且連得回去；即時 = 歷史 = 重開之後；root 對得上既有的總帳', async () => {
    const store = createJsonlSessionStore({ rootDir: join(dir, 'logs') });
    const built = await build(entry);
    let sessions: SessionRegistry | undefined;
    const handler = createWireHandler({
      auth: TEST_BROWSER_AUTH,
      warn: (message) => reported.push(message),
      createAgent: async () => ({
        agent: built.agent as unknown as PumpAgent,
        commands: emptyCommandPoint(),
        projections: built.projections,
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
      baseUrl: 'http://meter.test',
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
    const address = sessions!.list().find((each) => each.address.kind === 'subagent')?.address;
    if (address?.kind !== 'subagent') throw new Error('沒有子代理');
    const runId = address.runId;
    const history = async () => {
      const page = await client.threadHistory('t1');
      if (page.kind !== 'ok') throw new Error(page.message);
      return reduceAll(emptyConversation(), page.result.events);
    };
    // 背景那條在結算之後還會排一輪續行：等到 root 的最後一輪收尾、而且即時追上歷史。
    const settled = (state: ConversationState) =>
      meterOf(state)?.turns.at(-1)?.end !== undefined &&
      childMeterOf(state, runId)?.session.steps === 3;
    await until(() => settled(reduceAll(emptyConversation(), frames)));
    let refreshed = await history();
    for (let tries = 0; tries < 200; tries += 1) {
      const live = reduceAll(emptyConversation(), frames);
      if (
        JSON.stringify(live.projections) === JSON.stringify(refreshed.projections) &&
        JSON.stringify(live.subagentProjections) === JSON.stringify(refreshed.subagentProjections)
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      refreshed = await history();
    }
    line.abort();
    await draining;
    const live = reduceAll(emptyConversation(), frames);

    // 1. 即時 = 歷史。
    expect(live.projections).toEqual(refreshed.projections);
    expect(live.subagentProjections).toEqual(refreshed.subagentProjections);

    // 2. 子代理在自己那一格：三次呼叫（50/5、60/6、70/7）、兩次 noop。
    //    前景子代理的日誌沒有 `turn/start`（全在 outside）；背景的有（實測：派出去那句開一輪），那一輪的數字就是整份。
    const child = childMeterOf(live, runId)!;
    if (entry.mode === 'one-shot') {
      expect(child.turns).toEqual([]);
      expect(child.session).toEqual(child.outside);
    } else {
      expect(child.turns).toHaveLength(1);
      expect(child.turns[0]).toMatchObject({ steps: 3, toolCalls: 2, end: 'completed' });
      expect(child.outside.steps).toBe(0);
    }
    expect(child.session).toMatchObject({
      steps: 3,
      unknownSteps: 0,
      inputTokens: 50 + 60 + 70,
      outputTokens: 5 + 6 + 7,
      toolCalls: 2,
      toolErrors: 0,
    });
    expect(child.session.tools).toEqual([{ name: 'noop', calls: 2, errors: 0 }]);
    // root 的 links 連得回去：runId、派它的 callId、前景或背景。
    const root = meterOf(live)!;
    expect(root.links).toEqual([{ runId, callId: 'root-call', mode: entry.mode, turn: 0 }]);
    // 子代理的 token 不在 root 的帳裡（各折各的）；root 有它自己的呼叫。
    expect(root.session.inputTokens).toBeGreaterThanOrEqual(100 + 120);
    expect(root.session.inputTokens).toBe(
      root.turns.reduce((n, turn) => n + turn.inputTokens, 0) + root.outside.inputTokens,
    );

    // 3. 不另造總帳：root 逐項對得上 web 已有的 tokenUsage／sessionStats。
    // 總帳的 inputTokens 是未快取那桶，對的是用量投影的 uncachedInputTokens（這條路徑的假端點不報快取，兩桶相等）。
    expect(live.tokenUsage).toEqual({
      inputTokens: root.session.uncachedInputTokens,
      uncachedInputTokens: root.session.uncachedInputTokens,
      outputTokens: root.session.outputTokens,
    });
    expect(live.sessionStats).toMatchObject({
      steps: root.session.steps,
      llmMs: root.session.modelMs + root.session.retryWaitMs,
      toolMs: root.session.toolSumMs,
    });
    // 三段時間不重疊：殘差不為負（負的代表前提被破壞）。
    for (const turn of root.turns) {
      if (turn.unaccountedMs !== undefined) expect(turn.unaccountedMs).toBeGreaterThanOrEqual(0);
    }

    // 4. 重開：只剩磁碟上那一份；root 的 seed 與子日誌的冷讀經 #1073 的通道，折出同一份。
    opened.splice(opened.indexOf(handler), 1);
    await handler.close();
    const { logs } = await readSessionLogs([store.directory]);
    const rootSeed = logs.find((log) => log.header.id === 't1')?.events;
    const rebuilt = await build(entry);
    const reopened = createWireHandler({
      auth: TEST_BROWSER_AUTH,
      warn: (message) => reported.push(message),
      // 產品路徑的冷讀（serve.ts 接的就是這一個），不是替身：前景的 runId 真的讀得到嗎，在這裡才量得到。
      readSubagentSession: (thread, each) => readStoredSubagentSession(store, thread, each),
      createAgent: async () => ({
        agent: rebuilt.agent as unknown as PumpAgent,
        commands: emptyCommandPoint(),
        projections: rebuilt.projections,
        dispose: () => rebuilt.dispose(),
        attachSessions: composeAttachSessions(rebuilt),
        rootSeed: rootSeed ?? [],
      }),
    });
    opened.push(reopened);
    const again = createWireClient({
      baseUrl: 'http://meter.test',
      fetch: async (input, init) => reopened.handle(loopbackRequest(input as string, init)),
    });
    const replayed = await again.threadHistory('t1');
    if (replayed.kind !== 'ok') throw new Error(replayed.message);
    const reread = reduceAll(emptyConversation(), replayed.result.events);
    expect(reread.projections).toEqual(refreshed.projections);
    expect(reread.subagentProjections).toEqual(refreshed.subagentProjections);
    expect(reported).toEqual([]);
  }, 30000);
});

// ── 失敗那一列是真的進帳 ──────────────────────────────────────────────────────────────

describe('失敗的呼叫：真的 createLiveModel 對假 SSE 端點', () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  let savedKey: string | undefined;

  beforeEach(async () => {
    savedKey = process.env[LIVE_API_KEY_ENV];
    process.env[LIVE_API_KEY_ENV] = 'fake-key-for-loopback';
    server = createServer((req, res) => {
      req.on('data', () => undefined);
      req.on('end', () => {
        const chunk = (extra: Record<string, unknown>) =>
          `data: ${JSON.stringify({ id: 'chatcmpl-x', object: 'chat.completion.chunk', created: 0, model: 'fake', ...extra })}\n\n`;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }));
        res.write(
          chunk({ choices: [{ index: 0, delta: { content: '說到一半' }, finish_reason: null }] }),
        );
        // 供應商報了用量，之後斷線：這一筆 token 真的花掉了。
        res.write(
          chunk({
            choices: [],
            usage: { prompt_tokens: 321, completion_tokens: 45, total_tokens: 400 },
          }),
        );
        setTimeout(() => res.socket?.destroy(), 60);
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterEach(async () => {
    if (savedKey === undefined) delete process.env[LIVE_API_KEY_ENV];
    else process.env[LIVE_API_KEY_ENV] = savedKey;
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });

  it('斷線的那一次：用量投影的失敗列有 321／45，總計含它，與 tokenUsage 總帳同數', async () => {
    const built = await createNexusAgent({
      model: createLiveModel(liveModelConfigSchema.parse({ baseUrl, maxRetries: 0 })),
      checkpointer: new MemorySaver(),
      plugins: [createTokenMeterPlugin()],
    });
    const pump = new ThreadPump(
      built.agent as unknown as PumpAgent,
      'meter-failed',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      built.projections.list(),
    );
    const detach = built.attachSession(pump.sessions);
    try {
      await pump.submit({ kind: 'message', text: '說點什麼' }).catch(() => undefined);
      await until(() => pump.sessionLog.events.some((event) => event.type === 'turn/failed'));
      let state = tokenMeterUnit.init();
      for (const event of pump.sessionLog.events) state = tokenMeterUnit.apply(state, event);
      const view = tokenMeterUnit.view(state);
      expect(view.turns).toHaveLength(1);
      expect(view.turns[0]).toMatchObject({
        end: 'failed',
        steps: 1,
        failedSteps: 1,
        unknownSteps: 0,
        inputTokens: 321,
        outputTokens: 45,
        failedInputTokens: 321,
        failedOutputTokens: 45,
      });
      // 對帳：同一份日誌上，既有的總帳也含這一筆。
      expect(view.session.inputTokens).toBe(321);
    } finally {
      detach();
      await built.dispose();
    }
  }, 30000);
});
