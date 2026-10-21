/**
 * present 在 Cordis 樹上：`tools/result` 觀察者與 fs 把手（`hasWorkspace()`、併了 mounts 的 `offWorkspacePrefixes()`）兩個接縫
 * （[#1469](https://github.com/DemianLi/nexus-agent/issues/1469)，逐條 thread 接縫的第五段）：驗收 B、D、E。
 * 量的是產品路徑——真的 `createCordisRoot`、真的 `loadDefaultPlugins`（帶樹）、真的寫入口 `changePlugin`、真的相容層
 * `assembly.create`（serve 每條 thread 一次）、真的 `attachSessions`、真的檔案系統 backend；不手搭 `ctx.plugin`。
 *
 * 驗收 A（SDK lint、一致性套件、套一次服務兩條 thread）在 `packages/nexus-plugin-present` 與 `migrated-plugin-gate.test.ts`；
 * 驗收 F（既有測試的斷言一個字不動）是 `present-tool.test.ts`、`deliverable-files.test.ts`、`present-delivery-differential.test.ts`、
 * `serve-scripted-provider.test.ts`、`submit-record-mounts.test.ts`；驗收 C（golden）是一次性錄製，做法與數字寫在 PR 內文。
 *
 * **E 的核心風險**：交付寫進哪一份日誌，靠 `tools/result` 的 `exec.thread` 與會話查找兩邊對得上。行程裡活著兩條以上的 thread 時，
 * 認錯的樣子是「一條 thread 的交付寫進另一條的日誌」，而兩邊各自都寫成功——沒有任何例外。所以這一檔所有「第二條 thread 活著」的格子，
 * 都先把另一條 thread 開著、不收，再從這一條呼叫；兩條 thread 還刻意用**同一個 `callId`**。
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import {
  SessionRegistry,
  callThreadId,
  createHostServicesPlugin,
  loadPlugins,
  toolCallSessionAddress,
} from '@nexus/core';
import type { PluginEntry, SessionEvent } from '@nexus/core';
import type { FsLookupService } from '@nexus/fs';
import { PRESENT_NO_WORKSPACE_MESSAGE, PRESENT_TOOL_NAME } from '@nexus/plugin-present';
import { afterEach, describe, expect, it } from 'vitest';

import { createCliAgent } from './assembly-root.js';
import { runCli } from './cli.js';
import { createCordisRoot, entryApprovalChannel } from './cordis-root.js';
import type { CordisRoot, NexusAssembly } from './cordis-root.js';
import { withScriptedModel } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { HEADLESS_APPROVALS } from './agent-factory.js';
import { toAgentInvocation } from './messages.js';
import { changePlugin } from './plugin-change.js';
import { isBridgeEntry, loadDefaultPlugins } from './plugin-config.js';
import type { LoadedPluginConfig } from './plugin-config.js';
import { buildPluginSnapshot } from './plugin-snapshot.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { scriptedPatchText } from './scripted-serve.js';
import { auditStartupEntries } from './startup-audit.js';
import { writeFile } from 'node:fs/promises';

const temporary: string[] = [];
const roots: CordisRoot[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await root.dispose().catch(() => {});
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix = 'nexus-present-tree-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(dir, 0o700);
  temporary.push(dir);
  return dir;
}

function home(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = scratch();
  return { dir, env: { [HARNESS_HOME_ENV]: dir } };
}

/** 入口怎麼建樹就怎麼建（serve：有人在）。 */
function newRoot(): CordisRoot {
  const root = createCordisRoot({
    channel: entryApprovalChannel(undefined),
    contained: true,
  });
  roots.push(root);
  return root;
}

const warnNothing = (): void => {};
const ID = 'present';

