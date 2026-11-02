/**
 * 宣告 `children: true` 的投影單元，也折子代理自己的日誌（[#1028](https://github.com/DemianLi/nexus-agent/issues/1028) 的通道）。
 *
 * **全走產品組裝**：`createNexusAgent`＋腳本模型＋`createWireHandler`＋JSONL 落盤。兩顆單元都數 `tool/call`：
 * `child-calls` 宣告 `children`，`root-calls` 沒宣告——對照出「預設只折 root」。
 *
 * - **即時 = 歷史 = 重開之後**：子代理的值落在 `subagentProjections[runId][key]`，三處折出來一樣；前景（`task`、
 *   `subagent` 帶 `run_in_background: false`）與背景都量。
 * - **root-only 的單元不收子代理**：`root-calls` 在 `subagentProjections` 裡一格都沒有，它的值也不被子代理的事件推動。
 * - **沒有單元要折子代理**：pump 的子日誌集合是空的，重開時不讀子日誌檔。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { attachSessionPersistence } from '@nexus/core';
import type { PluginEntry, ProjectionUnit, SessionEvent, SessionRegistry } from '@nexus/core';
import { createWireClient, emptyConversation, reduceAll } from '@nexus/wire';
import type { ConversationState, Event } from '@nexus/wire';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { readSessionLogs } from './eval/session-scan.js';
import { emptyCommandPoint, loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import { createJsonlSessionStore } from './jsonl-session-store.js';
import {
  catalogRunIds,
  childProjectionData,
  readProjectionChildSeeds,
} from './projection-children.js';
import { ScriptedChatModel } from './scripted-model.js';
import { composeAttachSessions } from './session-attach.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';
import type { WireHandler } from './wire-handler.js';

let dir: string;
const opened: WireHandler[] = [];
let reported: string[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-projection-children-'));
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

const CHILD_KEY = 'child-calls';
const ROOT_KEY = 'root-calls';

/** 數 `tool/call`。 */
function callCounter(key: string, children: boolean): ProjectionUnit<number, { calls: number }> {
  return {
    key,
    stateVersion: 1,
    init: () => 0,
    apply: (state, event) => (event.type === 'tool/call' ? state + 1 : state),
    view: (state) => ({ calls: state }),
    ...(children && { children: true as const }),
  };
}

/** 三條派法，同 `subagent-session-link.test.ts`。 */
const CASES = [
  {
    label: '前景 task',
    name: 'task',
    args: { description: '幹活', subagent_type: 'worker' },
    background: false,
  },
  {
    label: '前景 subagent（run_in_background: false）',
    name: 'subagent',
    args: { description: '幹活', subagent_type: 'worker', run_in_background: false },
    background: true,
  },
  {
    label: '背景 subagent',
    name: 'subagent',
    args: { description: '幹活', subagent_type: 'worker', run_in_background: true },
    background: true,
  },
] as const;
type Case = (typeof CASES)[number];

function hostPlugin(withChildren: boolean): PluginEntry {
  return {
    plugin: {
      name: 'children-host',
      apply(registry) {
        registry.subagents.register({
          name: 'worker',
          description: '幹活的。',
          systemPrompt: '你是 worker。',
          model: new ScriptedChatModel({
            turns: [
              { content: '', toolCalls: [{ name: 'noop', id: 'inner-1', args: {} }] },
              { content: '', toolCalls: [{ name: 'noop', id: 'inner-2', args: {} }] },
              { content: '做完' },
            ],
          }) as never,
        });
        registry.tools.register(
          tool(() => '好', { name: 'noop', description: '什麼都不做。', schema: z.object({}) }),
        );
        if (withChildren) registry.projections.register(callCounter(CHILD_KEY, true));
        registry.projections.register(callCounter(ROOT_KEY, false));
      },
    },
  };
}

