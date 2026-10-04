/**
 * **軌跡投影展開子代理**——[#1070](https://github.com/DemianLi/nexus-agent/issues/1070) 的驗收。
 *
 * 真的 `createNexusAgent`＋`createWireHandler`＋JSONL 落盤，掛 `@nexus/plugin-trajectory`；前景（`task`、`subagent` 帶
 * `run_in_background: false`）與背景子代理各跑一輪。量三件事：
 *
 * 1. **即時 = 歷史 = 重開之後**：root 的 `projections` 與每個子代理的 `subagentProjections[runId]`（軌跡與請求快照兩個單元），
 *    三處折出來是同一份。
 * 2. **子代理在自己那一格、連得回去**：前景子代理的日誌沒有 `turn/start`，軌跡從第一次模型呼叫開一輪 `run`（沒有 `end`）；
 *    背景的有，是一般的一輪。root 的軌跡上，派它的那顆工具帶 `subagent` 連結指到 `runId`。
 * 3. **快照跟著子代理折**：子代理每次呼叫上記的 `system`／`header` 在它自己的 `request-snapshots` 裡找得到。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { attachSessionPersistence } from '@nexus/core';
import type { PluginEntry, SessionRegistry } from '@nexus/core';
import { createTrajectoryPlugin } from '@nexus/plugin-trajectory';
import {
  createWireClient,
  emptyConversation,
  reduceAll,
  REQUEST_SNAPSHOTS_PROJECTION,
  TRAJECTORY_PROJECTION,
} from '@nexus/wire';
import type { ConversationState, Event, RequestSnapshotsView, TrajectoryView } from '@nexus/wire';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { readSessionLogs } from './eval/session-scan.js';
import { readStoredSubagentSession } from './session-list.js';
import { emptyCommandPoint, loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import { createJsonlSessionStore } from './jsonl-session-store.js';
import { ScriptedChatModel } from './scripted-model.js';
import { composeAttachSessions } from './session-attach.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';
import type { WireHandler } from './wire-handler.js';

let dir: string;
const opened: WireHandler[] = [];
let reported: string[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-trajectory-sub-'));
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
    plugins: [hostPlugin(), createTrajectoryPlugin()],
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

const trajectoryOf = (state: ConversationState): TrajectoryView | undefined =>
  state.projections[TRAJECTORY_PROJECTION]?.view as TrajectoryView | undefined;
const childTrajectoryOf = (state: ConversationState, runId: string): TrajectoryView | undefined =>
  state.subagentProjections[runId]?.[TRAJECTORY_PROJECTION]?.view as TrajectoryView | undefined;
const childSnapshotsOf = (
  state: ConversationState,
  runId: string,
): RequestSnapshotsView | undefined =>
  state.subagentProjections[runId]?.[REQUEST_SNAPSHOTS_PROJECTION]?.view as
    RequestSnapshotsView | undefined;

describe.each(CASES)('$label：軌跡投影', (entry) => {
  it('子代理有自己的軌跡與快照、連得回去；即時 = 歷史 = 重開之後', async () => {
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
      baseUrl: 'http://trajectory.test',
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
    // 背景那條在結算之後還會排一輪續行：等到 root 的最後一輪收尾、而且子代理的三次呼叫都進了。
    const settled = (state: ConversationState) =>
      trajectoryOf(state)?.turns.at(-1)?.end !== undefined &&
      childTrajectoryOf(state, runId)?.turns.at(-1)?.callCount === 3;
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

    // 1. 即時 = 歷史（root 與每個子代理，軌跡與快照兩個單元）。
    expect(live.projections).toEqual(refreshed.projections);
    expect(live.subagentProjections).toEqual(refreshed.subagentProjections);

    // 2. 子代理在自己那一格：三次呼叫、兩個 noop。前景的日誌沒有 `turn/start`，開的是 `run`，沒有 `end`；背景的有。
    const child = childTrajectoryOf(live, runId)!;
    expect(child.turns).toHaveLength(1);
    const turn = child.turns[0]!;
    expect(turn).toMatchObject({ callCount: 3, toolCount: 2, toolErrors: 0, unattributed: 0 });
    if (entry.mode === 'one-shot') {
      expect(turn).toMatchObject({ kind: 'run', logical: true });
      expect(turn).not.toHaveProperty('end');
    } else {
      expect(turn.kind).not.toBe('run');
      expect(turn.end).toBe('completed');
    }
    expect(turn.calls.flatMap((each) => each.tools.map((tool) => tool.name))).toEqual([
      'noop',
      'noop',
    ]);
    // root 自己的軌跡不含子代理的呼叫（各折各的），而且派它的那顆工具帶連結指到這個 runId。
    const root = trajectoryOf(live)!;
    expect(root.turns.every((each) => each.kind !== 'run')).toBe(true);
    const links = root.turns
      .flatMap((each) => each.calls)
      .flatMap((each) => each.tools)
      .flatMap((tool) => (tool.subagent === undefined ? [] : [tool.subagent]));
    expect(links.map((link) => [link.runId, link.mode])).toEqual([[runId, entry.mode]]);
    expect(links.map((link) => link.childId)).toEqual([`t1/${runId}`]);

    // 3. 快照跟著子代理折：子代理每次呼叫上記的 `system`／`header` 在它自己的快照裡。
    const snapshots = childSnapshotsOf(live, runId)!;
    expect(snapshots.system.length).toBeGreaterThanOrEqual(1);
    for (const each of turn.calls) {
      expect(snapshots.system.map((snapshot) => snapshot.seq)).toContain(each.system);
      expect(snapshots.header.map((snapshot) => snapshot.seq)).toContain(each.header);
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
      baseUrl: 'http://trajectory.test',
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
