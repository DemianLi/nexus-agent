/**
 * submit-record 在 Cordis 樹上：「工具在呼叫當下拿到這條 thread 的 fs」與「核准閘門」兩個接縫
 * （[#1466](https://github.com/DemianLi/nexus-agent/issues/1466)，逐條 thread 接縫的第四段）：驗收 B、E。
 * 量的是產品路徑——真的 `createCordisRoot`、真的 `loadDefaultPlugins`（帶樹）、真的寫入口 `changePlugin`、真的相容層
 * `assembly.create`（serve 每條 thread 一次）、真的 `attachSessions`、真的檔案系統 backend 與 fence；不手搭 `ctx.plugin`。
 *
 * 驗收 A（SDK lint、一致性套件、套一次服務兩條 thread）在 `packages/nexus-plugin-submit-record` 與 `migrated-plugin-gate.test.ts`；
 * 驗收 D（既有測試的斷言一個字不動、組裝換成 fixture）是 `approval-gate-order.test.ts`、`background-delegation.test.ts`、
 * `delegated-subagent.test.ts`、`subagent-background-probe.test.ts`、`submit-record-mounts/sandbox/wire.test.ts`；驗收 C
 * （golden）是一次性錄製，做法與數字寫在 PR 內文。
 *
 * **E 的核心風險**：fs 是**安全邊界**。`--workspace` 下每條 thread 各一顆 fence（`SandboxModeController`，`/permission` 切的
 * 就是它）。行程裡只要活著兩條以上的 thread，每一次呼叫都要靠 `thread_id` 認出主人；認錯的樣子是「一條 thread 的送出寫進
 * 另一條 thread 的 backend、套另一條的 fence」，而兩邊各自都寫成功——沒有任何例外。所以這一檔所有「第二條 thread 活著」的格子，
 * 都先把另一條 thread 開著、不收，再從這一條呼叫；而 fence 那一格用**同一個工作區、相反的兩種模式**，讓串線在磁碟上看得見。
 */

