/**
 * **每一輪的改動紀錄在真的圖、真的 pump、歷史路由與兩條 `changes` 路由上跑一次**——
 * [#443](https://github.com/DemianLi/nexus-agent/issues/443) 的端到端驗收。
 *
 * `@nexus/plugin-workspace-changes` 自己的測試走 registry 那一層，證得了時序（核准點、中止、下一輪已開）；
 * 證不了的是：
 *
 * 1. 基座真的經過那顆 `wrapToolCall`、真的跑到 `afterAgent`——事件落在 root 日誌那一輪的 `turn/end` 之前。
 * 2. **即時與重新整理產出同一顆 `custom` frame**，帶的 `seq` 拿得到摘要；折疊器各折出同一格，拿掉它畫面不變。
 * 3. 兩條路由的載體：座標、media type、404、`no-store`。
 * 4. 子代理用檔案工具改的檔算進 root 那一輪。
 * 5. 暫存目錄是 `0700`，thread 收掉時整個刪掉。
 * 6. 組裝點只在 serve、有 `--workspace` 時掛。
 * 7. 工作區是 git repo 時，檔案工具以外的改動也在摘要裡（[#461](https://github.com/DemianLi/nexus-agent/issues/461)）。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`，工作區與暫存根都是暫存目錄，測試不碰真的 `~/.nexus-agent`。
 */