/** 一個有檔案的工作區。 */
function workspaceWith(files: Record<string, string>): string {
  const dir = scratch('nexus-present-ws-');
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

/** 一顆 `present` 呼叫；`id` 給了就用它當 `callId`（兩條 thread 撞同一個）。 */
function presentCall(path: string, id?: string) {
  return {
    name: PRESENT_TOOL_NAME,
    ...(id === undefined ? {} : { id }),
    args: { files: [{ path }] },
  };
}

/** 呼叫一次、收工。 */
function presentTurns(path: string, id?: string): readonly ScriptedTurn[] {
  return [{ content: '', toolCalls: [presentCall(path, id)] }, { content: '收工。' }];
}

/** 登記一個名叫 `worker` 的子代理（繼承根的工具）；可以給它自己的模型。 */
function workerSource(model?: ScriptedChatModel): PluginEntry {
  return {
    plugin: {
      name: 'worker-source',
      apply(registry) {
        registry.subagents.register({
          name: 'worker',
          description: '幹活的。',
          systemPrompt: '你是 worker。',
          ...(model === undefined ? {} : { model: model as never }),
        });
      },
    },
  };
}

interface Booted {
  readonly root: CordisRoot;
  readonly loaded: LoadedPluginConfig;
  readonly assembly: NexusAssembly;
  readonly env: NodeJS.ProcessEnv;
}

/** 入口的順序：讀清單（帶樹）→ 建根、掛相容層與入口那一列。 */
async function boot(env: NodeJS.ProcessEnv, root: CordisRoot = newRoot()): Promise<Booted> {
  const loaded = await loadDefaultPlugins({ env, warn: warnNothing }, { tree: root.tree });
  const assembly = await root.boot('serve', { plugins: loaded.plugins });
  return { root, loaded, assembly, env };
}

interface OpenThread {
  readonly built: Awaited<ReturnType<NexusAssembly['create']>>;
  readonly sessions: SessionRegistry;
  readonly attachment: ReturnType<Awaited<ReturnType<NexusAssembly['create']>>['attachSessions']>;
  readonly threadId: string;
  readonly workspace: string | undefined;
}

/**
 * serve 的形狀：這條 thread 自己一次相容層組裝（自己的腳本模型、自己的工作區），自己一張註冊表，經 `attachSessions` 接上。
 * 回來的 thread **不收**：呼叫端決定它活多久。`noWorkspace` 是沒給 `--workspace` 的組裝。
 */
async function openThread(
  booted: Booted,
  threadId: string,
  turns: readonly ScriptedTurn[],
  options: {
    readonly files?: Record<string, string>;
    readonly noWorkspace?: boolean;
    readonly extra?: readonly PluginEntry[];
    readonly invocation?: Partial<Parameters<NexusAssembly['create']>[0]>;
    readonly loaded?: LoadedPluginConfig;
  } = {},
): Promise<OpenThread> {
  const workspace = options.noWorkspace === true ? undefined : workspaceWith(options.files ?? {});
  const base = options.loaded ?? booted.loaded;
  const plugins = withScriptedModel([...base.plugins, ...(options.extra ?? [])], turns);
  const built = await booted.assembly.create(
    {
      live: false,
      ...(workspace === undefined ? {} : { workspace, sandbox: 'workspace-write' as const }),
      ...options.invocation,
    },
    { plugins },
  );
  const sessions = new SessionRegistry(threadId);
  const attachment = built.attachSessions(sessions);
  return { built, sessions, attachment, threadId, workspace };
}

/** 以這條 thread 的身分跑一次（一個 human 訊息）。 */
async function runOn(thread: OpenThread, text = '交付吧。'): Promise<unknown> {
  return thread.built.agent.invoke(toAgentInvocation(text), {
    configurable: { thread_id: thread.threadId },
  });
}

async function closeThread(thread: OpenThread): Promise<void> {
  await thread.attachment.detach();
  await thread.built.dispose();
}

async function until(predicate: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 一份日誌上的交付事件。 */
function deliveriesOf(sessions: SessionRegistry, which: 'root' | 'all' = 'root') {
  const logs = which === 'root' ? [sessions.root] : sessions.list().map((entry) => entry.log);
  return logs.flatMap((log) =>
    log.events.filter(
      (event): event is SessionEvent<'deliverables/presented'> =>
        event.type === 'deliverables/presented',
    ),
  );
}

/** 一份日誌上跟工具呼叫有關的三種事件，照次序。 */
function callShape(log: SessionRegistry['root']): string[] {
  return log.events
    .map((event) => event.type)
    .filter((type) => ['tool/call', 'deliverables/presented', 'tool/result'].includes(type));
}

/**
 * 直接叫樹上那顆 `present` 一次（不經模型）：拿掛著 present 那一列的橋接條目掛進一份空的 registry，取出工具。
 * **fs 與會話查找走的是樹上那兩列**（`bindToTree` 的條目不帶自己的查找）；`tools/result` 觀察者是折進這份 registry 的那一位。
 */
async function bareTool(loaded: LoadedPluginConfig) {
  const entry = loaded.plugins.find((candidate) => loaded.rows.get(candidate)?.id === ID);
  if (entry === undefined) throw new Error('清單上沒有 present');
  const { registry, dispose } = await loadPlugins([createHostServicesPlugin({}), entry]);
  const resolved = registry.tools.resolve(PRESENT_TOOL_NAME);
  if (resolved === undefined) throw new Error('工具沒登記上');
  return { tool: resolved.value, registry, dispose };
}

/** 一次呼叫的設定：`thread_id`、`checkpoint_ns` 與 `toolCall.id` 都帶，同圖裡的樣子。 */
const configOf = (thread: string, callId: string) => ({
  configurable: { thread_id: thread, checkpoint_ns: 'tools:call' },
  toolCall: { id: callId },
});

/** 照圍堵的順序落定：先派發 `tools/result`（給折進這份 registry 的每一位觀察者），再記 `tool/result`。 */
function settle(
  registry: Awaited<ReturnType<typeof bareTool>>['registry'],
  log: SessionRegistry['root'],
  config: ReturnType<typeof configOf>,
  isError = false,
): void {
  const callId = config.toolCall.id;
  registry.dispatch.observe(
    'tools/result',
    (error: unknown) => {
      throw error;
    },
    {
      callId,
      name: PRESENT_TOOL_NAME,
      args: {},
      agent: toolCallSessionAddress(config),
      thread: callThreadId(config),
    },
    { kind: 'message', content: '', isError },
  );
  log.append('tool/result', { callId, isError });
}

describe('B：出貨清單上的 present 經樹進來，位置與名字不變', () => {
  it('是橋接列、樹上 present 與 fs 兩列都 ACTIVE、沒有掉列；啟動稽核過；快照上是 mounted', async () => {
    const { env } = home();
    const root = newRoot();
    const loaded = await loadDefaultPlugins({ env, warn: warnNothing }, { tree: root.tree });
    const entry = loaded.plugins.find((candidate) => loaded.rows.get(candidate)?.id === ID);
    expect(entry).toBeDefined();
    expect(entry !== undefined && isBridgeEntry(entry)).toBe(true);
    expect(entry?.plugin.name).toBe('present');
    expect(loaded.dropped).toEqual([]);
    expect(loaded.rows.get(entry as never)).toEqual({ id: ID, module: '@nexus/plugin-present' });
    expect(() => auditStartupEntries(loaded, { live: false })).not.toThrow();

    const tree = await root.tree.context();
    expect(tree.loader.resolve(`include:${ID}`).fiber?.ctx.fiber.state).toBe(2);
    expect(tree.loader.resolve('fs').fiber?.ctx.fiber.state).toBe(2);

    const source = {
      entries: loaded.entries,
      ids: loaded.ids,
      plugins: loaded.plugins,
      rows: loaded.rows,
      drops: loaded.dropped.map(({ id, stage }) => ({ id, stage })),
    };
    const snapshot = buildPluginSnapshot({
      running: source,
      saved: source,
      generatedAt: new Date(0),
    });
    expect(snapshot.rows.find((row) => row.id === ID)).toMatchObject({
      module: '@nexus/plugin-present',
      running: { state: 'mounted' },
      saved: { state: 'mounted' },
      sync: 'same',
    });
  }, 60000);

  it('契約版本：tools 服務 1.3.0（onResult）、fs 查找服務 2.0.0（hasWorkspace 加 #1469、行程級 workspaceRoot 加 #1491、#1774 改逐條 thread 後跳 major）', async () => {
    const { env } = home();
    const root = newRoot();
    await loadDefaultPlugins({ env, warn: warnNothing }, { tree: root.tree });
    const tree = await root.tree.context();
    expect((tree.get('tools') as { contractVersion?: string } | undefined)?.contractVersion).toBe(
      '1.3.0',
    );
    expect((tree.get('fs') as { contractVersion?: string } | undefined)?.contractVersion).toBe(
      '2.0.0',
    );
  }, 60000);

  it('橋接列把 present 的 tools/result 觀察者折進 registry：只有一位，來源是 present', async () => {
    const { env } = home();
    const root = newRoot();
    const loaded = await loadDefaultPlugins({ env, warn: warnNothing }, { tree: root.tree });
    const { registry, dispose } = await bareTool(loaded);
    try {
      const listeners = registry.events.listeners().filter((item) => item.name === 'tools/result');
      expect(listeners).toHaveLength(1);
      expect(listeners[0]?.origin?.name).toBe('present');
    } finally {
      await dispose();
    }
  }, 60000);
});

describe('E：同一棵樹上多條 thread 同時活著，各自交付、各自的日誌', () => {
  it('兩條 serve thread 同時跑、**同一個 callId**：各自交付，日誌只有自己的那一筆，次序是 tool/call → 交付 → tool/result', async () => {
    const { env } = home();
    const booted = await boot(env);
    const a = await openThread(booted, 'thread-a', presentTurns('a.md', 'same'), {
      files: { 'a.md': '# 甲' },
    });
    const b = await openThread(booted, 'thread-b', presentTurns('b.md', 'same'), {
      files: { 'b.md': '# 乙' },
    });
    await Promise.all([runOn(a), runOn(b)]);

    expect(deliveriesOf(a.sessions, 'all').map((event) => event.data)).toEqual([
      { callId: 'same', files: [{ path: 'a.md' }] },
    ]);
    expect(deliveriesOf(b.sessions, 'all').map((event) => event.data)).toEqual([
      { callId: 'same', files: [{ path: 'b.md' }] },
    ]);
    expect(callShape(a.sessions.root)).toEqual([
      'tool/call',
      'deliverables/presented',
      'tool/result',
    ]);
    expect(callShape(b.sessions.root)).toEqual([
      'tool/call',
      'deliverables/presented',
      'tool/result',
    ]);
    await closeThread(a);
    await closeThread(b);
  }, 60000);

  it('同一個 callId 在兩條 thread 同時懸著（樹上）：各自落定、各進自己的日誌，不串', async () => {
    const { env } = home();
    const booted = await boot(env);
    const a = await openThread(booted, 'hang-a', [{ content: '待著。' }], {
      files: { 'a.md': '# 甲' },
    });
    const b = await openThread(booted, 'hang-b', [{ content: '待著。' }], {
      files: { 'b.md': '# 乙' },
    });
    const { tool, registry, dispose } = await bareTool(booted.loaded);
    try {
      const configA = configOf('hang-a', 'same');
      const configB = configOf('hang-b', 'same');
      // 兩條都叫了、都還沒落定：表上同時有兩筆，只差 thread 不同。
      await tool.invoke({ files: [{ path: 'a.md' }] }, configA as never);
      await tool.invoke({ files: [{ path: 'b.md' }] }, configB as never);
      expect(deliveriesOf(a.sessions, 'all')).toEqual([]);
      expect(deliveriesOf(b.sessions, 'all')).toEqual([]);

      settle(registry, a.sessions.root, configA);
      expect(deliveriesOf(a.sessions, 'all').map((event) => event.data)).toEqual([
        { callId: 'same', files: [{ path: 'a.md' }] },
      ]);
      expect(deliveriesOf(b.sessions, 'all')).toEqual([]);

      settle(registry, b.sessions.root, configB);
      expect(deliveriesOf(b.sessions, 'all').map((event) => event.data)).toEqual([
        { callId: 'same', files: [{ path: 'b.md' }] },
      ]);
      expect(deliveriesOf(a.sessions, 'all')).toHaveLength(1);
    } finally {
      await dispose();
      await closeThread(a);
      await closeThread(b);
    }
  }, 60000);

  it('一條 thread 的工作區裡沒有的檔，不會因為另一條有就交付得出去（fs 把手依 thread 挑）', async () => {
    const { env } = home();
    const booted = await boot(env);
    const a = await openThread(booted, 'only-a', presentTurns('a.md'), {
      files: { 'a.md': '# 甲' },
    });
    const b = await openThread(booted, 'only-b', presentTurns('a.md'), { files: {} });
    await Promise.all([runOn(a), runOn(b)]);

    expect(deliveriesOf(a.sessions, 'all')).toHaveLength(1);
    expect(deliveriesOf(b.sessions, 'all')).toEqual([]);
    await closeThread(a);
    await closeThread(b);
  }, 60000);

  it('第二條 thread 活著時，同步子代理（task）叫的 present 交付寫進子代理那一份，root 那一份沒有', async () => {
    const { env } = home();
    const booted = await boot(env);
    const other = await openThread(booted, 'other', [{ content: '待著。' }]);
    const mine = await openThread(
      booted,
      'mine',
      [
        {
          content: '委派。',
          toolCalls: [{ name: 'task', args: { description: '交付', subagent_type: 'worker' } }],
        },
        { content: '', toolCalls: [presentCall('r.md')] },
        { content: '子代理收工。' },
        { content: '根收工。' },
      ],
      { files: { 'r.md': '# 報告' }, extra: [workerSource()] },
    );
    await runOn(mine);

    expect(mine.sessions.list().map((entry) => entry.address.kind)).toEqual(['root', 'subagent']);
    expect(deliveriesOf(mine.sessions, 'root')).toEqual([]);
    const sub = mine.sessions.list().find((entry) => entry.address.kind === 'subagent');
    expect(sub?.log.events.filter((event) => event.type === 'deliverables/presented')).toHaveLength(
      1,
    );
    expect(deliveriesOf(other.sessions, 'all')).toEqual([]);
    await closeThread(mine);
    await closeThread(other);
  }, 60000);

  it('背景子代理（thread_id 是 <root>/<runId>）的交付寫進背景那一份；另一條 thread 與 root 都沒有', async () => {
    const { env } = home();
    const booted = await boot(env);
    const other = await openThread(booted, 'other-bg', [{ content: '待著。' }]);
    const worker = new ScriptedChatModel({
      turns: [{ content: '', toolCalls: [presentCall('r.md')] }, { content: '背景收工。' }],
    });
    const mine = await openThread(
      booted,
      'mine-bg',
      [
        {
          content: '委派。',
          toolCalls: [
            {
              name: 'subagent',
              id: 'root-call',
              args: { description: '交付', subagent_type: 'worker', run_in_background: true },
            },
          ],
        },
        { content: '根收尾。' },
      ],
      {
        files: { 'r.md': '# 報告' },
        extra: [workerSource(worker)],
        invocation: { backgroundSubagents: { maxActive: 8 } },
      },
    );
    await runOn(mine);
    await until(() =>
      mine.sessions
        .list()
        .some(
          (entry) =>
            entry.address.kind === 'subagent' &&
            entry.log.events.some((event) => event.type === 'turn/end'),
        ),
    );

    const background = mine.sessions.list().find((entry) => entry.address.kind === 'subagent');
    expect(background?.log.sessionId.startsWith('mine-bg/')).toBe(true);
    expect(
      background?.log.events.filter((event) => event.type === 'deliverables/presented'),
    ).toHaveLength(1);
    expect(deliveriesOf(mine.sessions, 'root')).toEqual([]);
    expect(deliveriesOf(other.sessions, 'all')).toEqual([]);
    await closeThread(mine);
    await closeThread(other);
  }, 60000);
});

describe('D：快照與壽命', () => {
  it('開著的 thread 在那一列被停用（變更紀錄）之後照樣交付、交付寫進日誌；下一條 thread 沒有這顆工具', async () => {
    const { env } = home();
    const booted = await boot(env);
    const first = await openThread(booted, 'open-thread', presentTurns('r.md'), {
      files: { 'r.md': '# 報告' },
    });

    await changePlugin({ op: 'disable', id: ID }, { env });
    const reread = await loadDefaultPlugins({ env, warn: warnNothing }, { tree: booted.root.tree });
    const second = await openThread(booted, 'next-thread', [{ content: '沒有那顆工具。' }], {
      loaded: reread,
      files: { 'r.md': '# 報告' },
    });
    const tree = await booted.root.tree.context();
    expect(tree.loader.resolve(`include:${ID}`).fiber?.ctx.fiber.state).toBe(4);

    await runOn(second, '看一下。');
    const bound = (second.built.model as unknown as { boundTools: { name: string }[] }).boundTools;
    expect(bound.map((tool) => tool.name)).not.toContain(PRESENT_TOOL_NAME);

    // 開著的那條：工具與觀察者在組 thread 時一起進快照，樹上那一列卸了也照樣成對可用（決議 §3-2 第 6 條、#1469 Q1／Q3）。
    await runOn(first);
    expect(deliveriesOf(first.sessions, 'all').map((event) => event.data)).toEqual([
      { callId: expect.any(String), files: [{ path: 'r.md' }] },
    ]);
    expect(callShape(first.sessions.root)).toEqual([
      'tool/call',
      'deliverables/presented',
      'tool/result',
    ]);
    expect(deliveriesOf(second.sessions, 'all')).toEqual([]);
    await closeThread(first);
    await closeThread(second);
  }, 90000);

  it('停用的那一刻剛好有一次呼叫懸著（本體跑完、結果還沒落定）：它的交付照樣寫得進日誌（Q3 (a)：表不在卸載時清）', async () => {
    const { env } = home();
    const booted = await boot(env);
    const thread = await openThread(booted, 'hanging', [{ content: '待著。' }], {
      files: { 'r.md': '# 報告' },
    });
    const { tool, registry, dispose } = await bareTool(booted.loaded);
    try {
      const config = configOf('hanging', 'late');
      thread.sessions.root.append('tool/call', {
        callId: 'late',
        name: PRESENT_TOOL_NAME,
        arguments: '{}',
      });
      const answer = await tool.invoke({ files: [{ path: 'r.md' }] }, config as never);
      expect(String((answer as { content?: unknown }).content ?? answer)).toBe('Presented r.md');
      expect(deliveriesOf(thread.sessions, 'all')).toEqual([]);

      await changePlugin({ op: 'disable', id: ID }, { env });
      await loadDefaultPlugins({ env, warn: warnNothing }, { tree: booted.root.tree });
      const tree = await booted.root.tree.context();
      expect(tree.loader.resolve(`include:${ID}`).fiber?.ctx.fiber.state).toBe(4);

      settle(registry, thread.sessions.root, config);
      expect(deliveriesOf(thread.sessions, 'all').map((event) => event.data)).toEqual([
        { callId: 'late', files: [{ path: 'r.md' }] },
      ]);
      expect(callShape(thread.sessions.root)).toEqual([
        'tool/call',
        'deliverables/presented',
        'tool/result',
      ]);
    } finally {
      await dispose();
      await closeThread(thread);
    }
  }, 90000);

  it('hasWorkspace()：給 --workspace 的組裝是 true、沒給的是 false，present 的拒絕與它一致（Q2 (a)）', async () => {
    const { env } = home();
    const booted = await boot(env);
    const withWorkspace = await openThread(booted, 'with-ws', presentTurns('r.md'), {
      files: { 'r.md': '# 報告' },
    });
    const withoutWorkspace = await openThread(booted, 'no-ws', presentTurns('r.md'), {
      noWorkspace: true,
    });
    const tree = await booted.root.tree.context();
    const fs = tree.get('fs') as FsLookupService;
    const lookup = (thread: string) =>
      fs.forCall({ configurable: { thread_id: thread, checkpoint_ns: 'tools:a' } });
    const yes = lookup('with-ws');
    const no = lookup('no-ws');
    expect(yes.kind === 'ok' && yes.fs.hasWorkspace()).toBe(true);
    expect(no.kind === 'ok' && no.fs.hasWorkspace()).toBe(false);

    await Promise.all([runOn(withWorkspace), runOn(withoutWorkspace)]);
    expect(deliveriesOf(withWorkspace.sessions, 'all')).toHaveLength(1);
    expect(deliveriesOf(withoutWorkspace.sessions, 'all')).toEqual([]);
    const refusal = JSON.stringify(
      withoutWorkspace.sessions.root.events.filter((event) => event.type === 'tool/result'),
    );
    expect(refusal).toContain('"isError":true');
    // 拒絕的原文在模型看到的那則工具訊息裡，這裡只釘「是錯誤、沒交付」；原文逐字由 `present-tool.test.ts` 釘。
    expect(PRESENT_NO_WORKSPACE_MESSAGE).toBe('present requires a workspace');
    await closeThread(withWorkspace);
    await closeThread(withoutWorkspace);
  }, 60000);
});

describe('三個入口各有一條（拿掉任一入口的接線要紅）', () => {
  it('CLI（runCli）：經樹上的內建列，交付寫進落盤的日誌', async () => {
    const dir = scratch();
    const workspace = workspaceWith({ 'r.md': '# 報告' });
    const patch = join(dir, 'scripted.patch.yml');
    await writeFile(patch, scriptedPatchText(presentTurns('r.md')), 'utf8');
    const lines: string[] = [];
    const record = (...parts: unknown[]): void => void lines.push(parts.join(' '));

    await runCli({
      argv: ['--patch', patch, '--workspace', workspace, '交付吧。'],
      input: new PassThrough(),
      output: new PassThrough(),
      printer: { log: record, error: record },
      env: { [HARNESS_HOME_ENV]: dir },
      cwd: workspace,
    });

    expect(lines.join('\n')).toContain('收工。');
    const sessionsDir = join(dir, 'sessions');
    // 每次組裝一個 run 目錄，裡面是 `<base>.jsonl`（`jsonl-session-store.ts`）；root 的日誌就是那一個檔。
    const logs = readdirSync(sessionsDir, { recursive: true, encoding: 'utf8' }).filter((name) =>
      name.endsWith('.jsonl'),
    );
    expect(logs).toHaveLength(1);
    const text = readFileSync(join(sessionsDir, logs[0]!), 'utf8');
    const kinds = text
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => (JSON.parse(line) as { type?: string }).type)
      .filter((type) =>
        ['tool/call', 'deliverables/presented', 'tool/result'].includes(type ?? ''),
      );
    expect(kinds).toEqual(['tool/call', 'deliverables/presented', 'tool/result']);
  }, 60000);

  it('CLI 的樹（boot "cli"）：交付寫進這條 thread 的日誌', async () => {
    const { env } = home();
    const root = createCordisRoot({
      channel: entryApprovalChannel(HEADLESS_APPROVALS),
      contained: true,
    });
    roots.push(root);
    const loaded = await loadDefaultPlugins({ env, warn: warnNothing }, { tree: root.tree });
    const assembly = await root.boot('cli', { plugins: loaded.plugins });
    const workspace = workspaceWith({ 'r.md': '# 報告' });
    const built = await assembly.create(
      { live: false, workspace, sandbox: 'workspace-write' },
      { plugins: withScriptedModel([...loaded.plugins], presentTurns('r.md')) },
    );
    const sessions = new SessionRegistry('cli-thread');
    const attachment = built.attachSessions(sessions);
    try {
      await built.agent.invoke(toAgentInvocation('交付吧。'), {
        configurable: { thread_id: 'cli-thread' },
      });
      expect(deliveriesOf(sessions, 'all')).toHaveLength(1);
      expect(callShape(sessions.root)).toEqual([
        'tool/call',
        'deliverables/presented',
        'tool/result',
      ]);
    } finally {
      await attachment.detach();
      await built.dispose();
    }
  }, 60000);

  it('沒有樹的呼叫端：同一個行程裡兩份無樹組裝（同一個 thread id、各自的工作區）各交付各的，互不相見', async () => {
    const { env } = home();
    // 沒有樹：`loadDefaultPlugins` 不帶 tree，橋接列走 `bindDetached`，查找是那一次組裝自己的 registry。
    const loadedA = await loadDefaultPlugins({ env, warn: warnNothing });
    const loadedB = await loadDefaultPlugins({ env, warn: warnNothing });
    const workspaceA = workspaceWith({ 'a.md': '# 甲' });
    const workspaceB = workspaceWith({ 'b.md': '# 乙' });
    const builtA = await createCliAgent(
      { live: false, workspace: workspaceA, sandbox: 'workspace-write' },
      withScriptedModel([...loadedA.plugins], presentTurns('a.md', 'same')),
      workspaceA,
    );
    const builtB = await createCliAgent(
      { live: false, workspace: workspaceB, sandbox: 'workspace-write' },
      withScriptedModel([...loadedB.plugins], presentTurns('b.md', 'same')),
      workspaceB,
    );
    const sessionsA = new SessionRegistry('same-id');
    const sessionsB = new SessionRegistry('same-id');
    const attachA = builtA.attachSessions(sessionsA);
    const attachB = builtB.attachSessions(sessionsB);
    const config = { configurable: { thread_id: 'same-id' } };
    await Promise.all([
      builtA.agent.invoke(toAgentInvocation('跑。'), config),
      builtB.agent.invoke(toAgentInvocation('跑。'), config),
    ]);

    expect(deliveriesOf(sessionsA, 'all').map((event) => event.data)).toEqual([
      { callId: 'same', files: [{ path: 'a.md' }] },
    ]);
    expect(deliveriesOf(sessionsB, 'all').map((event) => event.data)).toEqual([
      { callId: 'same', files: [{ path: 'b.md' }] },
    ]);
    await attachA.detach();
    await attachB.detach();
    await builtA.dispose();
    await builtB.dispose();
  }, 90000);
});
