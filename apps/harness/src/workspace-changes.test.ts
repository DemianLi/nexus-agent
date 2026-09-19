/**
 * **每一輪的改動紀錄在真的圖、真的 pump、歷史路由與兩條 `changes` 路由上跑一次**——
 * [#443](https://github.com/DemianLi/nexus-agent/issues/443) 的端到端驗收。
 *
 * `@nexus/plugin-workspace-changes` 自己的測試走 registry 那一層，證得了時序（核准點、中止、下一輪已開）；
 * 證不了的是：
 *
 * 1. 基座真的經過那顆 `wrapToolCall`、真的跑到 `afterAgent`——事件落在 root 日誌那一輪的 `turn/end` 之前。
 * 2. **即時與重新整理產出同一顆 `custom` frame**，帶的 `seq` 拿得到摘要。
 * 3. 兩條路由的載體：座標、media type、404、`no-store`。
 * 4. 子代理用檔案工具改的檔算進 root 那一輪。
 * 5. 暫存目錄是 `0700`，thread 收掉時整個刪掉。
 * 6. 組裝點只在 serve、有 `--workspace` 時掛。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`，工作區與暫存根都是暫存目錄，測試不碰真的 `~/.nexus-agent`。
 */

import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemorySaver } from '@langchain/langgraph';
import type { InvariantError, NexusPlugin, SessionRegistry } from '@nexus/core';
import { createWorkspaceChanges } from '@nexus/plugin-workspace-changes';
import type { Event } from '@nexus/wire';
import {
  changesDiffPath,
  changesSummaryPath,
  createWireClient,
  WORKSPACE_CHANGES,
} from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { createCliAgent, DEFAULT_PLUGINS } from './cli.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import { createSandboxPolicyPlugin } from './sandbox-policy.js';
import { SandboxModeController } from './sandbox-mode.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

const BASE_URL = 'http://changes.test';
const THREAD_ID = 'changes';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function directory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

/** 一個子代理的來源：委派那一條要有人可以委派。 */
const WORKER: NexusPlugin = {
  name: 'worker-source',
  apply(registry) {
    registry.subagents.register({ name: 'worker', description: '幹活的。' });
  },
};

interface Outcome {
  readonly live: readonly Event[];
  readonly history: readonly Event[];
  readonly sessions: SessionRegistry;
  readonly violations: readonly string[];
  /** 這一份的暫存根：底下的東西在 `close` 之前看得到。 */
  readonly tempRoot: string;
  /** 在 thread 還活著時打一條路由。 */
  readonly get: (path: string, init?: RequestInit) => Promise<Response>;
  /** 收掉 thread。 */
  readonly close: () => Promise<void>;
}

/**
 * 經 wire 跑一輪：開下行、送一句、抽到 root 收工，再拿歷史。**不收 thread**——路由要在它活著時打。
 */
async function run(
  turns: readonly ScriptedTurn[],
  files: Record<string, string> = {},
): Promise<Outcome> {
  const root = await directory('nexus-changes-e2e-');
  const tempRoot = await directory('nexus-changes-temp-');
  for (const [name, content] of Object.entries(files)) await writeFile(join(root, name), content);
  const sandboxMode = new SandboxModeController('workspace-write');
  const violations: string[] = [];
  const changes = createWorkspaceChanges({ root, tempRoot });
  const built = await createNexusAgent({
    model: new ScriptedChatModel({ turns }),
    checkpointer: new MemorySaver(),
    plugins: [
      ...DEFAULT_PLUGINS,
      WORKER,
      createSandboxPolicyPlugin(sandboxMode, root),
      changes.plugin,
    ],
    backend: new ContainedFilesystemBackend({
      rootDir: root,
      mode: sandboxMode.source,
      grants: sandboxMode,
    }),
    onInvariantViolation: (error: InvariantError) => void violations.push(error.message),
  });
  let sessions: SessionRegistry | undefined;
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    createAgent: async () => ({
      agent: built.agent as unknown as PumpAgent,
      commands: built.commands,
      dispose: built.dispose,
      workspaceChanges: changes.service,
      attachInvariants: built.attachInvariants,
      attachSession: (registry) => {
        sessions = registry;
        return built.attachSession(registry);
      },
    }),
  });
  const client = createWireClient({
    baseUrl: BASE_URL,
    fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
  });
  const live: Event[] = [];
  try {
    const events = await client.openEvents(THREAD_ID);
    await client.runStart(THREAD_ID, '改檔吧。');
    for (;;) {
      const next = await events.next();
      if (next.done === true) break;
      live.push(next.value);
      const data = next.value.params.data as { event?: string; graph_name?: string };
      if (next.value.method === 'lifecycle' && data.graph_name === 'root') {
        if (data.event === 'completed' || data.event === 'failed') break;
      }
    }
    await new Promise((resolve) => setImmediate(resolve));
    const page = await client.threadHistory(THREAD_ID);
    if (page.kind !== 'ok') throw new Error(`歷史拿不到：${page.message}`);
    await events.return?.(undefined);
    if (sessions === undefined) throw new Error('attachSession 沒被叫到');
    return {
      live,
      history: page.result.events,
      sessions,
      violations,
      tempRoot,
      get: (path, init) =>
        handler.handle(
          loopbackRequest(`${BASE_URL}${path}`, {
            method: 'GET',
            headers: { 'content-type': 'application/json' },
            ...init,
          }),
        ),
      close: () => handler.close(),
    };
  } catch (error) {
    await handler.close();
    throw error;
  }
}

