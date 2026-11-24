/**
 * thread 收尾的順序：背景 host 收完，才撤會話與 fs 的登記、再收落盤
 * （[#1482](https://github.com/DemianLi/nexus-agent/issues/1482)，Part of #1385「行程級查找只剩一張登記時不看 `thread_id`」）。
 *
 * **走產品組裝**——真的 `createNexusAgent`（背景 host、`attachSession`）、真的持久化協調器（窗口開到上限，所以後端看到東西只可能是收尾
 * 的排空）、真的 `ThreadSessions`（行程級查找，兩條 thread 共用一份）；後端是記憶體替身，模型是腳本。**零憑證、零外部連線。**
 *
 * 場景（驗收 A）：兩條 thread A、B 同時活著；A 有一個背景子代理正在跑一個工具，工具卡在閘門上。收 A 的時候中止那一輪、放開閘門，
 * 工具在中止之後去問行程級的會話查找與 fs 查找。收尾的順序照 `wire-handler.ts` 的 `release`：會話接線 → 落盤 → agent。
 *
 * - **安全那半**：工具問到的必須是 A 自己（會話日誌與 fs 都是），不能是 B。舊順序先撤 A 的登記、才等背景 host，那一刻行程裡只剩 B
 *   一筆，單筆又不看 `thread_id`，所以挑到 B——寫進別條 thread 的日誌，fs 還是安全邊界。
 * - **資料那半**：被中止的那一輪的 `turn/end`（aborted）與結算通知，要在落盤收掉**之前**寫進 A 的日誌，所以後端那份看得到。
 *   舊順序落盤先退訂，這些事件只留在記憶體裡。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HumanMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { attachSessionPersistence, MAX_PERSISTENCE_WINDOW_MS, SessionRegistry } from '@nexus/core';
import type {
  FsService,
  PluginEntry,
  SessionEvent,
  SessionStore,
  StoredSession,
} from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { ScriptedChatModel } from './scripted-model.js';
import { ThreadSessions } from './thread-sessions.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-release-order-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 後端的替身：記下每份日誌寫進來的事件（key 是日誌 id）。 */
function memoryStore() {
  const written = new Map<string, SessionEvent[]>();
  const never = () => Promise.reject(new Error('協調器不該讀'));
  const store: SessionStore = {
    list: never,
    open: never,
    resume: never,
    create(header): StoredSession {
      const events: SessionEvent[] = [];
      written.set(header.id, events);
      return {
        append: (batch) => {
          events.push(...batch);
          return Promise.resolve();
        },
        flush: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
    },
  };
  return { store, written };
}

/** 一份會記下每條 thread 登記進來的 fs 把手的 `ThreadSessions`：測試要比對「挑到的是不是 A 自己的那一個」。 */
class RecordingThreadSessions extends ThreadSessions {
  readonly fsOf = new Map<string, FsService | undefined>();
  override register(sessions: SessionRegistry, fs?: FsService): () => void {
    this.fsOf.set(sessions.root.sessionId, fs);
    return super.register(sessions, fs);
  }
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 工具在中止之後問到的東西。 */
interface Probe {
  /** 挑到的日誌屬於哪一條 thread（背景子代理的日誌 id 是 `<root>/<runId>`，取 `<root>`）；挑不到就是結果的種類。 */
  readonly owner: string;
  readonly fsIsOwn: boolean;
  readonly fsIsOther: boolean;
}

async function assemble() {
  const lookup = new RecordingThreadSessions();
  const { store, written } = memoryStore();
  const entered = deferred();
  const gate = deferred();
  const probes: Probe[] = [];

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
              { content: '', toolCalls: [{ name: 'probe', id: 'probe-call', args: {} }] },
              { content: '做完' },
            ],
          }) as never,
        });
        registry.tools.register(
          tool(
            async (_input, config) => {
              // 卡在閘門上：收 A 的時候中止這一輪，閘門放開之後工具才繼續——它是「中止之後還在跑的工具」。
              entered.resolve();
              await gate.promise;
              const session = lookup.forCall(config);
              const fs = lookup.fsForCall(config);
              probes.push({
                owner: session.kind === 'ok' ? session.log.sessionId.split('/')[0]! : session.kind,
                fsIsOwn: fs.kind === 'ok' && fs.fs === lookup.fsOf.get('rel-a'),
                fsIsOther: fs.kind === 'ok' && fs.fs === lookup.fsOf.get('rel-b'),
              });
              return '探過了';
            },
            { name: 'probe', description: '探針。', schema: z.object({}) },
          ),
        );
      },
    },
  };

  async function thread(
    id: string,
    turns: ConstructorParameters<typeof ScriptedChatModel>[0]['turns'],
    plugins: readonly PluginEntry[],
  ) {
    const built = await createNexusAgent({
      model: new ScriptedChatModel({ turns }),
      checkpointer: new MemorySaver(),
      plugins,
      backend: new ContainedFilesystemBackend({ rootDir: dir, mode: 'workspace-write' }),
      backgroundSubagents: {},
      sessionLookup: lookup,
    });
    const sessions = new SessionRegistry(id);
    const persistence = attachSessionPersistence(sessions, store, {
      windowMs: MAX_PERSISTENCE_WINDOW_MS,
    });
    const detach = built.attachSession(sessions, {});
    return { built, sessions, persistence, detach };
  }

  const b = await thread('rel-b', [{ content: '待著' }], []);
  const a = await thread(
    'rel-a',
    [
      {
        content: '委派。',
        toolCalls: [
          {
            name: 'subagent',
            id: 'root-call',
            args: { description: '幹活', subagent_type: 'worker', run_in_background: true },
          },
        ],
      },
      { content: '根收尾' },
      { content: '收到' },
    ],
    [worker],
  );
  return { a, b, entered, gate, probes, written, lookup };
}