import { execFileSync } from 'node:child_process';
import {
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import type { InvariantError, PluginEntry, SandboxMode, SessionRegistry } from '@nexus/core';
import { createHostServicesPlugin } from '@nexus/core';
import { createWorkspaceChanges, WORKSPACE_CHANGES_SERVICE } from '@nexus/plugin-workspace-changes';
import type { Event } from '@nexus/wire';
import {
  changesDiffPath,
  changesSummaryPath,
  createWireClient,
  emptyConversation,
  reduceAll,
  WORKSPACE_CHANGES,
} from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { createCliAgent } from './cli.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { TEST_BROWSER_AUTH, loopbackRequest, shippedPlugins } from './fixtures.js';
import { createSandboxPolicyPlugin } from '@nexus/plugin-sandbox-policy';
import { SandboxModeController } from '@nexus/plugin-sandbox-policy';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

const shipped = await shippedPlugins();

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
const WORKER: PluginEntry = {
  plugin: {
    name: 'worker-source',
    apply(registry) {
      registry.subagents.register({ name: 'worker', description: '幹活的。' });
    },
  },
};

interface Outcome {
  readonly live: readonly Event[];
  readonly history: readonly Event[];
  readonly sessions: SessionRegistry;
  readonly violations: readonly string[];
  /** 這一份的暫存根：底下的東西在 `close` 之前看得到。 */
  readonly tempRoot: string;
  /** 在 thread 還活著時打一條路由（帶會話 cookie、loopback 的 Host）。 */
  readonly get: (path: string, init?: RequestInit) => Promise<Response>;
  /** 原樣交給 handler，不補 cookie 與 Host：驗認證那兩道閘門用。 */
  readonly raw: (request: Request) => Promise<Response>;
  /** 模型實際拿到的工具名單。 */
  readonly boundToolNames: readonly string[];
  /** 工作區根。 */
  readonly root: string;
  /** 收掉 thread。 */
  readonly close: () => Promise<void>;
}

/**
 * 經 wire 跑一輪：開下行、送一句、抽到 root 收工，再拿歷史。**不收 thread**——路由要在它活著時打。
 */
async function run(
  turns: readonly ScriptedTurn[],
  files: Record<string, string> = {},
  options: {
    mode?: SandboxMode;
    setup?: (root: string) => Promise<void>;
    plugins?: readonly PluginEntry[];
  } = {},
): Promise<Outcome> {
  const root = await directory('nexus-changes-e2e-');
  const tempRoot = await directory('nexus-changes-temp-');
  for (const [name, content] of Object.entries(files)) await writeFile(join(root, name), content);
  await options.setup?.(root);
  const sandboxMode = new SandboxModeController(options.mode ?? 'workspace-write');
  const model = new ScriptedChatModel({ turns });
  const violations: string[] = [];
  const changes = createWorkspaceChanges({ root, tempRoot });
  const built = await createNexusAgent({
    model,
    checkpointer: new MemorySaver(),
    plugins: [
      createHostServicesPlugin({ sandboxPolicy: { controller: sandboxMode, rootDir: root } }),
      ...shipped,
      WORKER,
      createSandboxPolicyPlugin(),
      ...(options.plugins ?? []),
      changes,
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
      workspaceChanges: built.services.use(WORKSPACE_CHANGES_SERVICE),
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
      raw: (request) => handler.handle(request),
      boundToolNames: model.boundToolNames,
      root,
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
      // **折疊器替它長一格**（照 #441，由原本「不替它長格子」那條翻面）：即時與歷史各折出同一格，落在最後
      // 那張工具卡之後；拿掉這一格，剩下的畫面（包括決定評分按鈕位置的輪尾）跟沒有這顆 frame 時一模一樣。
      const without = (frames: readonly Event[]) =>
        frames.filter((frame) => changesIn([frame]).length === 0);
      const folded = [outcome.live, outcome.history].map((frames) => {
        const state = reduceAll(emptyConversation(), frames);
        const at = state.entries.findIndex((entry) => entry.kind === 'workspace-changes');
        const lastTool = state.entries.findLastIndex((entry) => entry.kind === 'tool');
        expect(lastTool).toBeGreaterThanOrEqual(0);
        expect(at).toBeGreaterThan(lastTool);
        // `turnStart` 是 `entries` 的索引，多一格就跟著多 1；輪尾標在哪一則由 `entries` 逐格比。
        const bare = reduceAll(emptyConversation(), without(frames));
        expect({
          ...state,
          entries: state.entries.filter((entry) => entry.kind !== 'workspace-changes'),
          turnStart: bare.turnStart,
        }).toEqual(bare);
        expect(state.turnStart).toBe(bare.turnStart + 1);
        return state.entries.filter((entry) => entry.kind === 'workspace-changes');
      });
      const entry = { kind: 'workspace-changes', id: `workspace-changes:${seq}`, seq };
      expect(folded).toEqual([[entry], [entry]]);

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
      // **兩道認證閘門排在路徑判斷之前**（#424）：多人共用主機上，同機的其他使用者拿不到摘要與內容。
      for (const path of [`${summaryPath}?seq=${seq}`, `${diffPath}?seq=${seq}&index=0`]) {
        const url = `${BASE_URL}${path}`;
        const json = { 'content-type': 'application/json' };
        const noCookie = await outcome.raw(
          new Request(url, { headers: { ...json, host: 'localhost' } }),
        );
        expect(noCookie.status, path).toBe(401);
        const untrusted = await outcome.raw(
          new Request(url, { headers: { ...json, host: 'evil.example' } }),
        );
        expect(untrusted.status, path).toBe(403);
      }
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
      // **不在 repo 裡的工作區的前提**：`--workspace` 底下模型改檔只經這三顆，沒有 `execute`（#443 第二則
      // 決議）。這一條紅了表示換了一顆有 shell 的 backend：repo 裡的工作區有 git 快照（#461）照樣涵蓋，
      // 不在 repo 裡的會漏掉 shell 改的檔——dsh 同樣（README 的已知限制），但那時要重新決定要不要接受。
      expect(outcome.boundToolNames).toEqual(
        expect.arrayContaining(['write_file', 'edit_file', 'delete']),
      );
      expect(outcome.boundToolNames).not.toContain('execute');
      expect(outcome.sessions.root.events.some((event) => event.type === 'workspace/changes')).toBe(
        false,
      );
      expect(changesIn(outcome.live)).toEqual([]);
      expect(changesIn(outcome.history)).toEqual([]);
    } finally {
      await outcome.close();
    }
  });

  it('被 fence 擋下的寫入不列：基座把拒絕報成成功，但檔案前後一樣', async () => {
    const outcome = await run(
      [
        {
          content: '寫。',
          toolCalls: [{ name: 'write_file', args: { file_path: '/new.md', content: 'hi\n' } }],
        },
        { content: '寫了。' },
      ],
      FILES,
      { mode: 'read-only' },
    );
    try {
      expect(outcome.sessions.root.events.some((event) => event.type === 'workspace/changes')).toBe(
        false,
      );
      await expect(stat(join(outcome.root, 'new.md'))).rejects.toThrow();
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
      const built = await createCliAgent(invocation, shipped);
      try {
        expect(built.workspaceChanges !== undefined, JSON.stringify(invocation)).toBe(mounted);
      } finally {
        await built.dispose();
      }
    }
  });

  /**
   * **兩次組裝各拿各的一份**（[#459](https://github.com/DemianLi/nexus-agent/issues/459)）。
   *
   * 從前工廠回的那一份帶著閉包狀態，所以「一份只能掛一次組裝」要用一顆 `applied` 旗標擋。
   * 現在狀態住在 `apply` 裡，而 `serve.ts` 每條 thread 各跑一次 `createCliAgent`（`:341`）——
   * 這一條釘的是「`createCliAgent` 交出來的是這一次組裝提供的那一份」。服務名寫錯、或
   * `provide` 整個拿掉，這裡就是 `undefined`。
   */
  it('兩次 createCliAgent 各拿各的一份', async () => {
    const workspace = await directory('nexus-changes-cli-');
    const invocation = { live: false, workspace, workspaceChanges: true } as const;
    const first = await createCliAgent(invocation, shipped);
    const second = await createCliAgent(invocation, shipped);
    try {
      expect(first.workspaceChanges).toBeDefined();
      expect(second.workspaceChanges).toBeDefined();
      expect(first.workspaceChanges).not.toBe(second.workspaceChanges);
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });
});

describe('工作區外', () => {
  /**
   * 「外面」放在 `/var/tmp`：它不在 `/tmp`、也不在 `os.tmpdir()` 底下（macOS 與 Linux 都是），所以不會被「工作區外
   * 的暫存目錄不列」那條規則先排掉——放在 `os.tmpdir()` 底下的話，這一條量到的是那條規則，不是 fence。
   */
  async function outsideDirectory(): Promise<string> {
    const path = await mkdtemp('/var/tmp/nexus-changes-outside-');
    roots.push(path);
    await writeFile(join(path, 'secret.txt'), 'top secret\n');
    return path;
  }

  const THROUGH_LINK: ScriptedTurn[] = [
    { content: '讀。', toolCalls: [{ name: 'read_file', args: { file_path: '/out/secret.txt' } }] },
    {
      content: '改。',
      toolCalls: [
        {
          name: 'edit_file',
          args: { file_path: '/out/secret.txt', old_string: 'top', new_string: 'no' },
        },
      ],
    },
    { content: '好。' },
  ];

  it('workspace-write：經符號連結寫到根外被 fence 擋下，檔案沒變，不列', async () => {
    const outside = await outsideDirectory();
    const outcome = await run(THROUGH_LINK, FILES, {
      setup: (root) => symlink(outside, join(root, 'out')),
    });
    try {
      expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('top secret\n');
      expect(outcome.sessions.root.events.some((event) => event.type === 'workspace/changes')).toBe(
        false,
      );
    } finally {
      await outcome.close();
    }
  });

  it('danger-full-access：照 dsh 列出來，`path` 是主機絕對路徑，diff 帶內容', async () => {
    // dsh README 的已知限制：比較會把工作區外的檔的全文送到 client；必須把這類內容留在 Host 上的部署要把
    // 這個 plugin 組合出去。瀏覽器那端是通過會話認證（#424）的同一個人，讀得到的也是 harness 行程本來就讀得到的。
    const outside = await outsideDirectory();
    const outcome = await run(THROUGH_LINK, FILES, {
      mode: 'danger-full-access',
      setup: (root) => symlink(outside, join(root, 'out')),
    });
    try {
      const target = join(await realpath(outside), 'secret.txt');
      const event = outcome.sessions.root.events.find(
        (entry) => entry.type === 'workspace/changes',
      );
      expect(event).toBeDefined();
      const summary = await outcome.get(`${changesSummaryPath(THREAD_ID)}?seq=${event!.seq}`);
      expect(await summary.json()).toEqual({
        files: [{ path: target, display: target, added: 1, deleted: 1 }],
        total: 1,
        added: 1,
        deleted: 1,
      });
      const diff = await outcome.get(`${changesDiffPath(THREAD_ID)}?seq=${event!.seq}&index=0`);
      expect(await diff.json()).toMatchObject({
        path: target,
        hunks: [{ lines: ['-top secret', '+no secret'] }],
      });
    } finally {
      await outcome.close();
    }
  });
});

describe('工作區是 git repo（#461）', () => {
  it('檔案工具以外的改動（像 MCP 工具在外面寫的）也列出來，行數由 git 算', async () => {
    let workspace = '';
    const external: PluginEntry = {
      plugin: {
        name: 'external-writer',
        apply(registry) {
          registry.tools.register(
            tool(
              async () => {
                await writeFile(join(workspace, 'notes.md'), 'n1\nn2\n');
                return '寫好了';
              },
              { name: 'external_write', description: '在外面寫檔。', schema: z.object({}) },
            ),
          );
        },
      },
    };
    const outcome = await run(
      [
        { content: '寫。', toolCalls: [{ name: 'external_write', args: {} }] },
        { content: '好了。' },
      ],
      { 'a.md': 'a\n' },
      {
        plugins: [external],
        setup: async (root) => {
          workspace = root;
          const env = Object.fromEntries(
            Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
          );
          const git = (...args: string[]) =>
            execFileSync(
              'git',
              ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args],
              {
                cwd: root,
                env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
                stdio: 'pipe',
              },
            );
          git('init', '-q');
          git('add', '-A');
          git('commit', '-q', '-m', 'init');
        },
      },
    );
    try {
      const [payload] = changesIn(outcome.live) as { seq: number }[];
      const query = `?seq=${payload!.seq}`;
      const summary = await outcome.get(`${changesSummaryPath(THREAD_ID)}${query}`);
      expect(await summary.json()).toEqual({
        files: [{ path: 'notes.md', display: 'notes.md', added: 2, deleted: 0 }],
        total: 1,
        added: 2,
        deleted: 0,
      });
      const diff = await outcome.get(`${changesDiffPath(THREAD_ID)}${query}&index=0`);
      expect(await diff.json()).toMatchObject({
        kind: 'text',
        before: false,
        after: true,
        hunks: [{ lines: ['+n1', '+n2'] }],
      });
      expect(outcome.violations).toEqual([]);
    } finally {
      await outcome.close();
    }
  });
});