import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { ToolMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import {
  SessionRegistry,
  createHostServicesPlugin,
  formatOrigin,
  loadPlugins,
  runApprovalGate,
} from '@nexus/core';
import type { PluginEntry } from '@nexus/core';
import type { FsLookupService } from '@nexus/fs';
import {
  SUBMIT_RECORD_NO_BACKEND_MESSAGE,
  SUBMIT_RECORD_TOOL_NAME,
} from '@nexus/plugin-submit-record';
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
import { auditStartupEntries, REQUIRED_TREE_ENTRY_IDS } from './startup-audit.js';
import { writeFile } from 'node:fs/promises';

const temporary: string[] = [];
const roots: CordisRoot[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await root.dispose().catch(() => {});
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix = 'nexus-submit-tree-'): string {
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
  const root = createCordisRoot({ channel: entryApprovalChannel(undefined) });
  roots.push(root);
  return root;
}

const warnNothing = (): void => {};
const ID = 'submit-record';
const CSV = '/visitors.csv';

/** 一顆 `submit_record` 呼叫。 */
function submitCall(name: string) {
  return { name: SUBMIT_RECORD_TOOL_NAME, args: { file_path: CSV, record: { 姓名: name } } };
}

/** 呼叫一次、收工。 */
function submitTurns(name: string): readonly ScriptedTurn[] {
  return [{ content: '', toolCalls: [submitCall(name)] }, { content: '收工。' }];
}

/** 一個工作區裡 visitors.csv 的全文；不存在是 `undefined`。 */
function csvOf(dir: string): string | undefined {
  const path = join(dir, 'visitors.csv');
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
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
  readonly workspace: string;
}

/**
 * serve 的形狀：這條 thread 自己一次相容層組裝（自己的腳本模型、自己的工作區與 fence），自己一張註冊表，經
 * `attachSessions` 接上。回來的 thread **不收**：呼叫端決定它活多久。
 */
async function openThread(
  booted: Booted,
  threadId: string,
  turns: readonly ScriptedTurn[],
  options: {
    readonly workspace?: string;
    readonly sandbox?: 'read-only' | 'workspace-write';
    readonly extra?: readonly PluginEntry[];
    readonly invocation?: Partial<Parameters<NexusAssembly['create']>[0]>;
    readonly loaded?: LoadedPluginConfig;
  } = {},
): Promise<OpenThread> {
  const workspace = options.workspace ?? scratch('nexus-submit-ws-');
  const base = options.loaded ?? booted.loaded;
  const plugins = withScriptedModel([...base.plugins, ...(options.extra ?? [])], turns);
  const built = await booted.assembly.create(
    {
      live: false,
      workspace,
      sandbox: options.sandbox ?? 'workspace-write',
      ...options.invocation,
    },
    { plugins },
  );
  const sessions = new SessionRegistry(threadId);
  const attachment = built.attachSessions(sessions);
  return { built, sessions, attachment, threadId, workspace };
}

const approve = () => new Command({ resume: { decisions: [{ type: 'approve' }] } }) as never;

/** 以這條 thread 的身分跑一次（一個 human 訊息）。 */
async function runOn(
  thread: OpenThread,
  text = '登記一位訪客。',
): Promise<{ __interrupt__?: unknown[] }> {
  return (await thread.built.agent.invoke(toAgentInvocation(text), {
    configurable: { thread_id: thread.threadId },
  })) as { __interrupt__?: unknown[] };
}

/** 核准那一次中斷、跑完，回最後的訊息們。 */
async function approveOn(thread: OpenThread): Promise<ToolMessage | undefined> {
  const state = (await thread.built.agent.invoke(approve(), {
    configurable: { thread_id: thread.threadId },
  })) as { messages: unknown[] };
  return state.messages.find(
    (message): message is ToolMessage =>
      ToolMessage.isInstance(message) && message.name === SUBMIT_RECORD_TOOL_NAME,
  );
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

/**
 * 直接叫樹上那顆 `submit_record` 一次（不經模型、不經閘門）：拿掛著 submit-record 那一列的橋接條目掛進一份空的 registry，取出
 * 工具。**fs 查找走的是樹上那一列**（`bindToTree` 的條目不帶自己的查找）。
 */
async function bareTool(loaded: LoadedPluginConfig) {
  const entry = loaded.plugins.find((candidate) => loaded.rows.get(candidate)?.id === ID);
  if (entry === undefined) throw new Error('清單上沒有 submit-record');
  const { registry, dispose } = await loadPlugins([createHostServicesPlugin({}), entry]);
  const resolved = registry.tools.resolve(SUBMIT_RECORD_TOOL_NAME);
  if (resolved === undefined) throw new Error('工具沒登記上');
  return { tool: resolved.value, registry, dispose };
}

async function callBare(
  tool: { invoke(input: unknown, config?: unknown): Promise<unknown> },
  config: unknown,
  name = '直接叫的',
): Promise<string> {
  const result = await tool.invoke({ file_path: CSV, record: { 姓名: name } }, config);
  return String((result as { content?: unknown }).content ?? result);
}

describe('B：出貨清單上的 submit-record 經樹進來，位置與名字不變', () => {
  it('是橋接列、樹上 submit-record 與 fs 兩列都 ACTIVE、沒有掉列；啟動稽核過；快照上是 mounted', async () => {
    const { env } = home();
    const root = newRoot();
    const loaded = await loadDefaultPlugins({ env, warn: warnNothing }, { tree: root.tree });
    const entry = loaded.plugins.find((candidate) => loaded.rows.get(candidate)?.id === ID);
    expect(entry).toBeDefined();
    expect(entry !== undefined && isBridgeEntry(entry)).toBe(true);
    expect(entry?.plugin.name).toBe('submit-record');
    expect(loaded.dropped).toEqual([]);
    expect(loaded.rows.get(entry as never)).toEqual({
      id: ID,
      module: '@nexus/plugin-submit-record',
    });
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
      module: '@nexus/plugin-submit-record',
      running: { state: 'mounted' },
      saved: { state: 'mounted' },
      sync: 'same',
    });
  }, 60000);

  it('樹上的 fs 查找服務：歸屬是 fs 那一列、契約 1.0.0；tools 服務升到 1.2.0（gate）', async () => {
    const { env } = home();
    const root = newRoot();
    await loadDefaultPlugins({ env, warn: warnNothing }, { tree: root.tree });
    const tree = await root.tree.context();
    const fs = tree.get('fs') as
      (FsLookupService & { provider?: string; contractVersion?: string }) | undefined;
    expect(fs?.provider).toBe('fs');
    expect(fs?.contractVersion).toBe('1.0.0');
    // 還沒有任何一條 thread 登記：沒接上。
    expect(fs?.forCall({ configurable: { thread_id: 'x', checkpoint_ns: 'tools:c' } })).toEqual({
      kind: 'not-attached',
    });
    const tools = tree.get('tools') as { contractVersion?: string } | undefined;
    expect(tools?.contractVersion).toBe('1.2.0');
  }, 60000);

  it('fs 那一列是必掛的：它起不來，submit_record 沒有地方問 fs，整個起不來', () => {
    expect(REQUIRED_TREE_ENTRY_IDS.has('fs')).toBe(true);
  });

  it('樹上折進來的閘門：來源仍是 submit-record (submit-record)，只對 submit_record 回 ask（否定面：別的工具走到鏈底 allow）', async () => {
    const { env } = home();
    const root = newRoot();
    const loaded = await loadDefaultPlugins({ env, warn: warnNothing }, { tree: root.tree });
    const { registry, dispose } = await bareTool(loaded);
    try {
      const listeners = registry.approvals.listeners();
      expect(listeners.map((entry) => formatOrigin(entry.origin))).toEqual([
        'submit-record (submit-record)',
      ]);
      const mine = await runApprovalGate(listeners, {
        name: SUBMIT_RECORD_TOOL_NAME,
        args: {},
        callId: 'c1',
      });
      expect(mine.kind).toBe('ask');
      const other = await runApprovalGate(listeners, {
        name: 'write_file',
        args: {},
        callId: 'c2',
      });
      expect(other.kind).toBe('allow');
    } finally {
      await dispose();
    }
  }, 60000);
});