/** 場景（驗收 A）：跑到工具卡在閘門上，照 `wire-handler.ts` 的 `release` 收 A，收的同時放開閘門。回測試要看的東西。 */
async function releaseWhileToolRunning() {
  const { a, b, entered, gate, probes, written } = await assemble();
  try {
    await a.built.agent.invoke(
      { messages: [new HumanMessage('委派')] },
      { configurable: { thread_id: 'rel-a' } },
    );
    await entered.promise;
    const bEventsBefore = b.sessions.root.events.length;

    // 會話接線 → 落盤 → agent。
    const detaching = Promise.resolve(a.detach());
    gate.resolve();
    await detaching;
    await a.persistence.dispose();
    await a.built.dispose();

    return { probes, written, bEventsBefore, bEventsAfter: b.sessions.root.events.length };
  } finally {
    gate.resolve();
    await b.detach();
    await b.persistence.dispose();
    await b.built.dispose();
  }
}

describe('thread 收尾：背景 host 收完才撤登記、再收落盤（#1482 驗收 A）', () => {
  it('安全：另一條 thread 活著時收掉有背景子代理在跑工具的這一條，中止之後的工具問到的是自己（會話與 fs），B 的日誌一筆都沒多', async () => {
    const { probes, bEventsBefore, bEventsAfter } = await releaseWhileToolRunning();
    expect(probes).toEqual([{ owner: 'rel-a', fsIsOwn: true, fsIsOther: false }]);
    expect(bEventsAfter).toBe(bEventsBefore);
  }, 30000);

  it('資料：被中止那一輪的 turn/end（aborted）在落盤收掉之前寫進背景子代理的日誌，後端那份看得到', async () => {
    const { written } = await releaseWhileToolRunning();
    const background = [...written].filter(([id]) => id.startsWith('rel-a/'));
    expect(background).toHaveLength(1);
    const ends = background[0]![1].filter((event) => event.type === 'turn/end');
    expect(ends).toHaveLength(1);
    expect(JSON.stringify(ends[0]!.data)).toContain('aborted');
  }, 30000);
});