/** 一串 frame 裡改動紀錄那幾顆的 `payload`。 */
function changesIn(frames: readonly Event[]): unknown[] {
  return frames
    .filter((frame) => frame.method === 'custom')
    .map((frame) => frame.params.data as { name?: string; payload?: unknown })
    .filter((data) => data.name === WORKSPACE_CHANGES)
    .map((data) => data.payload);
}

/** 「先讀後改」的策略擋著沒讀過就改的 `edit_file`，所以先讀一輪。 */
const READ_A: ScriptedTurn = {
  content: '先讀。',
  toolCalls: [{ name: 'read_file', args: { file_path: '/a.md' } }],
};

const EDIT_THREE: ScriptedTurn[] = [
  READ_A,
  {
    content: '改三個。',
    toolCalls: [
      { name: 'edit_file', args: { file_path: '/a.md', old_string: 'two', new_string: '2' } },
      { name: 'write_file', args: { file_path: '/new.md', content: 'hi\n' } },
      { name: 'delete', args: { file_path: '/gone.md' } },
    ],
  },
  { content: '改好了。' },
];
const FILES = { 'a.md': 'one\ntwo\nthree\n', 'gone.md': 'bye\n' };

describe('每一輪的改動紀錄在真的圖上', () => {
  it('root 改了三個檔：輪內記一顆，即時與重新整理同一顆 frame，摘要與比較對得上', async () => {
    const outcome = await run(EDIT_THREE, FILES);
    try {
      const events = outcome.sessions.root.events;
      const changes = events.filter((event) => event.type === 'workspace/changes');
      expect(changes).toHaveLength(1);
      const seq = changes[0]!.seq;
      // 在輪內：落在最後一顆 `tool/result` 之後、`turn/end` 之前——web 由 `seq` 往前找 `turn/start` 認輪。
      const lastResult = events.filter((event) => event.type === 'tool/result').at(-1)!.seq;
      const turnEnd = events.find((event) => event.type === 'turn/end')!.seq;
      expect(seq).toBeGreaterThan(lastResult);
      expect(seq).toBeLessThan(turnEnd);
      expect(changesIn(outcome.live)).toEqual([{ seq }]);
      expect(changesIn(outcome.history)).toEqual([{ seq }]);
      expect(outcome.violations).toEqual([]);

      const summary = await outcome.get(`${changesSummaryPath(THREAD_ID)}?seq=${seq}`);
      expect(summary.status).toBe(200);
      expect(summary.headers.get('cache-control')).toBe('no-store');
      expect(await summary.json()).toEqual({
        files: [
          { path: 'a.md', display: 'a.md', added: 1, deleted: 1 },
          { path: 'gone.md', display: 'gone.md', added: 0, deleted: 1 },
          { path: 'new.md', display: 'new.md', added: 1, deleted: 0 },
        ],
        total: 3,
        added: 2,
        deleted: 2,
      });
      const diff = await outcome.get(`${changesDiffPath(THREAD_ID)}?seq=${seq}&index=0`);
      expect(diff.status).toBe(200);
      expect(await diff.json()).toEqual({
        kind: 'text',
        path: 'a.md',
        display: 'a.md',
        before: true,
        after: true,
        coarse: false,
        hunks: [
          {
            oldStart: 1,
            oldLines: 3,
            newStart: 1,
            newLines: 3,
            lines: [' one', '-two', '+2', ' three'],
          },
        ],
      });
      const created = await outcome.get(`${changesDiffPath(THREAD_ID)}?seq=${seq}&index=2`);
      expect(await created.json()).toMatchObject({ path: 'new.md', before: false, after: true });
    } finally {
      await outcome.close();
    }
  });

  it('路由的載體：座標不對 400、沒有這份 404、media type 415、只收 GET；都不快取', async () => {
    const outcome = await run(EDIT_THREE, FILES);
    try {
      const seq = outcome.sessions.root.events.find(
        (event) => event.type === 'workspace/changes',
      )!.seq;
      const summaryPath = changesSummaryPath(THREAD_ID);
      const diffPath = changesDiffPath(THREAD_ID);
      const cases: [string, number, RequestInit?][] = [
        [`${summaryPath}`, 400],
        [`${summaryPath}?seq=-1`, 400],
        [`${summaryPath}?seq=1.5`, 400],
        [`${diffPath}?seq=${seq}`, 400],
        [`${summaryPath}?seq=${seq + 1}`, 404],
        [`${diffPath}?seq=${seq}&index=3`, 404],
        [`${diffPath}?seq=${seq + 1}&index=0`, 404],
        // 還沒在這個行程裡開起來的 thread：不為了回一句「沒有」把它建起來。
        [`${changesSummaryPath('never-opened')}?seq=${seq}`, 404],
      ];
      for (const [path, status] of cases) {
        const response = await outcome.get(path);
        expect(response.status, path).toBe(status);
        expect(response.headers.get('cache-control'), path).toBe('no-store');
      }
      const noMediaType = await outcome.get(`${summaryPath}?seq=${seq}`, { headers: {} });
      expect(noMediaType.status).toBe(415);
      const post = await outcome.get(`${summaryPath}?seq=${seq}`, {
        method: 'POST',
        body: '{}',
      });
      expect(post.status).toBe(404);
    } finally {
      await outcome.close();
    }
  });

  it('子代理用檔案工具改的檔算進 root 那一輪；事件只在 root', async () => {
    const outcome = await run(
      [
        {
          content: '委派。',
          toolCalls: [{ name: 'task', args: { description: '改檔', subagent_type: 'worker' } }],
        },
        READ_A,
        {
          content: '子代理改。',
          toolCalls: [
            { name: 'edit_file', args: { file_path: '/a.md', old_string: 'two', new_string: '2' } },
          ],
        },
        { content: '子代理收工。' },
        { content: '根收工。' },
      ],
      FILES,
    );
    try {
      const subagentChanges = outcome.sessions
        .list()
        .filter((entry) => entry.address.kind === 'subagent')
        .flatMap((entry) => entry.log.events.filter((event) => event.type === 'workspace/changes'));
      expect(subagentChanges).toEqual([]);
      const [event] = outcome.sessions.root.events.filter(
        (entry) => entry.type === 'workspace/changes',
      );
      expect(event).toBeDefined();
      const summary = await outcome.get(`${changesSummaryPath(THREAD_ID)}?seq=${event!.seq}`);
      expect(await summary.json()).toMatchObject({
        files: [{ path: 'a.md', added: 1, deleted: 1 }],
        total: 1,
      });
      expect(outcome.violations).toEqual([]);
    } finally {
      await outcome.close();
    }
  });

  it('沒呼叫工具的一輪：不記、不送', async () => {
    const outcome = await run([{ content: '只是聊天。' }], FILES);
    try {
      expect(outcome.sessions.root.events.some((event) => event.type === 'workspace/changes')).toBe(
        false,
      );
      expect(changesIn(outcome.live)).toEqual([]);
      expect(changesIn(outcome.history)).toEqual([]);
    } finally {
      await outcome.close();
    }
  });

  it('暫存目錄是 0700；thread 收掉時整個刪掉，之後路由回 404', async () => {
    const outcome = await run(EDIT_THREE, FILES);
    const [scratch] = await readdir(outcome.tempRoot);
    expect(scratch).toMatch(/^nexus-workspace-changes-/);
    expect((await stat(join(outcome.tempRoot, scratch!))).mode & 0o777).toBe(0o700);
    await outcome.close();
    expect(await readdir(outcome.tempRoot)).toEqual([]);
  });
});

describe('組裝點', () => {
  it('只有 serve 開、而且要有 --workspace 才掛', async () => {
    const workspace = await directory('nexus-changes-cli-');
    const cases = [
      [{ live: false, workspace, workspaceChanges: true }, true],
      [{ live: false, workspaceChanges: true }, false],
      [{ live: false, workspace }, false],
    ] as const;
    for (const [invocation, mounted] of cases) {
      const built = await createCliAgent(invocation, DEFAULT_PLUGINS);
      try {
        expect(built.workspaceChanges !== undefined, JSON.stringify(invocation)).toBe(mounted);
      } finally {
        await built.dispose();
      }
    }
  });
});