describe('E：同一棵樹上多條 thread 同時活著，每一次呼叫靠 thread_id 認出主人', () => {
  it.each([
    ['第一條是唯讀、第二條可寫', 'read-only', 'workspace-write'],
    ['第一條可寫、第二條唯讀', 'workspace-write', 'read-only'],
  ] as const)(
    '兩條 serve thread 共用同一個工作區、fence 相反（%s）：各用各的 fence，檔案只有可寫那條寫得進去',
    async (_label, firstMode, secondMode) => {
      const { env } = home();
      const booted = await boot(env);
      const shared = scratch('nexus-submit-shared-');
      const first = await openThread(booted, 'fence-first', submitTurns('甲'), {
        workspace: shared,
        sandbox: firstMode,
      });
      const second = await openThread(booted, 'fence-second', submitTurns('乙'), {
        workspace: shared,
        sandbox: secondMode,
      });
      // 兩條都停在核准卡上，再一起核准——兩條同時活著、交錯執行。
      const paused = await Promise.all([runOn(first), runOn(second)]);
      expect(paused.map((result) => result.__interrupt__?.length)).toEqual([1, 1]);
      const [firstMessage, secondMessage] = await Promise.all([
        approveOn(first),
        approveOn(second),
      ]);

      const writer = firstMode === 'workspace-write' ? '甲' : '乙';
      const denied = firstMode === 'read-only' ? firstMessage : secondMessage;
      const written = firstMode === 'workspace-write' ? firstMessage : secondMessage;
      expect(csvOf(shared)).toBe(`姓名\n${writer}\n`);
      expect(denied?.status).toBe('error');
      expect(String(denied?.content)).toMatch(/^Error: 寫不進 "\/visitors\.csv"：.*唯讀/);
      expect(written?.status).not.toBe('error');
      expect(String(written?.content)).toContain('已經寫進');
      await closeThread(first);
      await closeThread(second);
    },
    60000,
  );

  it('兩條 serve thread（root 形狀）各有自己的工作區，交錯跑，檔案互不串線', async () => {
    const { env } = home();
    const booted = await boot(env);
    const a = await openThread(booted, 'thread-a', submitTurns('甲'));
    const b = await openThread(booted, 'thread-b', submitTurns('乙'));
    await Promise.all([runOn(a), runOn(b)]);
    await Promise.all([approveOn(a), approveOn(b)]);

    expect(csvOf(a.workspace)).toBe('姓名\n甲\n');
    expect(csvOf(b.workspace)).toBe('姓名\n乙\n');
    await closeThread(a);
    await closeThread(b);
  }, 60000);

  it('第二條 thread 活著時，同步子代理（task）叫的 submit_record 寫進這條 thread 自己的工作區', async () => {
    const { env } = home();
    const booted = await boot(env);
    const other = await openThread(booted, 'other', [{ content: '待著。' }]);
    const mine = await openThread(
      booted,
      'mine',
      [
        {
          content: '委派。',
          toolCalls: [{ name: 'task', args: { description: '登記', subagent_type: 'worker' } }],
        },
        { content: '', toolCalls: [submitCall('子代理')] },
        { content: '子代理收工。' },
        { content: '根收工。' },
        { content: '再收一次。' },
      ],
      { extra: [workerSource()] },
    );
    const paused = await runOn(mine);
    expect(paused.__interrupt__).toHaveLength(1);
    await mine.built.agent.invoke(approve(), { configurable: { thread_id: mine.threadId } });

    expect(csvOf(mine.workspace)).toBe('姓名\n子代理\n');
    expect(readdirSync(other.workspace)).toEqual([]);
    expect(mine.sessions.list().map((entry) => entry.address.kind)).toEqual(['root', 'subagent']);
    await closeThread(mine);
    await closeThread(other);
  }, 60000);

  it('背景子代理（thread_id 是 <root>/<runId>）：閘門釘 policy-never 沒有人被問到、什麼都沒寫；fs 查找回的是同一份 backend（Q2-2 實測）', async () => {
    const { env } = home();
    const booted = await boot(env);
    const other = await openThread(booted, 'other-bg', [{ content: '待著。' }]);

    // 背景子代理有自己的模型：先叫 `write_file`（基座的檔案工具，走它自己拿到的 backend），再叫 `submit_record`。
    const worker = new ScriptedChatModel({
      turns: [
        {
          content: '',
          toolCalls: [
            { name: 'write_file', args: { file_path: '/bg-probe.txt', content: '背景寫的' } },
          ],
        },
        { content: '', toolCalls: [submitCall('背景')] },
        { content: '背景收工。' },
      ],
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
              args: { description: '幹活', subagent_type: 'worker', run_in_background: true },
            },
          ],
        },
        { content: '根收尾。' },
      ],
      { extra: [workerSource(worker)], invocation: { backgroundSubagents: { maxActive: 8 } } },
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

    // 背景那一輪的 `submit_record` 被閘門擋在工具本體之前：沒有寫、沒有人被問到。
    expect(csvOf(mine.workspace)).toBeUndefined();
    expect(csvOf(other.workspace)).toBeUndefined();
    const refusal = worker.prompts
      .flat()
      .filter((message) => message.getType() === 'tool')
      .map((message) => String(message.text))
      .find((text) => text.includes('沒有人被問到'));
    expect(refusal).toBeDefined();

    // **Q2-2 的實測**：背景那一份呼叫身分（`<root>/<runId>`）問樹上的 fs 查找，回的把手與 root 呼叫是同一個、
    // 把手讀得到背景子代理自己的 `write_file` 寫下的檔案——同一份折出來的 backend，不是另一份。
    const background = mine.sessions.list().find((entry) => entry.address.kind === 'subagent');
    expect(background?.log.sessionId.startsWith('mine-bg/')).toBe(true);
    expect(readFileSync(join(mine.workspace, 'bg-probe.txt'), 'utf8')).toBe('背景寫的');
    const tree = await booted.root.tree.context();
    const fs = tree.get('fs') as FsLookupService;
    const rootFound = fs.forCall({
      configurable: { thread_id: 'mine-bg', checkpoint_ns: 'tools:a' },
    });
    const backgroundFound = fs.forCall({
      configurable: { thread_id: background!.log.sessionId, checkpoint_ns: 'tools:a|tools:b' },
    });
    expect(rootFound.kind).toBe('ok');
    expect(backgroundFound.kind).toBe('ok');
    if (rootFound.kind !== 'ok' || backgroundFound.kind !== 'ok') return;
    expect(backgroundFound.fs).toBe(rootFound.fs);
    expect(backgroundFound.fs.backend()).toBe(rootFound.fs.backend());
    const read = await (
      backgroundFound.fs.backend() as {
        readRaw(path: string): Promise<{ data?: { content?: unknown } }>;
      }
    ).readRaw('/bg-probe.txt');
    expect(String(read.data?.content)).toBe('背景寫的');
    await closeThread(mine);
    await closeThread(other);
  }, 60000);

  it('沒有 thread_id 而活著兩條 thread：挑不出，回的是同一句 NO_BACKEND（逐字，不另造一句）；認不出呼叫者同樣', async () => {
    const { env } = home();
    const booted = await boot(env);
    const a = await openThread(booted, 'amb-a', [{ content: '甲。' }]);
    const { tool, dispose } = await bareTool(booted.loaded);
    try {
      const expected = `Error: ${SUBMIT_RECORD_NO_BACKEND_MESSAGE}`;
      // 只活著一條：不看 thread_id；算不出位址（沒有 configurable）是「認不出呼叫者」，對模型同一句。
      expect(await callBare(tool, undefined)).toBe(expected);
      const b = await openThread(booted, 'amb-b', [{ content: '乙。' }]);
      // 兩條都活著、有位址卻沒有 thread_id：挑不出。
      expect(await callBare(tool, { configurable: { checkpoint_ns: 'tools:c' } })).toBe(expected);
      // 帶了誰都不認得的 thread_id，同樣挑不出。
      expect(
        await callBare(tool, { configurable: { thread_id: 'stranger', checkpoint_ns: 'tools:c' } }),
      ).toBe(expected);
      expect(csvOf(a.workspace)).toBeUndefined();
      expect(csvOf(b.workspace)).toBeUndefined();
      // 帶著 b 的 thread_id：寫進 b 的工作區。
      expect(
        await callBare(tool, { configurable: { thread_id: 'amb-b', checkpoint_ns: 'tools:c' } }),
      ).toContain('已經寫進');
      expect(csvOf(b.workspace)).toBe('姓名\n直接叫的\n');
      expect(csvOf(a.workspace)).toBeUndefined();
      await closeThread(b);
    } finally {
      await dispose();
      await closeThread(a);
    }
  }, 60000);

  it('同一條 thread id 重組（舊的那份沒收）之後照樣找得到新的，舊的遲到的拆線只撤自己', async () => {
    const { env } = home();
    const booted = await boot(env);
    const bystander = await openThread(booted, 'bystander', [{ content: '旁觀。' }]);
    // 第一次組裝這條 thread，**不收**（模擬 serve 在 attachSessions 之後才建不起來、`wire-handler.ts` 沒有替它拆線）。
    const stale = await openThread(booted, 'rebuilt', [{ content: '舊的。' }]);
    const fresh = await openThread(booted, 'rebuilt', submitTurns('新的'));
    expect(booted.root.tree.threadSessions.size).toBe(2);
    await runOn(fresh);
    await approveOn(fresh);

    expect(csvOf(fresh.workspace)).toBe('姓名\n新的\n');
    expect(csvOf(stale.workspace)).toBeUndefined();

    // 舊的那份遲到的拆線只撤自己：新的那一份仍登記著，下一次呼叫仍找得到、寫進新的那份的工作區。
    await stale.attachment.detach();
    expect(booted.root.tree.threadSessions.size).toBe(2);
    const { tool, dispose } = await bareTool(booted.loaded);
    try {
      expect(
        await callBare(tool, { configurable: { thread_id: 'rebuilt', checkpoint_ns: 'tools:c' } }),
      ).toContain('已經寫進');
      expect(csvOf(fresh.workspace)).toBe('姓名\n新的\n直接叫的\n');
      expect(csvOf(stale.workspace)).toBeUndefined();
    } finally {
      await dispose();
    }
    await closeThread(fresh);
    await closeThread(bystander);
    await stale.built.dispose();
  }, 60000);

  it('組裝失敗的那一次不留登記：attachSession 在綁上之後拋，之後的呼叫不會挑到它', async () => {
    const { env } = home();
    const booted = await boot(env);
    const live = await openThread(booted, 'survivor', [{ content: '活著。' }], {
      invocation: { backgroundSubagents: { maxActive: 8 } },
    });
    // 同一份組裝第二次接背景 host：`attachSession` 先綁上註冊表、再在背景 host 那一步拋（一份組裝只接一個）。
    const failed = new SessionRegistry('doomed');
    expect(() => live.built.attachSessions(failed)).toThrow('一份組裝只接一個');
    expect(booted.root.tree.threadSessions.size).toBe(1);

    const { tool, dispose } = await bareTool(booted.loaded);
    try {
      // 沒有 thread_id：只登記著一筆時不看 thread；要是 doomed 殘留了，這裡會變成挑不出。
      expect(await callBare(tool, { configurable: { checkpoint_ns: 'tools:c' } })).toContain(
        '已經寫進',
      );
      expect(csvOf(live.workspace)).toBe('姓名\n直接叫的\n');
    } finally {
      await dispose();
      await closeThread(live);
    }
  }, 60000);

  it('撤除走 attachSession 回傳的 detach：detach 之後查找不再找得到那條 thread，工具回 NO_BACKEND', async () => {
    const { env } = home();
    const booted = await boot(env);
    const thread = await openThread(booted, 'detaching', [{ content: '收工。' }]);
    const { tool, dispose } = await bareTool(booted.loaded);
    try {
      const config = { configurable: { thread_id: 'detaching', checkpoint_ns: 'tools:c' } };
      expect(await callBare(tool, config)).toContain('已經寫進');
      await thread.attachment.detach();
      expect(booted.root.tree.threadSessions.size).toBe(0);
      expect(await callBare(tool, config)).toBe(`Error: ${SUBMIT_RECORD_NO_BACKEND_MESSAGE}`);
      expect(csvOf(thread.workspace)).toBe('姓名\n直接叫的\n');
    } finally {
      await dispose();
      await thread.built.dispose();
    }
  }, 60000);

  it('樹上那一列停用（變更紀錄）：停在核准卡上的那條 thread 照舊寫得進自己的工作區，下一條沒有這顆工具', async () => {
    const { env } = home();
    const booted = await boot(env);
    const first = await openThread(booted, 'open-thread', submitTurns('停用之前'));
    const paused = await runOn(first);
    expect(paused.__interrupt__).toHaveLength(1);

    await changePlugin({ op: 'disable', id: ID }, { env });
    const reread = await loadDefaultPlugins({ env, warn: warnNothing }, { tree: booted.root.tree });
    const second = await openThread(booted, 'next-thread', [{ content: '沒有那顆工具。' }], {
      loaded: reread,
    });
    const tree = await booted.root.tree.context();
    expect(tree.loader.resolve(`include:${ID}`).fiber?.ctx.fiber.state).toBe(4);
    await second.built.agent.invoke(toAgentInvocation('看一下。'), {
      configurable: { thread_id: second.threadId },
    });
    const bound = (second.built.model as unknown as { boundTools: { name: string }[] }).boundTools;
    expect(bound.map((tool) => tool.name)).not.toContain(SUBMIT_RECORD_TOOL_NAME);
    // 閘門也一起不在：新那條折進去的清單裡沒有 submit-record 的 listener（閘門是這一列的性質）。
    // 開著的那條：工具在 `apply` 當下抓住了 fs 查找，樹上那一列卸了它也照樣寫（決議 §3-2 第 6 條）；fs 那一列沒卸。
    const message = await approveOn(first);
    expect(message?.status).not.toBe('error');
    expect(csvOf(first.workspace)).toBe('姓名\n停用之前\n');
    expect(readdirSync(second.workspace)).toEqual([]);
    await closeThread(first);
    await closeThread(second);
  }, 90000);
});