async function build(entry: Case, withChildren = true) {
  return createNexusAgent({
    model: new ScriptedChatModel({
      turns: [
        {
          content: '委派。',
          toolCalls: [{ name: entry.name, id: 'root-call', args: entry.args }],
        },
        { content: '根收尾' },
        { content: '收到結算' },
      ],
    }),
    checkpointer: new MemorySaver(),
    plugins: [hostPlugin(withChildren)],
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

const CHILD_VIEW = { version: 1, view: { calls: 2 } };

async function history(client: ReturnType<typeof createWireClient>): Promise<ConversationState> {
  const page = await client.threadHistory('t1');
  if (page.kind !== 'ok') throw new Error(page.message);
  return reduceAll(emptyConversation(), page.result.events);
}

describe.each(CASES)('$label：子代理的投影即時、歷史、重開之後一樣', (entry) => {
  it('child 單元在 subagentProjections 長出子代理自己的值；root-only 的單元不收', async () => {
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
      baseUrl: 'http://children.test',
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
    const runId = sessions!.list().find((each) => each.address.kind === 'subagent')?.address;
    if (runId?.kind !== 'subagent') throw new Error('沒有子代理');
    const id = runId.runId;
    // 等下行追上：子代理最後一個 tool/call 之後的值到了。
    await until(
      () =>
        reduceAll(emptyConversation(), frames).subagentProjections[id]?.[CHILD_KEY]?.view !==
          undefined &&
        JSON.stringify(
          reduceAll(emptyConversation(), frames).subagentProjections[id]?.[CHILD_KEY],
        ) === JSON.stringify(CHILD_VIEW),
    );
    line.abort();
    await draining;

    const live = reduceAll(emptyConversation(), frames);
    expect(live.subagentProjections[id]?.[CHILD_KEY]).toEqual(CHILD_VIEW);
    // 對照：root-only 的單元不在子代理那一格；宣告了 children 的單元也照舊折 root 自己。
    expect(Object.keys(live.subagentProjections)).toEqual([id]);
    expect(live.subagentProjections[id]?.[ROOT_KEY]).toBeUndefined();
    expect(live.projections[CHILD_KEY]?.view).toEqual({ calls: 1 });
    expect(live.projections[ROOT_KEY]?.view).toEqual({ calls: 1 });

    // 歷史：同一個折疊，同一份集合。
    const refreshed = await history(client);
    expect(refreshed.subagentProjections).toEqual(live.subagentProjections);
    expect(refreshed.projections).toEqual(live.projections);

    // 重開：收掉這個行程，只剩磁碟上那一份，另一個 handler 讀 root 的 seed 與唯讀冷讀的子日誌。
    opened.splice(opened.indexOf(handler), 1);
    await handler.close();
    const { logs } = await readSessionLogs([store.directory]);
    const rootSeed = logs.find((log) => log.header.id === 't1')?.events;
    const cold = new Map<string, readonly SessionEvent[]>();
    for (const log of logs) {
      if (log.header.id.startsWith('t1/')) cold.set(log.header.id.slice(3), log.events);
    }
    const reads: string[] = [];
    const rebuilt = await build(entry);
    const reopened = createWireHandler({
      auth: TEST_BROWSER_AUTH,
      warn: (message) => reported.push(message),
      readSubagentSession: async (threadId, each) => {
        reads.push(`${threadId}/${each}`);
        return cold.get(each);
      },
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
      baseUrl: 'http://children.test',
      fetch: async (input, init) => reopened.handle(loopbackRequest(input as string, init)),
    });
    const replayed = await history(again);
    expect(reads).toEqual([`t1/${id}`]);
    expect(replayed.subagentProjections).toEqual(live.subagentProjections);
    expect(replayed.projections).toEqual(live.projections);
    expect(reported).toEqual([]);
  }, 30000);
});

describe('沒有單元要折子代理', () => {
  it('重開時不讀子日誌檔；歷史裡沒有 subagentProjections 的值', async () => {
    const entry = CASES[0];
    const store = createJsonlSessionStore({ rootDir: join(dir, 'logs') });
    const built = await build(entry, false);
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
      baseUrl: 'http://children.test',
      fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
    });
    await client.runStart('t1', '委派');
    await until(() => sessions !== undefined && childDone(sessions));
    expect((await history(client)).subagentProjections).toEqual({});
    expect((await history(client)).projections[ROOT_KEY]?.view).toEqual({ calls: 1 });

    opened.splice(opened.indexOf(handler), 1);
    await handler.close();
    const { logs } = await readSessionLogs([store.directory]);
    const rootSeed = logs.find((log) => log.header.id === 't1')?.events;
    const reads: string[] = [];
    const rebuilt = await build(entry, false);
    const reopened = createWireHandler({
      auth: TEST_BROWSER_AUTH,
      warn: (message) => reported.push(message),
      readSubagentSession: async (threadId, each) => {
        reads.push(`${threadId}/${each}`);
        return undefined;
      },
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
      baseUrl: 'http://children.test',
      fetch: async (input, init) => reopened.handle(loopbackRequest(input as string, init)),
    });
    expect((await history(again)).subagentProjections).toEqual({});
    expect(reads).toEqual([]);
    expect(reported).toEqual([]);
  }, 30000);
});

/** 手造的日誌事件，只填折疊與名單要看的欄位。 */
function ev(seq: number, type: string, data: Record<string, unknown>): SessionEvent {
  return { type, seq, time: seq, data } as unknown as SessionEvent;
}

describe('projection-children 的零件', () => {
  const catalog = (childId: string, seq: number) =>
    ev(seq, 'subagent/catalog', { childId, callId: `c${seq}`, mode: 'one-shot' });

  it('catalogRunIds：只認 <thread>/ 底下的、去重、保持出現順序', () => {
    const events = [
      catalog('t/a', 0),
      catalog('other/b', 1),
      catalog('t/c', 2),
      catalog('t/a', 3),
      catalog('t/', 4),
    ];
    expect(catalogRunIds('t', events)).toEqual(['a', 'c']);
    expect(catalogRunIds('t', [])).toEqual([]);
  });

  it('readProjectionChildSeeds：沒單元要子代理、沒讀法、沒 rootSeed 都一律不讀', async () => {
    const reads: string[] = [];
    const read = async (threadId: string, runId: string) => {
      reads.push(`${threadId}/${runId}`);
      return [] as SessionEvent[];
    };
    const root = [catalog('t/a', 0)];
    expect(
      await readProjectionChildSeeds('t', root, [callCounter('x', false)], read),
    ).toBeUndefined();
    expect(
      await readProjectionChildSeeds('t', root, [callCounter('x', true)], undefined),
    ).toBeUndefined();
    expect(
      await readProjectionChildSeeds('t', undefined, [callCounter('x', true)], read),
    ).toBeUndefined();
    expect(reads).toEqual([]);
  });

  it('readProjectionChildSeeds：讀得到的收下、讀不到與拋錯的略過並講一聲，不拖垮其他的', async () => {
    const warnings: string[] = [];
    const logs: Record<string, SessionEvent[] | 'boom' | undefined> = {
      a: [ev(0, 'tool/call', {})],
      b: undefined,
      c: 'boom',
    };
    const seeds = await readProjectionChildSeeds(
      't',
      [catalog('t/a', 0), catalog('t/b', 1), catalog('t/c', 2)],
      [callCounter('x', true)],
      async (_thread, runId) => {
        const found = logs[runId];
        if (found === 'boom') throw new Error('壞檔');
        return found;
      },
      (message) => warnings.push(message),
    );
    expect([...(seeds ?? new Map()).keys()]).toEqual(['a']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('壞檔');
    expect(warnings[0]).toContain('c');
  });

  it('childProjectionData：每個子代理 × 每個 children 單元各一顆 frame，帶 session；沒有 children 單元時什麼都不送', () => {
    const children = new Map<string, readonly SessionEvent[]>([
      ['a', [ev(0, 'tool/call', {}), ev(1, 'tool/call', {})]],
      ['b', []],
    ]);
    const frames = childProjectionData([callCounter('x', true), callCounter('y', false)], children);
    expect(frames.map((frame) => frame.payload)).toEqual([
      { key: 'x', version: 1, view: { calls: 2 }, session: 'a' },
      { key: 'x', version: 1, view: { calls: 0 }, session: 'b' },
    ]);
    expect(childProjectionData([callCounter('y', false)], children)).toEqual([]);
  });
});
