/**
 * todo 在 Cordis 樹上，樹上的「會話查找」接縫（[#1463](https://github.com/DemianLi/nexus-agent/issues/1463)，逐條 thread 接縫
 * 的第三段）：驗收 B、D、E。量的是產品路徑——真的 `createCordisRoot`、真的 `loadDefaultPlugins`（帶樹）、真的寫入口
 * `changePlugin`、真的相容層 `assembly.create`（serve 每條 thread 一次）、真的 `attachSessions`；不手搭 `ctx.plugin`。
 *
 * 驗收 A（SDK lint、一致性套件）在 `packages/nexus-plugin-todo` 與 `migrated-plugin-gate.test.ts`；排除只蓋到 `src/invariant.ts` 的
 * 量法在 `packages/nexus-plugin-todo/src/eslint-exclusion.test.ts`。驗收 C（golden）是一次性錄製，不在這個檔，做法與數字寫在 PR 內文。
 *
 * **E 的核心風險**：今天 serve 每條 thread 只綁一張註冊表，`forCall` 根本不讀 `thread_id`；改成行程級之後，行程裡只要活著兩條
 * 以上的 thread，**每一次呼叫都要靠 `thread_id` 認出主人**。所以這一檔所有「第二條 thread 活著」的格子，都先把另一條 thread
 * 開著、寫過東西、不收，再從這一條呼叫。
 */

