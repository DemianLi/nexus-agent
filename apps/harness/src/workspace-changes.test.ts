/**
 * **每一輪的改動紀錄在真的圖、真的 pump、歷史路由與兩條 `changes` 路由上跑一次**——
 * [#443](https://github.com/DemianLi/nexus-agent/issues/443) 的端到端驗收。
 *
 * `@nexus/plugin-workspace-changes` 自己的測試走 registry 那一層，證得了時序（核准點、中止、下一輪已開）；
 * 證不了的是：
 *
 * 1. 工具真的經過 `tools/execute`、一輪真的派到 `agent/turn-stopping`——事件落在 root 日誌那一輪的 `turn/end` 之前。
 * 2. **即時與重新整理產出同一顆 `custom` frame**，帶的 `seq` 拿得到摘要；折疊器各折出同一格，拿掉它畫面不變。
 * 3. 兩條路由的載體：座標、media type、404、`no-store`。
 * 4. 子代理用檔案工具改的檔算進 root 那一輪。
 * 5. 暫存目錄是 `0700`，thread 收掉時整個刪掉。
 * 6. 組裝點只在 serve、有 `--workspace` 時掛。
 * 7. 工作區是 git repo 時，檔案工具以外的改動也在摘要裡（[#461](https://github.com/DemianLi/nexus-agent/issues/461)）。
 * 8. 被核准閘門拒絕、被子代理工具過濾擋下的呼叫不擷取；插話跳回模型時不算一輪停了，真的停時只記一次。
 *
 * **走產品組裝**（#670）：agent 是 `createCliAgent`（`workspaceChanges: true`、`--workspace`、`--sandbox`）組的，改動紀錄那顆 plugin、
 * backend、沙箱控制器都是組裝點建的，模型換成清單上的腳本提供者。暫存根產品組裝不給（預設 `os.tmpdir()`），
 * 所以這裡把 `TMPDIR` 指到測試自己的目錄，量「暫存目錄是 0700、收掉時刪掉」。
 *
 * **零憑證、零外部連線**：模型是腳本，工作區與暫存根都是暫存目錄，測試不碰真的 `~/.nexus-agent`。
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
import type {
  InvariantError,
  PluginEntry,
  SandboxMode,
  SessionEvent,
  SessionRegistry,
} from '@nexus/core';
import { withModelCallStep } from '@nexus/core';
import type { Event } from '@nexus/wire';
import {
  changesDiffPath,
  changesDiffUrl,
  changesSummaryPath,
  changesSummaryUrl,
  createWireClient,
  emptyConversation,
  isChangesDiff,
  isChangesSummary,
  reduceAll,
  WORKSPACE_CHANGES,
} from '@nexus/wire';
import { createMiddleware } from 'langchain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createCliAgent } from './assembly-root.js';
import {
  TEST_BROWSER_AUTH,
  loopbackRequest,
  shippedPlugins,
  shippedPluginsWithFullAccess,
  shippedServePlugins,
  withScriptedModel,
} from './fixtures.js';
import { loadPluginConfig, serveShippedConfigPath } from './plugin-config.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

// 「每一輪改了哪些檔」那一列在 serve 專屬層（`cordis.serve.yml`，#669 第 4 步）：這支測試的產品組裝是 serve 的那一份，
// CLI 的（`shippedPlugins`）只在「組裝點」那幾條拿來對照。
const shipped = await shippedServePlugins();
const cliShipped = await shippedPlugins();

const BASE_URL = 'http://changes.test';
const THREAD_ID = 'changes';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
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
    /** 換掉底下那份出貨清單（例如把 `workspace-changes` 那一列停用）；省略是 serve 的出貨清單。 */
    rows?: readonly PluginEntry[];
    /** `false` ＝ 不給 `--workspace`（檔案落在虛擬檔案系統）；省略是給。 */
    workspace?: boolean;
    /** `never` ＝ 沒有人核准，閘門說要問的呼叫一律拒絕；省略照 `--sandbox` 推。 */
    approvalPolicy?: 'never';
    /** 第 `afterModelCall` 次模型呼叫回來時，經 wire 插一句話（`mode: 'steer'`）；給了才開插話。 */
    steer?: { readonly afterModelCall: number; readonly text: string };
  } = {},
): Promise<Outcome> {
  const root = await directory('nexus-changes-e2e-');
  const tempRoot = await directory('nexus-changes-temp-');
  for (const [name, content] of Object.entries(files)) await writeFile(join(root, name), content);
  await options.setup?.(root);
  // 產品組裝的暫存根是 `os.tmpdir()`（出貨那一列沒給 `tempRoot`），指到這一份的 `TMPDIR`
  // 才量得到它的內容；`afterEach` 還原。
  vi.stubEnv('TMPDIR', tempRoot);
  const violations: string[] = [];
  const steerTo: { client?: ReturnType<typeof createWireClient> } = {};
  const steer = options.steer;
  const steerRow: readonly PluginEntry[] =
    steer === undefined
      ? []
      : [
          {
            plugin: {
              name: 'steer-after-model-call',
              apply(registry) {
                let calls = 0;
                registry.middleware.use(
                  withModelCallStep(
                    async (request, next) => {
                      const response = await next(request);
                      calls += 1;
                      if (calls === steer.afterModelCall) {
                        await steerTo.client!.runStart(THREAD_ID, steer.text, { mode: 'steer' });
                      }
                      return response;
                    },
                    (wrapModelCall) =>
                      createMiddleware({
                        name: 'steerAfterModelCall',
                        wrapModelCall: wrapModelCall as never,
                      }),
                  ),
                );
              },
            },
          },
        ];
  const built = await createCliAgent(
    {
      live: false,
      ...(options.workspace !== false && {
        workspace: root,
        sandbox: options.mode ?? 'workspace-write',
      }),
      ...(options.approvalPolicy !== undefined && { approvalPolicy: options.approvalPolicy }),
      ...(steer !== undefined && { stepInbox: true }),
    },
    withScriptedModel(
      [...(options.rows ?? shipped), WORKER, ...steerRow, ...(options.plugins ?? [])],
      turns,
    ),
    root,
    { onInvariantViolation: (error: InvariantError) => void violations.push(error.message) },
  );
  const model = built.model as ScriptedChatModel;
  let sessions: SessionRegistry | undefined;
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    createAgent: async () => ({
      agent: built.agent as unknown as PumpAgent,
      commands: built.commands,
      dispose: built.dispose,
      workspaceChanges: built.workspaceChanges,
      stepInbox: built.stepInbox,
      attachSessions: (registry, backgroundPort) => {
        sessions = registry;
        return built.attachSessions(registry, backgroundPort);
      },
    }),
  });
  const client = createWireClient({
    baseUrl: BASE_URL,
    fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
  });
  steerTo.client = client;
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
      // 時刻兩條路的時鐘不同（#1030）：即時是 pump 合成那一刻、歷史是日誌那一筆，這裡只比內容。
      const entry = {
        kind: 'workspace-changes',
        id: `workspace-changes:${seq}`,
        seq,
        startedAt: expect.any(Number),
      };
      expect(folded).toEqual([[entry], [entry]]);

      // **builder 的輸出先對手寫的字串，再把同一段手寫的查詢送進真的 handler**（照 dsh 的 host spec，
      // `changes-open.host.spec.ts`）：wire 把參數改名而 handler 沒跟上，這一行先紅；反過來 handler 改名而
      // builder 沒跟上，下面的請求 400。兩邊都拼自己的字串時，兩邊一起改，全綠，web 照舊送舊名。
      expect(changesSummaryUrl(THREAD_ID, seq)).toBe(`${changesSummaryPath(THREAD_ID)}?seq=${seq}`);
      expect(changesDiffUrl(THREAD_ID, seq, 2)).toBe(
        `${changesDiffPath(THREAD_ID)}?seq=${seq}&index=2`,
      );
      const summary = await outcome.get(`${changesSummaryPath(THREAD_ID)}?seq=${seq}`);
      expect(summary.status).toBe(200);
      expect(summary.headers.get('cache-control')).toBe('no-store');
      const summaryBody: unknown = await summary.json();
      // 回應過 wire 的 validator：server 改了形狀而 validator 沒跟上，web 會把卡當成讀壞（dsh 沒有這一條）。
      expect(isChangesSummary(summaryBody)).toBe(true);
      expect(summaryBody).toEqual({
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
      const diffBody: unknown = await diff.json();
      expect(isChangesDiff(diffBody)).toBe(true);
      expect(diffBody).toEqual({
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
      const createdBody: unknown = await created.json();
      expect(isChangesDiff(createdBody)).toBe(true);
      expect(createdBody).toMatchObject({ path: 'new.md', before: false, after: true });
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

  it('子代理的 copy_file（#2311）：root 那一輪的摘要裡目的地帶 copiedFrom，跟子代理日誌的 meta 一樣', async () => {
    const outcome = await run(
      [
        {
          content: '委派。',
          toolCalls: [{ name: 'task', args: { description: '複製', subagent_type: 'worker' } }],
        },
        {
          content: '子代理複製。',
          toolCalls: [
            { name: 'copy_file', args: { source_path: '/a.md', destination_path: '/b.md' } },
          ],
        },
        { content: '子代理收工。' },
        { content: '根收工。' },
      ],
      { 'a.md': 'one\ntwo\n' },
    );
    try {
      expect(await readFile(join(outcome.root, 'b.md'), 'utf8')).toBe('one\ntwo\n');
      const metas = outcome.sessions
        .list()
        .filter((entry) => entry.address.kind === 'subagent')
        .flatMap((entry) => entry.log.events)
        .flatMap((event) => (event.type === 'tool/result' ? [event.data.meta] : []))
        .filter((meta) => (meta as { operation?: unknown } | undefined)?.operation === 'copy');
      expect(metas).toHaveLength(1);
      const { source, bytes, sha256 } = metas[0] as {
        source: string;
        bytes: number;
        sha256: string;
      };
      const [event] = outcome.sessions.root.events.filter(
        (entry) => entry.type === 'workspace/changes',
      );
      expect(event).toBeDefined();
      const summary = await outcome.get(`${changesSummaryPath(THREAD_ID)}?seq=${event!.seq}`);
      expect(await summary.json()).toMatchObject({
        files: [{ path: 'b.md', added: 2, deleted: 0, copiedFrom: { source, bytes, sha256 } }],
        total: 1,
      });
      expect(source).toBe('/a.md');
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

/** serve 出貨清單上把 `workspace-changes` 那一列停用（patch 寫 `disabled: true` 的效果）。 */
function withoutChangesRow(rows: readonly PluginEntry[]): readonly PluginEntry[] {
  expect(rows.some((entry) => entry.id === 'workspace-changes')).toBe(true);
  return rows.map((entry) =>
    entry.id === 'workspace-changes' ? { ...entry, disabled: true as const } : entry,
  );
}

describe('關掉那一列（#669）', () => {
  it('改動卡的兩條路由與沒給 --workspace 時反應相同：不寫 workspace/changes、路由 404', async () => {
    const disabled = await run(EDIT_THREE, FILES, { rows: withoutChangesRow(shipped) });
    const absent = await run(EDIT_THREE, FILES, { workspace: false });
    try {
      for (const outcome of [disabled, absent]) {
        expect(outcome.sessions.root.events.some((e) => e.type === 'workspace/changes')).toBe(
          false,
        );
        expect(changesIn(outcome.live)).toEqual([]);
        expect(changesIn(outcome.history)).toEqual([]);
      }
      const probes = [
        `${changesSummaryPath(THREAD_ID)}?seq=1`,
        `${changesDiffPath(THREAD_ID)}?seq=1&index=0`,
      ];
      for (const path of probes) {
        const [a, b] = await Promise.all([disabled.get(path), absent.get(path)]);
        expect(a.status, path).toBe(404);
        expect(b.status, path).toBe(404);
        expect(await a.text(), path).toBe(await b.text());
      }
    } finally {
      await disabled.close();
      await absent.close();
    }
  });
});

describe('組裝點', () => {
  it('serve 的出貨清單有這一列、CLI 的沒有；要有 --workspace、而且那一列沒被停用才掛', async () => {
    expect(shipped.some((entry) => entry.id === 'workspace-changes')).toBe(true);
    expect(cliShipped.some((entry) => entry.id === 'workspace-changes')).toBe(false);
    const workspace = await directory('nexus-changes-cli-');
    const cases: [string, Parameters<typeof createCliAgent>[0], readonly PluginEntry[], boolean][] =
      [
        ['serve＋工作區', { live: false, workspace }, shipped, true],
        ['serve 沒有工作區', { live: false }, shipped, false],
        ['CLI＋工作區', { live: false, workspace }, cliShipped, false],
        [
          'serve＋工作區，那一列停用',
          { live: false, workspace },
          withoutChangesRow(shipped),
          false,
        ],
      ];
    for (const [label, invocation, rows, mounted] of cases) {
      const built = await createCliAgent(invocation, rows);
      try {
        expect(built.workspaceChanges !== undefined, label).toBe(mounted);
      } finally {
        await built.dispose();
      }
    }
  });

  /**
   * **兩次組裝各拿各的一份**（[#459](https://github.com/DemianLi/nexus-agent/issues/459)）。
   *
   * 從前工廠回的那一份帶著閉包狀態，所以「一份只能掛一次組裝」要用一顆 `applied` 旗標擋。
   * 現在狀態住在 `apply` 裡，而 `serve-run.ts` 每條 thread 各跑一次 `createCliAgent`（`:341`）——
   * 這一條釘的是「`createCliAgent` 交出來的是這一次組裝提供的那一份」。服務名寫錯、或
   * `provide` 整個拿掉，這裡就是 `undefined`。
   */
  it('兩次 createCliAgent 各拿各的一份', async () => {
    const workspace = await directory('nexus-changes-cli-');
    const invocation = { live: false, workspace } as const;
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
      // 出廠表沒有全開（#1621）：部署方加回那一組之後才起得來。
      rows: await shippedPluginsWithFullAccess({ serve: true }),
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

/** 一個在外面寫 `/b.md` 的工具。工作區不是 git repo 時，改動紀錄只認檔案工具：這一顆寫的檔，只有先被擷取過才會列出來。 */
function bWriter(root: () => string): PluginEntry {
  return {
    plugin: {
      name: 'b-writer',
      apply(registry) {
        registry.tools.register(
          tool(
            async () => {
              await writeFile(join(root(), 'b.md'), 'from outside\n');
              return '寫好了';
            },
            { name: 'write_b', description: '在外面寫 b.md。', schema: z.object({}) },
          ),
        );
      },
    },
  };
}

/** 記下每一次 `agent/turn-stopping` 的 `step`。 */
function turnStoppingSteps(): { readonly entry: PluginEntry; readonly steps: number[] } {
  const steps: number[] = [];
  return {
    steps,
    entry: {
      plugin: {
        name: 'turn-stopping-probe',
        apply(registry) {
          registry.events.on('agent/turn-stopping', ({ step }) => void steps.push(step));
        },
      },
    },
  };
}

/** 這份日誌上叫 `name` 的那幾顆呼叫的 `tool/result`。 */
function resultsOf(events: readonly SessionEvent[], name: string): { isError: boolean }[] {
  const ids = new Set(
    events
      .filter((event) => event.type === 'tool/call')
      .map((event) => event.data as { callId: string; name: string })
      .filter((call) => call.name === name)
      .map((call) => call.callId),
  );
  return events
    .filter((event) => event.type === 'tool/result')
    .map((event) => event.data as { callId: string; isError: boolean })
    .filter((result) => ids.has(result.callId))
    .map(({ isError }) => ({ isError }));
}

const WRITE_B: ScriptedTurn = {
  content: '寫 b。',
  toolCalls: [{ name: 'write_file', args: { file_path: '/b.md', content: 'b\n' } }],
};
const OUTSIDE_B: ScriptedTurn = {
  content: '在外面寫。',
  toolCalls: [{ name: 'write_b', args: {} }],
};

/** serve 出貨清單疊一份 patch，把子代理的 `write_file` 遮掉（`background-subagents` 的 `toolFilter`）。 */
async function serveRowsDenyingWriteFile(): Promise<readonly PluginEntry[]> {
  const dir = await directory('nexus-changes-patch-');
  const patch = join(dir, 'deny.patch.yml');
  await writeFile(
    patch,
    JSON.stringify([
      { id: 'background-subagents', config: { toolFilter: { deny: ['write_file'] } } },
    ]),
  );
  const { plugins, dropped } = await loadPluginConfig({
    shippedLayers: [serveShippedConfigPath()],
    overlays: [patch],
  });
  expect(dropped).toEqual([]);
  return plugins;
}

describe('擷取的時點與一輪停在哪', () => {
  it('被核准閘門拒絕的 write_file 不擷取：之後同一個檔在外面被寫，這一輪不列', async () => {
    let workspace = '';
    const gate: PluginEntry = {
      plugin: {
        name: 'gate-write-file',
        apply(registry) {
          registry.approvals.gate((exec, next) =>
            exec.name === 'write_file' ? { kind: 'ask', reason: '先給人看' } : next(),
          );
        },
      },
    };
    const outcome = await run([WRITE_B, OUTSIDE_B, { content: '好了。' }], FILES, {
      plugins: [gate, bWriter(() => workspace)],
      approvalPolicy: 'never',
      setup: async (root) => void (workspace = root),
    });
    try {
      const events = outcome.sessions.root.events;
      expect(resultsOf(events, 'write_file')).toEqual([{ isError: true }]);
      expect(await readFile(join(outcome.root, 'b.md'), 'utf8')).toBe('from outside\n');
      expect(events.some((event) => event.type === 'workspace/changes')).toBe(false);
      expect(changesIn(outcome.live)).toEqual([]);
      expect(outcome.violations).toEqual([]);
    } finally {
      await outcome.close();
    }
  });

  it('子代理被工具過濾擋下的 write_file 不擷取：之後同一個檔在外面被寫，root 這一輪不列', async () => {
    let workspace = '';
    const outcome = await run(
      [
        {
          content: '委派。',
          toolCalls: [{ name: 'task', args: { description: '寫檔', subagent_type: 'worker' } }],
        },
        WRITE_B,
        { content: '子代理收工。' },
        OUTSIDE_B,
        { content: '根收工。' },
      ],
      FILES,
      {
        rows: await serveRowsDenyingWriteFile(),
        plugins: [bWriter(() => workspace)],
        setup: async (root) => void (workspace = root),
      },
    );
    try {
      const subagentEvents = outcome.sessions
        .list()
        .filter((entry) => entry.address.kind === 'subagent')
        .flatMap((entry) => entry.log.events);
      expect(resultsOf(subagentEvents, 'write_file')).toEqual([{ isError: true }]);
      expect(await readFile(join(outcome.root, 'b.md'), 'utf8')).toBe('from outside\n');
      expect(outcome.sessions.root.events.some((event) => event.type === 'workspace/changes')).toBe(
        false,
      );
      expect(outcome.violations).toEqual([]);
    } finally {
      await outcome.close();
    }
  });

  it('插話跳回模型時不算停：agent/turn-stopping 只派一次，兩段改的檔記在同一顆 workspace/changes', async () => {
    const probe = turnStoppingSteps();
    const outcome = await run(
      [
        WRITE_B,
        { content: '說完了。' },
        {
          content: '收到插話。',
          toolCalls: [{ name: 'write_file', args: { file_path: '/c.md', content: 'c\n' } }],
        },
        { content: '都好了。' },
      ],
      FILES,
      { plugins: [probe.entry], steer: { afterModelCall: 2, text: '再寫一個。' } },
    );
    try {
      const events = outcome.sessions.root.events;
      expect(await readFile(join(outcome.root, 'c.md'), 'utf8')).toBe('c\n');
      expect(events.filter((event) => event.type === 'turn/start')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'turn/end')).toHaveLength(1);
      expect(probe.steps).toHaveLength(1);
      const changes = events.filter((event) => event.type === 'workspace/changes');
      expect(changes).toHaveLength(1);
      const summary = await outcome.get(`${changesSummaryPath(THREAD_ID)}?seq=${changes[0]!.seq}`);
      expect(await summary.json()).toMatchObject({
        files: [{ path: 'b.md' }, { path: 'c.md' }],
        total: 2,
      });
      expect(outcome.violations).toEqual([]);
    } finally {
      await outcome.close();
    }
  });

  it('langgraph 下轉接格派的 step 是 0', async () => {
    const probe = turnStoppingSteps();
    const outcome = await run([WRITE_B, { content: '好了。' }], FILES, { plugins: [probe.entry] });
    try {
      expect(probe.steps).toEqual([0]);
    } finally {
      await outcome.close();
    }
  });
});
