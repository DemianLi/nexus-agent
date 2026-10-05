/**
 * **軌跡按需拉一個邏輯輪**——[#1083](https://github.com/DemianLi/nexus-agent/issues/1083) 第一刀（通道）的驗收。
 *
 * 真的 `createNexusAgent`＋`createWireHandler`＋JSONL 落盤＋`createWireClient`，掛 `@nexus/plugin-trajectory`，前景與背景子代理各跑一輪。量：
 *
 * 1. **拉到的 = 推送的**：用 `seq`、用 `messageId` 拉 root 的那一輪，與下行 `projection` frame 折出來的同一輪逐欄相同；
 *    子代理用 `runId` 拉，與 `subagentProjections[runId]` 的那一輪相同。
 * 2. **重開之後一樣**：關掉 handler、只剩磁碟，重開後再拉（子代理走冷讀）得到同一份。
 * 3. **失敗有碼有原因**：`invalid_argument`／`turn_not_found`／`subagent_not_found`；沒掛軌跡投影是 `not_supported`。
 * 4. 並行請求互不干擾。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { attachSessionPersistence } from '@nexus/core';
import type { PluginEntry, SessionRegistry } from '@nexus/core';
import { createTrajectoryPlugin } from '@nexus/plugin-trajectory';
import { createWireClient, emptyConversation, reduceAll, TRAJECTORY_PROJECTION } from '@nexus/wire';
import type { ConversationState, Event, TrajectoryView } from '@nexus/wire';
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

function clientOf(handler: WireHandler) {
  return createWireClient({
    baseUrl: 'http://trajectory.test',
    fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
  });
}

function agentOf(built: Awaited<ReturnType<typeof build>>) {
  return {
    agent: built.agent as unknown as PumpAgent,
    commands: emptyCommandPoint(),
    projections: built.projections,
    dispose: () => built.dispose(),
    attachSessions: composeAttachSessions(built),
  };
}

describe.each(CASES)('$label：按需拉軌跡', (entry) => {
  it('拉到的 = 推送的；重開之後一樣；失敗有碼有原因', async () => {
    const store = createJsonlSessionStore({ rootDir: join(dir, 'logs') });
    const built = await build(entry);
    let sessions: SessionRegistry | undefined;
    const handler = createWireHandler({
      auth: TEST_BROWSER_AUTH,
      warn: (message) => reported.push(message),
      createAgent: async () => ({
        ...agentOf(built),
        attachPersistence: (registry) => {
          sessions = registry;
          return attachSessionPersistence(registry, store);
        },
      }),
    });
    opened.push(handler);
    const client = clientOf(handler);
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
    const settled = (state: ConversationState) =>
      trajectoryOf(state)?.turns.at(-1)?.end !== undefined &&
      (
        childTrajectoryOf(state, runId)?.turns.at(-1) ??
        childTrajectoryOf(state, runId)?.digests.at(-1)
      )?.callCount === 3;
    await until(() => settled(reduceAll(emptyConversation(), frames)));
    // 背景那條結算後還會續行一輪；等 frame 停下來再拿推送的值當對照。
    let previous = '';
    for (let tries = 0; tries < 200; tries += 1) {
      const now = JSON.stringify(reduceAll(emptyConversation(), frames).projections);
      if (now === previous) break;
      previous = now;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    line.abort();
    await draining;
    const live = reduceAll(emptyConversation(), frames);
    const root = trajectoryOf(live)!;
    const child = childTrajectoryOf(live, runId)!;

    const pull = async (
      target: ReturnType<typeof clientOf>,
      query: Parameters<ReturnType<typeof clientOf>['trajectoryTurn']>[1],
    ) => {
      const outcome = await target.trajectoryTurn('t1', query);
      if (outcome.kind !== 'ok') throw new Error(`${outcome.code}：${outcome.message}`);
      return outcome.result;
    };

    // 1. 拉到的 = 推送的。推送的投影只有骨架（#1083）：最新一個實體輪帶完整結構，其餘是摘要。
    //    最新那一輪：拉到的與推送的逐欄相同；更早的：拉到的與摘要的骨架欄位相同。
    const latest = root.turns.at(-1)!;
    const pulledLatest = await pull(client, { seq: latest.seq });
    expect(pulledLatest.turns.find((each) => each.seq === latest.seq)).toEqual(latest);
    const first = (root.digests[0] ?? root.turns[0])!;
    const bySeq = await pull(client, { seq: first.seq });
    expect(bySeq.turns[0]).toMatchObject({ logical: true });
    expect(bySeq.turns[0]).toMatchObject({
      index: first.index,
      seq: first.seq,
      kind: first.kind,
      callCount: first.callCount,
      toolCount: first.toolCount,
      subagentCount: first.subagentCount,
    });
    // 每個摘要都能原位換成拉到的那一輪（index、seq 對得上）。
    for (const digest of root.digests) {
      const group = await pull(client, { seq: digest.seq });
      expect(group.turns.map((each) => each.index)).toContain(digest.index);
    }
    // messageId：拉到的呼叫上某次回覆的訊息 id，與 seq 拉到同一個邏輯輪。
    const messageId = bySeq.turns
      .flatMap((each) => each.calls)
      .find((each) => each.reply?.messageId !== undefined)?.reply?.messageId;
    expect(messageId).toBeDefined();
    const byMessage = await pull(client, { messageId });
    expect(byMessage.turns).toEqual(bySeq.turns);
    // 子代理：只給 runId＝它的第一個邏輯輪；前景只有一輪 `run`（推送的只有摘要）。
    const bySubagent = await pull(client, { runId });
    const pushedChild = child.turns.at(-1) ?? child.digests.at(-1)!;
    expect(bySubagent.turns[0]).toMatchObject({
      index: pushedChild.index,
      seq: pushedChild.seq,
      callCount: pushedChild.callCount,
      toolCount: pushedChild.toolCount,
    });
    // 並行請求互不干擾、結果與單獨拉的相同。
    const [a, b, c] = await Promise.all([
      pull(client, { seq: first.seq }),
      pull(client, { runId }),
      pull(client, { messageId }),
    ]);
    expect(a).toEqual(bySeq);
    expect(b).toEqual(bySubagent);
    expect(c).toEqual(byMessage);

    // 3. 失敗有碼有原因。
    const rejected = async (query: Parameters<typeof client.trajectoryTurn>[1]) => {
      const outcome = await client.trajectoryTurn('t1', query);
      if (outcome.kind !== 'rejected') throw new Error('應該被拒');
      expect(outcome.message).toMatch(/[\u4e00-\u9fff]/u);
      return outcome.code;
    };
    expect(await rejected({})).toBe('invalid_argument');
    expect(await rejected({ seq: 1, messageId: 'x' })).toBe('invalid_argument');
    expect(await rejected({ seq: 9_999_999 })).toBe('turn_not_found');
    expect(await rejected({ messageId: '不存在的回覆' })).toBe('turn_not_found');
    expect(await rejected({ runId: 'nope' })).toBe('subagent_not_found');
    expect(await rejected({ runId: '../t2/x' })).toBe('subagent_not_found');
    expect(await rejected({ runId: 'bg-000000000000' })).toBe('subagent_not_found');

    // 2. 重開：只剩磁碟，子代理走冷讀。
    opened.splice(opened.indexOf(handler), 1);
    await handler.close();
    const { logs } = await readSessionLogs([store.directory]);
    const rootSeed = logs.find((log) => log.header.id === 't1')?.events;
    const rebuilt = await build(entry);
    const reopened = createWireHandler({
      auth: TEST_BROWSER_AUTH,
      warn: (message) => reported.push(message),
      readSubagentSession: (thread, each) => readStoredSubagentSession(store, thread, each),
      createAgent: async () => ({ ...agentOf(rebuilt), rootSeed: rootSeed ?? [] }),
    });
    opened.push(reopened);
    const again = clientOf(reopened);
    // `seq` 是折疊時日誌的最後位置，重開時日誌可能多了一顆（重建 agent 寫的），所以比 `turns`，`seq` 只要不倒退。
    for (const [query, before] of [
      [{ seq: first.seq }, bySeq],
      [{ messageId }, byMessage],
      [{ runId }, bySubagent],
    ] as const) {
      const after = await pull(again, query);
      expect(after.turns).toEqual(before.turns);
      expect(after.seq).toBeGreaterThanOrEqual(before.seq);
    }
    expect(reported).toEqual([]);
  }, 30000);
});

describe('沒掛軌跡投影', () => {
  it('回 not_supported，原因說得出', async () => {
    const built = await createNexusAgent({
      model: new ScriptedChatModel({ turns: [{ content: '好' }] }),
      checkpointer: new MemorySaver(),
      plugins: [],
      backend: new ContainedFilesystemBackend({
        rootDir: join(dir, 'workspace'),
        mode: 'workspace-write',
      }),
    });
    const handler = createWireHandler({
      auth: TEST_BROWSER_AUTH,
      warn: (message) => reported.push(message),
      createAgent: async () => agentOf(built as never),
    });
    opened.push(handler);
    const outcome = await clientOf(handler).trajectoryTurn('t1', { seq: 1 });
    expect(outcome).toMatchObject({ kind: 'rejected', code: 'not_supported' });
    expect(reported).toEqual([]);
  });
});