import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { Command } from '@langchain/langgraph';
import { SessionRegistry, createHostServicesPlugin, loadPlugins } from '@nexus/core';
import type { PluginEntry, SessionEvent, TodoItem } from '@nexus/core';
import { ASK_USER_QUESTION_TOOL_NAME } from '@nexus/plugin-ask-user';
import {
  TODO_NOT_ATTACHED_MESSAGE,
  TODO_TOOL_NAME,
  TODO_UNKNOWN_CALLER_MESSAGE,
  todoAmbiguousMessage,
} from '@nexus/plugin-todo';
import { writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from './cli.js';
import { createCliAgent } from './assembly-root.js';
import { createCordisRoot, entryApprovalChannel } from './cordis-root.js';
import type { CordisRoot, NexusAssembly } from './cordis-root.js';
import { foldTurn, serveClient, withScriptedModel } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { toAgentInvocation } from './messages.js';
import { changePlugin } from './plugin-change.js';
import { isBridgeEntry, loadDefaultPlugins } from './plugin-config.js';
import type { LoadedPluginConfig } from './plugin-config.js';
import { buildPluginSnapshot } from './plugin-snapshot.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { scriptedPatchText, startScriptedServe } from './scripted-serve.js';
import type { ScriptedServe } from './scripted-serve.js';
import { auditStartupEntries, REQUIRED_TREE_ENTRY_IDS } from './startup-audit.js';

const temporary: string[] = [];
const roots: CordisRoot[] = [];
let serve: ScriptedServe | undefined;

afterEach(async () => {
  await serve?.close();
  serve = undefined;
  for (const root of roots.splice(0)) await root.dispose().catch(() => {});
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-todo-tree-'));
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
const ID = 'todo';

/** 一顆 `todo_write` 呼叫。 */
function writeCall(content: string, status: TodoItem['status'] = 'in_progress') {
  return { name: TODO_TOOL_NAME, args: { todos: [{ content, status }] } };
}

/** 一份日誌裡的 todo 清單們，照寫入順序。 */
function todosIn(events: readonly SessionEvent[]): readonly (readonly TodoItem[])[] {
  return events
    .filter((event) => event.type === 'todo/write')
    .map((event) => (event as SessionEvent<'todo/write'>).data.todos);
}

/** 登記一個名叫 `worker` 的子代理（繼承根的工具，所以也有 `todo_write`）；可以給它自己的模型。 */
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
}

/**
 * serve 的形狀：這條 thread 自己一次相容層組裝（自己的腳本模型），自己一張註冊表，經 `attachSessions` 接上。
 * 回來的 thread **不收**：呼叫端決定它活多久。
 */
async function openThread(
  booted: Booted,
  threadId: string,
  turns: readonly ScriptedTurn[],
  options: {
    readonly extra?: readonly PluginEntry[];
    readonly invocation?: Partial<Parameters<NexusAssembly['create']>[0]>;
    readonly loaded?: LoadedPluginConfig;
  } = {},
): Promise<OpenThread> {
  const base = options.loaded ?? booted.loaded;
  const plugins = withScriptedModel([...base.plugins, ...(options.extra ?? [])], turns);
  const built = await booted.assembly.create({ live: false, ...options.invocation }, { plugins });
  const sessions = new SessionRegistry(threadId);
  const attachment = built.attachSessions(sessions);
  return { built, sessions, attachment, threadId };
}

/** 以這條 thread 的身分跑一次（一個 human 訊息）。 */
async function runOn(thread: OpenThread, text = '跑。'): Promise<unknown> {
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

/** 直接叫樹上那顆 `todo_write` 一次（不經模型）：拿掛著 todo 那一列的 entry 掛進一份空的 registry，取出工具。 */
async function bareTodoTool(loaded: LoadedPluginConfig) {
  const entry = loaded.plugins.find((candidate) => loaded.rows.get(candidate)?.id === ID);
  if (entry === undefined) throw new Error('清單上沒有 todo');
  const { registry, dispose } = await loadPlugins([createHostServicesPlugin({}), entry]);
  const resolved = registry.tools.resolve(TODO_TOOL_NAME);
  if (resolved === undefined) throw new Error('工具沒登記上');
  return { tool: resolved.value, dispose };
}

async function callBare(
  tool: { invoke(input: unknown, config?: unknown): Promise<unknown> },
  config: unknown,
  content = '直接叫的',
): Promise<string> {
  const result = await tool.invoke({ todos: [{ content, status: 'pending' }] }, config);
  return String((result as { content?: unknown }).content ?? result);
}

describe('B：出貨清單上的 todo 經樹進來，位置與名字不變', () => {
  it('是橋接列、樹上 todo 那一列與會話查找那一列都 ACTIVE、沒有掉列；啟動稽核過；快照上是 mounted；todo-invariant 仍在相容層', async () => {
    const { env } = home();
    const root = newRoot();
    const loaded = await loadDefaultPlugins({ env, warn: warnNothing }, { tree: root.tree });
    const entry = loaded.plugins.find((candidate) => loaded.rows.get(candidate)?.id === ID);
    expect(entry).toBeDefined();
    expect(entry !== undefined && isBridgeEntry(entry)).toBe(true);
    expect(entry?.plugin.name).toBe('todo');
    expect(loaded.dropped).toEqual([]);
    expect(loaded.rows.get(entry as never)).toEqual({ id: ID, module: '@nexus/plugin-todo' });
    expect(() => auditStartupEntries(loaded, { live: false })).not.toThrow();

    const tree = await root.tree.context();
    expect(tree.loader.resolve(`include:${ID}`).fiber?.ctx.fiber.state).toBe(2);
    expect(tree.loader.resolve('session-lookup').fiber?.ctx.fiber.state).toBe(2);

    // `todo-invariant` 是同一個套件的另一個入口（`./invariant`），仍是相容層的列：不是橋接列、不在樹上。
    const invariantEntry = loaded.plugins.find(
      (candidate) => loaded.rows.get(candidate)?.id === 'todo-invariant',
    );
    expect(invariantEntry).toBeDefined();
    expect(invariantEntry !== undefined && isBridgeEntry(invariantEntry)).toBe(false);
    expect(loaded.rows.get(invariantEntry as never)).toEqual({
      id: 'todo-invariant',
      module: '@nexus/plugin-todo/invariant',
    });

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
      module: '@nexus/plugin-todo',
      running: { state: 'mounted' },
      saved: { state: 'mounted' },
      sync: 'same',
    });
    expect(snapshot.rows.find((row) => row.id === 'todo-invariant')).toMatchObject({
      module: '@nexus/plugin-todo/invariant',
      running: { state: 'mounted' },
    });
  }, 60000);

  it('樹上的會話查找服務：歸屬是 session-lookup 那一列、契約版本 1.0.0', async () => {
    const { env } = home();
    const root = newRoot();
    await loadDefaultPlugins({ env, warn: warnNothing }, { tree: root.tree });
    const service = (await root.tree.context()).get('sessionLookup') as
      | { provider?: string; contractVersion?: string; forCall(config: unknown): unknown }
      | undefined;
    expect(service?.provider).toBe('session-lookup');
    expect(service?.contractVersion).toBe('1.0.0');
    // 還沒有任何一條 thread 登記：沒接上。
    expect(
      service?.forCall({ configurable: { thread_id: 'x', checkpoint_ns: 'tools:c' } }),
    ).toEqual({
      kind: 'not-attached',
    });
  }, 60000);

  it('會話查找那一列是必掛的：它起不來，todo 沒有地方問會話，整個起不來', () => {
    expect(REQUIRED_TREE_ENTRY_IDS.has('session-lookup')).toBe(true);
  });
});

describe('E：同一棵樹上多條 thread 同時活著，每一次呼叫靠 thread_id 認出主人', () => {
  it('兩條 serve thread（root 形狀）各寫各的，交錯跑，日誌互不串線', async () => {
    const { env } = home();
    const booted = await boot(env);
    // 兩條 thread 各自的腳本不同：寫的內容就是它自己的名字。
    const a = await openThread(booted, 'thread-a', [
      { content: '甲規劃。', toolCalls: [writeCall('甲的計畫')] },
      { content: '甲收工。' },
    ]);
    const b = await openThread(booted, 'thread-b', [
      { content: '乙規劃。', toolCalls: [writeCall('乙的計畫')] },
      { content: '乙收工。' },
    ]);
    await Promise.all([runOn(a), runOn(b)]);

    expect(todosIn(a.sessions.root.events)).toEqual([
      [{ content: '甲的計畫', status: 'in_progress' }],
    ]);
    expect(todosIn(b.sessions.root.events)).toEqual([
      [{ content: '乙的計畫', status: 'in_progress' }],
    ]);
    await closeThread(a);
    await closeThread(b);
  }, 60000);

  it('第二條 thread 活著時，同步子代理（task）的呼叫寫進這條 thread 自己的子代理日誌', async () => {
    const { env } = home();
    const booted = await boot(env);
    // 另一條 thread 先活著、先寫過。
    const other = await openThread(booted, 'other', [
      { content: '先規劃。', toolCalls: [writeCall('另一條的計畫')] },
      { content: '收工。' },
    ]);
    await runOn(other);

    const mine = await openThread(
      booted,
      'mine',
      [
        {
          content: '委派。',
          toolCalls: [{ name: 'task', args: { description: '幹活', subagent_type: 'worker' } }],
        },
        { content: '子代理規劃。', toolCalls: [writeCall('子代理的計畫')] },
        { content: '子代理收工。' },
        { content: '根收工。' },
        { content: '根再收一次。' },
      ],
      { extra: [workerSource()] },
    );
    await runOn(mine);

    const entries = mine.sessions.list();
    expect(entries.map((entry) => entry.address.kind)).toEqual(['root', 'subagent']);
    expect(todosIn(entries[0]!.log.events)).toEqual([]);
    expect(todosIn(entries[1]!.log.events)).toEqual([
      [{ content: '子代理的計畫', status: 'in_progress' }],
    ]);
    // 另一條 thread 的日誌只有它自己的那一筆。
    expect(todosIn(other.sessions.root.events)).toEqual([
      [{ content: '另一條的計畫', status: 'in_progress' }],
    ]);
    expect(other.sessions.list()).toHaveLength(1);
    await closeThread(mine);
    await closeThread(other);
  }, 60000);

  it('第二條 thread 活著時，背景子代理（thread_id 是 <root>/<runId>）的呼叫寫進這條 thread 的背景日誌', async () => {
    const { env } = home();
    const booted = await boot(env);
    const other = await openThread(booted, 'other-bg', [
      { content: '先規劃。', toolCalls: [writeCall('另一條的計畫')] },
      { content: '收工。' },
    ]);
    await runOn(other);

    // 背景子代理有自己的模型（背景那一輪與根的剩餘輪次是並行消費，共用腳本會亂序）。
    const worker = new ScriptedChatModel({
      turns: [
        { content: '背景規劃。', toolCalls: [writeCall('背景的計畫')] },
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
      {
        extra: [workerSource(worker)],
        invocation: { backgroundSubagents: { maxActive: 8 } },
      },
    );
    await runOn(mine);
    const backgroundWritten = () =>
      mine.sessions
        .list()
        .some(
          (entry) => entry.address.kind === 'subagent' && todosIn(entry.log.events).length === 1,
        );
    await until(backgroundWritten);

    const background = mine.sessions.list().find((entry) => entry.address.kind === 'subagent');
    expect(background?.log.sessionId.startsWith('mine-bg/')).toBe(true);
    expect(todosIn(background!.log.events)).toEqual([
      [{ content: '背景的計畫', status: 'in_progress' }],
    ]);
    expect(todosIn(mine.sessions.root.events)).toEqual([]);
    expect(todosIn(other.sessions.root.events)).toEqual([
      [{ content: '另一條的計畫', status: 'in_progress' }],
    ]);
    await closeThread(mine);
    await closeThread(other);
  }, 60000);

  it('第二條 thread 活著時，核准中斷（閘門問了人）之後 resume 的那一次呼叫，仍寫進自己的日誌', async () => {
    const { env } = home();
    const booted = await boot(env);
    const other = await openThread(booted, 'other-approve', [
      { content: '先規劃。', toolCalls: [writeCall('另一條的計畫')] },
      { content: '收工。' },
    ]);
    await runOn(other);

    // 閘門只問 `todo_write`：這一條停在核准，resume 之後工具才真的被執行。
    const gate: PluginEntry = {
      plugin: {
        name: 'todo-gate',
        apply(registry) {
          registry.approvals.gate((exec, next) =>
            exec.name === TODO_TOOL_NAME ? { kind: 'ask', reason: 'todo 要人看過' } : next(),
          );
        },
      },
    };
    const mine = await openThread(
      booted,
      'mine-approve',
      [
        { content: '先規劃。', toolCalls: [writeCall('核准之後的計畫')] },
        { content: '收工。' },
        { content: '再收一次。' },
      ],
      { extra: [gate] },
    );
    const paused = (await runOn(mine)) as { __interrupt__?: unknown[] };
    expect(paused.__interrupt__).toHaveLength(1);
    expect(todosIn(mine.sessions.root.events)).toEqual([]);

    await mine.built.agent.invoke(new Command({ resume: { decisions: [{ type: 'approve' }] } }), {
      configurable: { thread_id: mine.threadId },
    });
    expect(todosIn(mine.sessions.root.events)).toEqual([
      [{ content: '核准之後的計畫', status: 'in_progress' }],
    ]);
    expect(todosIn(other.sessions.root.events)).toEqual([
      [{ content: '另一條的計畫', status: 'in_progress' }],
    ]);
    await closeThread(mine);
    await closeThread(other);
  }, 60000);

  it('第二條 thread 活著時，問答中斷（ask_user_question）之後 resume 的那一次呼叫，仍寫進自己的日誌', async () => {
    const { env } = home();
    const booted = await boot(env);
    const other = await openThread(booted, 'other-resume', [
      { content: '先規劃。', toolCalls: [writeCall('另一條的計畫')] },
      { content: '收工。' },
    ]);
    await runOn(other);

    const mine = await openThread(booted, 'mine-resume', [
      {
        content: '先問。',
        toolCalls: [
          {
            name: ASK_USER_QUESTION_TOOL_NAME,
            args: {
              questions: [{ id: 'day', question: '哪一天？', options: [{ label: '週一' }] }],
            },
          },
        ],
      },
      { content: '答完了，規劃。', toolCalls: [writeCall('resume 之後的計畫')] },
      { content: '收工。' },
    ]);
    const first = (await runOn(mine)) as { __interrupt__?: unknown[] };
    expect(first.__interrupt__).toHaveLength(1);
    expect(todosIn(mine.sessions.root.events)).toEqual([]);

    await mine.built.agent.invoke(
      new Command({ resume: { answers: [{ id: 'day', selected: ['週一'] }] } }),
      { configurable: { thread_id: mine.threadId } },
    );
    expect(todosIn(mine.sessions.root.events)).toEqual([
      [{ content: 'resume 之後的計畫', status: 'in_progress' }],
    ]);
    expect(todosIn(other.sessions.root.events)).toEqual([
      [{ content: '另一條的計畫', status: 'in_progress' }],
    ]);
    await closeThread(mine);
    await closeThread(other);
  }, 60000);

  it('呼叫方不明回 TODO_UNKNOWN_CALLER_MESSAGE；活著兩條 thread 而缺 thread_id 回 todoAmbiguousMessage（兩句都比原文）', async () => {
    const { env } = home();
    const booted = await boot(env);
    const a = await openThread(booted, 'amb-a', [{ content: '甲。' }]);
    const { tool, dispose } = await bareTodoTool(booted.loaded);
    try {
      // 只活著一條：不看 thread_id；但算不出位址（沒有 configurable）就是「認不出呼叫者」。
      expect(await callBare(tool, undefined)).toBe(`Error: ${TODO_UNKNOWN_CALLER_MESSAGE}`);
      const b = await openThread(booted, 'amb-b', [{ content: '乙。' }]);
      // 兩條都活著、呼叫有位址（checkpoint_ns）卻沒有 thread_id：挑不出，說得出有幾份。
      expect(await callBare(tool, { configurable: { checkpoint_ns: 'tools:c' } })).toBe(
        `Error: ${todoAmbiguousMessage(2)}`,
      );
      // 帶了誰都不認得的 thread_id，同樣挑不出。
      expect(
        await callBare(tool, { configurable: { thread_id: 'stranger', checkpoint_ns: 'tools:c' } }),
      ).toBe(`Error: ${todoAmbiguousMessage(2)}`);
      // 帶著 b 的 thread_id：寫進 b。
      expect(
        await callBare(tool, { configurable: { thread_id: 'amb-b', checkpoint_ns: 'tools:c' } }),
      ).toContain('Updated todo list');
      expect(todosIn(b.sessions.root.events)).toHaveLength(1);
      expect(todosIn(a.sessions.root.events)).toHaveLength(0);
      await closeThread(b);
    } finally {
      await dispose();
      await closeThread(a);
    }
  }, 60000);

  it('同一條 thread id 重組（舊的那份沒收）之後照樣回 ok，不會留下兩張都認得它的註冊表而變成 ambiguous', async () => {
    const { env } = home();
    const booted = await boot(env);
    const bystander = await openThread(booted, 'bystander', [{ content: '旁觀。' }]);
    // 第一次組裝這條 thread，**不收**（模擬 serve 在 attachSessions 之後才建不起來、`wire-handler.ts` 沒有替它拆線）。
    const stale = await openThread(booted, 'rebuilt', [{ content: '舊的。' }]);
    const fresh = await openThread(booted, 'rebuilt', [
      { content: '新的規劃。', toolCalls: [writeCall('重組之後的計畫')] },
      { content: '收工。' },
    ]);
    await runOn(fresh);

    expect(todosIn(fresh.sessions.root.events)).toEqual([
      [{ content: '重組之後的計畫', status: 'in_progress' }],
    ]);
    expect(todosIn(stale.sessions.root.events)).toEqual([]);

    // 舊的那份遲到的拆線只撤自己：新的那一份仍登記著，下一次呼叫仍找得到。
    await stale.attachment.detach();
    const { tool, dispose } = await bareTodoTool(booted.loaded);
    try {
      expect(
        await callBare(tool, { configurable: { thread_id: 'rebuilt', checkpoint_ns: 'tools:c' } }),
      ).toContain('Updated todo list');
      expect(todosIn(fresh.sessions.root.events)).toHaveLength(2);
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

    const { tool, dispose } = await bareTodoTool(booted.loaded);
    try {
      // 沒有 thread_id：只登記著一張時不看 thread（單一註冊表）；要是 doomed 殘留了，這裡會變成 ambiguous。
      expect(await callBare(tool, { configurable: { checkpoint_ns: 'tools:c' } })).toContain(
        'Updated todo list',
      );
      expect(todosIn(live.sessions.root.events)).toHaveLength(1);
      expect(todosIn(failed.root.events)).toEqual([]);
    } finally {
      await dispose();
      await closeThread(live);
    }
  }, 60000);

  it('撤除走 attachSession 回傳的 detach：detach 之後服務不再找得到那張註冊表', async () => {
    const { env } = home();
    const booted = await boot(env);
    const thread = await openThread(booted, 'detaching', [{ content: '收工。' }]);
    const { tool, dispose } = await bareTodoTool(booted.loaded);
    try {
      const config = { configurable: { thread_id: 'detaching', checkpoint_ns: 'tools:c' } };
      expect(await callBare(tool, config)).toContain('Updated todo list');
      await thread.attachment.detach();
      expect(await callBare(tool, config)).toBe(`Error: ${TODO_NOT_ATTACHED_MESSAGE}`);
      expect(todosIn(thread.sessions.root.events)).toHaveLength(1);
    } finally {
      await dispose();
      await thread.built.dispose();
    }
  }, 60000);
});

describe('D：樹上那一列停用，開著的 thread 照舊寫得進自己的日誌，下一條才看到新的', () => {
  it('停用 todo：開著的那條續寫仍進它自己的日誌；之後開的 thread 沒有這顆工具', async () => {
    const { env } = home();
    const booted = await boot(env);
    const first = await openThread(booted, 'open-thread', [
      { content: '先規劃。', toolCalls: [writeCall('停用之前的計畫')] },
      { content: '收工。' },
      { content: '再規劃。', toolCalls: [writeCall('停用之後的計畫')] },
      { content: '再收工。' },
    ]);
    await runOn(first);
    expect(todosIn(first.sessions.root.events)).toHaveLength(1);

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
    expect(bound.map((tool) => tool.name)).not.toContain(TODO_TOOL_NAME);

    // 開著的那條：工具在 `apply` 當下抓住了會話查找，樹上那一列卸了它也照樣寫（決議 §3-2 第 6 條）。
    await runOn(first, '再來一次。');
    expect(todosIn(first.sessions.root.events)).toEqual([
      [{ content: '停用之前的計畫', status: 'in_progress' }],
      [{ content: '停用之後的計畫', status: 'in_progress' }],
    ]);
    await closeThread(first);
    await closeThread(second);
  }, 90000);
});

describe('三個入口各有一條（拿掉任一入口的接線要紅）', () => {
  const PLAN: readonly ScriptedTurn[] = [
    { content: '規劃。', toolCalls: [writeCall('入口的計畫')] },
    { content: '收工。' },
  ];

  it('CLI：經樹上的內建列，真的 runCli 寫得進日誌（結果是計數句，不是「沒有接上會話」）', async () => {
    const dir = scratch();
    const patch = join(dir, 'scripted.patch.yml');
    await writeFile(patch, scriptedPatchText(PLAN), 'utf8');
    const lines: string[] = [];
    const record = (...parts: unknown[]): void => void lines.push(parts.join(' '));

    await runCli({
      argv: ['--patch', patch, '規劃一下。'],
      input: new PassThrough(),
      output: new PassThrough(),
      printer: { log: record, error: record },
      env: {},
    });

    const out = lines.join('\n');
    expect(out).toContain('收工。');
    expect(out).toContain('Updated todo list: 0 pending, 1 in progress, 0 completed.');
    expect(out).not.toContain(TODO_NOT_ATTACHED_MESSAGE);
  }, 60000);

  it('serve：每條 thread 的清單折進它自己的對話狀態，兩條 thread 同時活著互不串線', async () => {
    serve = await startScriptedServe(PLAN);
    const client = await serveClient(serve.running);
    const eventsA = await client.openEvents('todo-serve-a');
    const eventsB = await client.openEvents('todo-serve-b');
    await client.runStart('todo-serve-a', '規劃一下。');
    const stateA = await foldTurn(eventsA);
    await client.runStart('todo-serve-b', '規劃一下。');
    const stateB = await foldTurn(eventsB);
    await eventsA.return?.(undefined);
    await eventsB.return?.(undefined);

    expect(stateA.todos).toEqual([{ content: '入口的計畫', status: 'in_progress' }]);
    expect(stateB.todos).toEqual([{ content: '入口的計畫', status: 'in_progress' }]);
  }, 90000);

  it('沒有樹的呼叫端：同一個行程裡兩份無樹組裝各看各的註冊表，互不相見', async () => {
    const { env } = home();
    // 沒有樹：`loadDefaultPlugins` 不帶 tree，橋接列走 `bindDetached`，查找是那一次組裝自己的 `registry.sessions`。
    const loadedA = await loadDefaultPlugins({ env, warn: warnNothing });
    const loadedB = await loadDefaultPlugins({ env, warn: warnNothing });
    const builtA = await createCliAgent(
      { live: false },
      withScriptedModel(
        [...loadedA.plugins],
        [{ content: '甲規劃。', toolCalls: [writeCall('無樹甲')] }, { content: '甲收工。' }],
      ),
    );
    const builtB = await createCliAgent(
      { live: false },
      withScriptedModel(
        [...loadedB.plugins],
        [{ content: '乙規劃。', toolCalls: [writeCall('無樹乙')] }, { content: '乙收工。' }],
      ),
    );
    // 兩份用同一個 thread id、同時活著：各自的查找只看自己那一份。
    const regA = new SessionRegistry('same-id');
    const regB = new SessionRegistry('same-id');
    const attachA = builtA.attachSessions(regA);
    const attachB = builtB.attachSessions(regB);
    await Promise.all([
      builtA.agent.invoke(toAgentInvocation('跑。'), { configurable: { thread_id: 'same-id' } }),
      builtB.agent.invoke(toAgentInvocation('跑。'), { configurable: { thread_id: 'same-id' } }),
    ]);
    expect(todosIn(regA.root.events)).toEqual([[{ content: '無樹甲', status: 'in_progress' }]]);
    expect(todosIn(regB.root.events)).toEqual([[{ content: '無樹乙', status: 'in_progress' }]]);
    await attachA.detach();
    await attachB.detach();
    await builtA.dispose();
    await builtB.dispose();
  }, 90000);
});