describe('三個入口各有一條（拿掉任一入口的接線要紅）', () => {
  it('CLI：經樹上的內建列，閘門折進 thread——核准閘門在 headless 下判 policy-never，沒有人被問到、什麼都沒寫', async () => {
    const dir = scratch();
    const workspace = scratch('nexus-submit-cli-ws-');
    const patch = join(dir, 'scripted.patch.yml');
    await writeFile(patch, scriptedPatchText(submitTurns('命令列')), 'utf8');
    const lines: string[] = [];
    const record = (...parts: unknown[]): void => void lines.push(parts.join(' '));

    await runCli({
      argv: ['--patch', patch, '--workspace', workspace, '登記一位訪客。'],
      input: new PassThrough(),
      output: new PassThrough(),
      printer: { log: record, error: record },
      env: { [HARNESS_HOME_ENV]: dir },
      cwd: workspace,
    });

    const out = lines.join('\n');
    // 拿掉橋接列折閘門的那一行：工具本體會直接跑，檔案出現——所以「沒寫」就是閘門在的證據。
    expect(out).toContain('收工。');
    expect(csvOf(workspace)).toBeUndefined();
    expect(out).not.toContain('已經寫進');
  }, 60000);

  it('CLI 的樹（boot "cli"）：fs 查找經樹上內建列找到這條 thread 的工作區（工具本體在 CLI 不會被核准，所以直接叫）', async () => {
    const { env } = home();
    const root = createCordisRoot({ channel: entryApprovalChannel(HEADLESS_APPROVALS) });
    roots.push(root);
    const loaded = await loadDefaultPlugins({ env, warn: warnNothing }, { tree: root.tree });
    const assembly = await root.boot('cli', { plugins: loaded.plugins });
    const workspace = scratch('nexus-submit-cli-tree-');
    const built = await assembly.create(
      { live: false, workspace, sandbox: 'workspace-write' },
      { plugins: withScriptedModel([...loaded.plugins], [{ content: '待著。' }]) },
    );
    const attachment = built.attachSessions(new SessionRegistry('cli-thread'));
    const { tool, dispose } = await bareTool(loaded);
    try {
      expect(
        await callBare(tool, {
          configurable: { thread_id: 'cli-thread', checkpoint_ns: 'tools:c' },
        }),
      ).toContain('已經寫進');
      expect(csvOf(workspace)).toBe('姓名\n直接叫的\n');
    } finally {
      await dispose();
      await attachment.detach();
      await built.dispose();
    }
  }, 60000);

  it('沒有樹的呼叫端：同一個行程裡兩份無樹組裝（同一個 thread id、各自的工作區）各用各的 backend，互不相見', async () => {
    const { env } = home();
    // 沒有樹：`loadDefaultPlugins` 不帶 tree，橋接列走 `bindDetached`，查找是那一次組裝自己的 host-services `fs`。
    const loadedA = await loadDefaultPlugins({ env, warn: warnNothing });
    const loadedB = await loadDefaultPlugins({ env, warn: warnNothing });
    const workspaceA = scratch('nexus-submit-detached-a-');
    const workspaceB = scratch('nexus-submit-detached-b-');
    const builtA = await createCliAgent(
      { live: false, workspace: workspaceA, sandbox: 'workspace-write' },
      withScriptedModel([...loadedA.plugins], submitTurns('無樹甲')),
      workspaceA,
    );
    const builtB = await createCliAgent(
      { live: false, workspace: workspaceB, sandbox: 'workspace-write' },
      withScriptedModel([...loadedB.plugins], submitTurns('無樹乙')),
      workspaceB,
    );
    // 兩份用同一個 thread id、同時活著：各自的查找只看自己那一份。
    const attachA = builtA.attachSessions(new SessionRegistry('same-id'));
    const attachB = builtB.attachSessions(new SessionRegistry('same-id'));
    const config = { configurable: { thread_id: 'same-id' } };
    const [pausedA, pausedB] = (await Promise.all([
      builtA.agent.invoke(toAgentInvocation('跑。'), config),
      builtB.agent.invoke(toAgentInvocation('跑。'), config),
    ])) as { __interrupt__?: unknown[] }[];
    expect(pausedA?.__interrupt__).toHaveLength(1);
    expect(pausedB?.__interrupt__).toHaveLength(1);
    await Promise.all([
      builtA.agent.invoke(approve(), config),
      builtB.agent.invoke(approve(), config),
    ]);

    expect(csvOf(workspaceA)).toBe('姓名\n無樹甲\n');
    expect(csvOf(workspaceB)).toBe('姓名\n無樹乙\n');
    await attachA.detach();
    await attachB.detach();
    await builtA.dispose();
    await builtB.dispose();
  }, 90000);
});

describe('serve 入口', () => {
  it('serve 入口的實測在 submit-record-wire.test.ts：真的 `runServe`、真的核准卡、`--workspace` 磁碟上的檔案（拿掉 fs 那一列的登記，那裡會紅）', () => {
    // 這一格只是把索引寫在這裡：serve 的接線需要整條 wire 才量得到，不在這個檔重複搭一份。
    expect(existsSync(new URL('./submit-record-wire.test.ts', import.meta.url))).toBe(true);
  });
});
