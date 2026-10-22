/**
 * agent-instructions 在 Cordis 樹上：「`agent/pre-step` 注入」與「呼叫當下的 fs」兩個接縫
 * （[#1474](https://github.com/DemianLi/nexus-agent/issues/1474)，逐條 thread 接縫的第五段）：驗收 B、D、E。
 * 量的是產品路徑——真的 `createCordisRoot`、真的 `loadDefaultPlugins`（帶樹）、真的相容層 `assembly.create`（serve 每條 thread
 * 一次）、真的 `attachSessions`、真的檔案系統 backend；不手搭 `ctx.plugin`。
 *
 * 驗收 A（SDK lint、一致性套件、套一次服務兩條 thread）在 `packages/nexus-plugin-agent-instructions` 與
 * `migrated-plugin-gate.test.ts`；既有的產品路徑測試（一個 agent 一份、子代理各有一份、摘要之後補回、畫面上看不到）是
 * `agent-instructions.test.ts`，斷言一個字沒動；`pre-step-middleware.test.ts` 量宿主建的 middleware 本身；驗收 C（golden）是一次性
 * 錄製，做法與數字寫在 PR 內文。
 *
 * **E 的核心風險**：fs 是「這條 thread 的工作區」。行程裡活著兩條以上的 thread，每一次注入都要靠 `thread_id` 認出主人；認錯的
 * 樣子是「A 的 AGENTS.md 被注入 B 的對話」，而兩邊各自都注入成功——沒有任何例外。所以這一檔所有「第二條 thread 活著」的格子，
 * 都讓兩條 thread 的 AGENTS.md **內容不同**，再從這一條跑；每一格都量**兩個方向**（對的有、錯的沒有）。
 */

import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import type { BaseMessage } from '@langchain/core/messages';
import { SessionRegistry } from '@nexus/core';
import type { PluginEntry } from '@nexus/core';
import {
  AGENT_INSTRUCTIONS_MIDDLEWARE_NAME,
  isAgentInstructionsMessage,
} from '@nexus/plugin-agent-instructions';
import { GENERAL_PURPOSE_SUBAGENT } from 'deepagents';
import { afterEach, describe, expect, it } from 'vitest';

import { HEADLESS_APPROVALS } from './agent-factory.js';
import { createNexusAgent } from './agent-factory.js';
import { createCliAgent } from './assembly-root.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { runCli } from './cli.js';
import { createCordisRoot, entryApprovalChannel } from './cordis-root.js';
import type { CordisRoot, NexusAssembly } from './cordis-root.js';
import { foldTurn, serveClient, shippedPlugins, withScriptedModel } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { LoopingChatModel } from './looping-model.js';
import { toAgentInvocation } from './messages.js';
import { isBridgeEntry, loadDefaultPlugins } from './plugin-config.js';
import type { LoadedPluginConfig } from './plugin-config.js';
import { buildPluginSnapshot } from './plugin-snapshot.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { scriptedPatchText } from './scripted-serve.js';
import { closedSessionEvents, sessionsUnder } from './session-files.fixture.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';
import { auditStartupEntries, REQUIRED_TREE_ENTRY_IDS } from './startup-audit.js';

const temporary: string[] = [];
const roots: CordisRoot[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await root.dispose().catch(() => {});
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix = 'nexus-instructions-tree-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(dir, 0o700);
  temporary.push(dir);
  return dir;
}

/** 一個工作區，裡面放好一份 AGENTS.md。 */
function workspaceWith(agentsMd: string | undefined): string {
  const dir = scratch('nexus-instructions-ws-');
  if (agentsMd !== undefined) writeFileSync(join(dir, 'AGENTS.md'), agentsMd, 'utf8');
  return dir;
}

function home(): NodeJS.ProcessEnv {
  return { [HARNESS_HOME_ENV]: scratch() };
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
const ID = 'agent-instructions';
const GP = GENERAL_PURPOSE_SUBAGENT.name;

interface Booted {
  readonly root: CordisRoot;
  readonly loaded: LoadedPluginConfig;
  readonly assembly: NexusAssembly;
}

/** 入口的順序：讀清單（帶樹）→ 建根、掛相容層與入口那一列。 */
async function boot(env: NodeJS.ProcessEnv, entry: 'serve' | 'cli' = 'serve'): Promise<Booted> {
  const root =
    entry === 'serve'
      ? newRoot()
      : (() => {
          const created = createCordisRoot({
            channel: entryApprovalChannel(HEADLESS_APPROVALS),
            contained: true,
          });
          roots.push(created);
          return created;
        })();
  const loaded = await loadDefaultPlugins({ env, warn: warnNothing }, { tree: root.tree });
  const assembly = await root.boot(entry, { plugins: loaded.plugins });
  return { root, loaded, assembly };
}

interface OpenThread {
  readonly built: Awaited<ReturnType<NexusAssembly['create']>>;
  readonly sessions: SessionRegistry;
  readonly attachment: ReturnType<Awaited<ReturnType<NexusAssembly['create']>>['attachSessions']>;
  readonly threadId: string;
  readonly workspace: string | undefined;
  /** 這條 thread 的（根）腳本模型：它讀到的每一份 prompt 都在 `prompts` 裡。 */
  readonly model: ScriptedChatModel;
}

/**
 * serve 的形狀：這條 thread 自己一次相容層組裝（自己的腳本模型、自己的工作區），自己一張註冊表，經 `attachSessions` 接上。
 * 回來的 thread **不收**：呼叫端決定它活多久。`workspace: undefined` 是沒給 `--workspace`。
 */
async function openThread(
  booted: Booted,
  threadId: string,
  turns: readonly ScriptedTurn[],
  options: {
    readonly workspace?: string | undefined;
    readonly extra?: readonly PluginEntry[];
    readonly invocation?: Partial<Parameters<NexusAssembly['create']>[0]>;
  } = {},
): Promise<OpenThread> {
  const workspace = 'workspace' in options ? options.workspace : workspaceWith('預設規矩。');
  const plugins = withScriptedModel([...booted.loaded.plugins, ...(options.extra ?? [])], turns);
  const built = await booted.assembly.create(
    {
      live: false,
      ...(workspace !== undefined && { workspace, sandbox: 'workspace-write' as const }),
      ...options.invocation,
    },
    { plugins },
  );
  const sessions = new SessionRegistry(threadId);
  const attachment = built.attachSessions(sessions);
  return { built, sessions, attachment, threadId, workspace, model: built.model as never };
}

async function runOn(thread: OpenThread, text = '開工'): Promise<void> {
  await thread.built.agent.invoke(toAgentInvocation(text), {
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

/** 一份 prompt 裡的基線文字（有幾則就幾段）。看的是記號不是文字。 */
function baselineTexts(prompt: readonly BaseMessage[]): string[] {
  return prompt.filter(isAgentInstructionsMessage).map((message) => message.text);
}

/** 一份日誌裡由這顆 plugin 注入的那幾則。 */
function injectedBaselines(events: readonly { type: string; data: unknown }[]) {
  return events.filter(
    (event) =>
      event.type === 'user/message' &&
      (event.data as { source?: { kind?: string; plugin?: string } }).source?.plugin ===
        AGENT_INSTRUCTIONS_MIDDLEWARE_NAME,
  );
}

/** 登記一個名叫 `worker` 的子代理；可以給它自己的模型。 */
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

describe('B：出貨清單上的 agent-instructions 經樹進來，位置與名字不變', () => {
  it('是橋接列、樹上 agent-instructions／fs／agent-loop 提供者三列都 ACTIVE、沒有掉列；啟動稽核過；快照上是 mounted', async () => {
    const env = home();
    const root = newRoot();
    const loaded = await loadDefaultPlugins({ env, warn: warnNothing }, { tree: root.tree });
    const entry = loaded.plugins.find((candidate) => loaded.rows.get(candidate)?.id === ID);
    expect(entry).toBeDefined();
    expect(entry !== undefined && isBridgeEntry(entry)).toBe(true);
    expect(entry?.plugin.name).toBe(ID);
    expect(loaded.dropped).toEqual([]);
    expect(loaded.rows.get(entry as never)).toEqual({
      id: ID,
      module: '@nexus/plugin-agent-instructions',
    });
    expect(() => auditStartupEntries(loaded, { live: false })).not.toThrow();

    const tree = await root.tree.context();
    expect(tree.loader.resolve(`include:${ID}`).fiber?.ctx.fiber.state).toBe(2);
    expect(tree.loader.resolve('fs').fiber?.ctx.fiber.state).toBe(2);
    expect(tree.loader.resolve('pre-step').fiber?.ctx.fiber.state).toBe(2);

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
      module: '@nexus/plugin-agent-instructions',
      running: { state: 'mounted' },
      saved: { state: 'mounted' },
      sync: 'same',
    });
  }, 60000);

  it('樹上的 agentLoop 服務：歸屬是 pre-step 那一列、契約 1.0.0；pre-step 是必掛的內建列', async () => {
    const root = newRoot();
    await loadDefaultPlugins({ env: home(), warn: warnNothing }, { tree: root.tree });
    const tree = await root.tree.context();
    const agentLoop = tree.get('agentLoop') as
      { provider?: string; contractVersion?: string } | undefined;
    expect(agentLoop?.provider).toBe('pre-step');
    expect(agentLoop?.contractVersion).toBe('1.0.0');
    expect(REQUIRED_TREE_ENTRY_IDS.has('pre-step')).toBe(true);
  }, 60000);
});

describe('E：同一棵樹上多條 thread 同時活著，每一次注入靠 thread_id 認出主人', () => {
  it('兩條 serve thread 各有自己的工作區與 AGENTS.md，交錯跑：各看到各的，互不串線；日誌也各記各的', async () => {
    const booted = await boot(home());
    const a = await openThread(booted, 'thread-a', [{ content: '甲好。' }], {
      workspace: workspaceWith('甲的規矩。'),
    });
    const b = await openThread(booted, 'thread-b', [{ content: '乙好。' }], {
      workspace: workspaceWith('乙的規矩。'),
    });
    await Promise.all([runOn(a), runOn(b)]);

    const aTexts = baselineTexts(a.model.prompts[0] ?? []);
    const bTexts = baselineTexts(b.model.prompts[0] ?? []);
    expect(aTexts).toHaveLength(1);
    expect(bTexts).toHaveLength(1);
    expect(aTexts[0]).toContain('甲的規矩。');
    expect(aTexts[0]).not.toContain('乙的規矩。');
    expect(bTexts[0]).toContain('乙的規矩。');
    expect(bTexts[0]).not.toContain('甲的規矩。');

    // 注入的訊息記進**這條 thread 自己的**日誌。
    for (const thread of [a, b]) {
      const root = thread.sessions.list().find((entry) => entry.address.kind === 'root');
      expect(injectedBaselines(root?.log.events ?? [])).toHaveLength(1);
    }
    await closeThread(a);
    await closeThread(b);
  }, 60000);

  it('一條有工作區、一條沒給 --workspace：沒給的那條沒有基線（不會撿到旁邊那條的）', async () => {
    const booted = await boot(home());
    const withWorkspace = await openThread(booted, 'with-ws', [{ content: '好。' }], {
      workspace: workspaceWith('有工作區的規矩。'),
    });
    const without = await openThread(booted, 'no-ws', [{ content: '好。' }], {
      workspace: undefined,
    });
    await Promise.all([runOn(withWorkspace), runOn(without)]);

    expect(baselineTexts(withWorkspace.model.prompts[0] ?? [])).toHaveLength(1);
    expect(baselineTexts(without.model.prompts[0] ?? [])).toHaveLength(0);
    const root = without.sessions.list().find((entry) => entry.address.kind === 'root');
    expect(injectedBaselines(root?.log.events ?? [])).toHaveLength(0);
    await closeThread(withWorkspace);
    await closeThread(without);
  }, 60000);

  it('工作區沒有 AGENTS.md：不注入、不記日誌', async () => {
    const booted = await boot(home());
    const thread = await openThread(booted, 'empty-ws', [{ content: '好。' }], {
      workspace: workspaceWith(undefined),
    });
    await runOn(thread);
    expect(baselineTexts(thread.model.prompts[0] ?? [])).toHaveLength(0);
    const root = thread.sessions.list().find((entry) => entry.address.kind === 'root');
    expect(injectedBaselines(root?.log.events ?? [])).toHaveLength(0);
    await closeThread(thread);
  }, 60000);

  it('同一條 thread 送第二句話：還是只有一則基線（記號在訊息上，不在閉包裡）', async () => {
    const booted = await boot(home());
    const other = await openThread(booted, 'bystander', [{ content: '旁觀。' }], {
      workspace: workspaceWith('旁邊的規矩。'),
    });
    const mine = await openThread(booted, 'twice', [{ content: '一。' }, { content: '二。' }], {
      workspace: workspaceWith('我的規矩。'),
    });
    await runOn(mine, '第一句');
    await runOn(mine, '第二句');
    expect(mine.model.prompts).toHaveLength(2);
    for (const prompt of mine.model.prompts) {
      const texts = baselineTexts(prompt);
      expect(texts).toHaveLength(1);
      expect(texts[0]).toContain('我的規矩。');
    }
    await closeThread(mine);
    await closeThread(other);
  }, 60000);

  for (const subagentType of ['worker', GP]) {
    it(`第二條 thread 活著時，同步子代理（${subagentType}）那幾輪看到的是這條 thread 自己的 AGENTS.md，日誌記在子代理自己那份`, async () => {
      const booted = await boot(home());
      const other = await openThread(booted, 'other', [{ content: '待著。' }], {
        workspace: workspaceWith('別條的規矩。'),
      });
      const mine = await openThread(
        booted,
        'mine',
        [
          {
            content: '委派。',
            toolCalls: [
              { name: 'task', args: { description: '幹活', subagent_type: subagentType } },
            ],
          },
          { content: '子代理收工。' },
          { content: '根收工。' },
        ],
        { workspace: workspaceWith('我的規矩。'), extra: [workerSource()] },
      );
      await runOn(mine);

      const subagentPrompts = mine.model.prompts.filter((prompt) =>
        prompt.some((message) => message.getType() === 'human' && message.text === '幹活'),
      );
      expect(subagentPrompts.length).toBeGreaterThan(0);
      for (const prompt of subagentPrompts) {
        const texts = baselineTexts(prompt);
        expect(texts).toHaveLength(1);
        expect(texts[0]).toContain('我的規矩。');
        expect(texts[0]).not.toContain('別條的規矩。');
      }
      const subagent = mine.sessions.list().find((entry) => entry.address.kind === 'subagent');
      expect(injectedBaselines(subagent?.log.events ?? [])).toHaveLength(1);
      expect(other.model.prompts).toHaveLength(0);
      await closeThread(mine);
      await closeThread(other);
    }, 60000);
  }

  it('背景子代理（thread_id 是 <root>/<runId>）：第二條 thread 活著時，它那幾輪看到這條 thread 自己的 AGENTS.md，日誌記在背景那一份', async () => {
    const booted = await boot(home());
    const other = await openThread(booted, 'other-bg', [{ content: '待著。' }], {
      workspace: workspaceWith('別條的規矩。'),
    });
    const worker = new ScriptedChatModel({ turns: [{ content: '背景收工。' }] });
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
        workspace: workspaceWith('我的規矩。'),
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

    expect(worker.prompts.length).toBeGreaterThan(0);
    for (const prompt of worker.prompts) {
      const texts = baselineTexts(prompt);
      expect(texts).toHaveLength(1);
      expect(texts[0]).toContain('我的規矩。');
      expect(texts[0]).not.toContain('別條的規矩。');
    }
    const background = mine.sessions.list().find((entry) => entry.address.kind === 'subagent');
    expect(background?.log.sessionId.startsWith('mine-bg/')).toBe(true);
    expect(injectedBaselines(background?.log.events ?? [])).toHaveLength(1);
    await closeThread(mine);
    await closeThread(other);
  }, 60000);

  it('同一條 thread id 重組（舊的那份沒收）之後，注入的是新的那份的工作區', async () => {
    const booted = await boot(home());
    const bystander = await openThread(booted, 'bystander', [{ content: '旁觀。' }], {
      workspace: workspaceWith('旁邊的規矩。'),
    });
    const stale = await openThread(booted, 'rebuilt', [{ content: '舊的。' }], {
      workspace: workspaceWith('舊的規矩。'),
    });
    const fresh = await openThread(booted, 'rebuilt', [{ content: '新的。' }], {
      workspace: workspaceWith('新的規矩。'),
    });
    await runOn(fresh);
    const texts = baselineTexts(fresh.model.prompts[0] ?? []);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('新的規矩。');
    expect(texts[0]).not.toContain('舊的規矩。');
    const freshRoot = fresh.sessions.list().find((entry) => entry.address.kind === 'root');
    const staleRoot = stale.sessions.list().find((entry) => entry.address.kind === 'root');
    expect(injectedBaselines(freshRoot?.log.events ?? [])).toHaveLength(1);
    expect(injectedBaselines(staleRoot?.log.events ?? [])).toHaveLength(0);

    // **反例（#1479）**：再跑**舊的那一份**。行程級的查找（`ThreadSessions`，同一個 thread id 取代成新的那份）和 fs 查找都會挑到新的；
    // 宿主用的是這一次組裝自己的 `registry.sessions`，所以這一輪的注入記在舊的那份自己的 root 日誌，新的那份的日誌一則都沒有多。
    // 宿主若改用行程級查找記日誌，這裡會反過來：舊的那份是 0、新的那份變 2。
    await runOn(stale);
    expect(injectedBaselines(staleRoot?.log.events ?? [])).toHaveLength(1);
    expect(injectedBaselines(freshRoot?.log.events ?? [])).toHaveLength(1);

    await stale.attachment.detach();
    await closeThread(fresh);
    await closeThread(bystander);
    await stale.built.dispose();
  }, 60000);
});

describe('三個入口各有一條（拿掉任一入口的接線要紅）', () => {
  it('CLI 的樹（boot "cli"）：經樹上的內建列，基線注入這條 thread 的工作區', async () => {
    const booted = await boot(home(), 'cli');
    const thread = await openThread(booted, 'cli-thread', [{ content: '好。' }], {
      workspace: workspaceWith('命令列的規矩。'),
    });
    await runOn(thread);
    const texts = baselineTexts(thread.model.prompts[0] ?? []);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('命令列的規矩。');
    await closeThread(thread);
  }, 60000);

  it('CLI 的樹沒給 --workspace：沒有基線', async () => {
    const booted = await boot(home(), 'cli');
    const thread = await openThread(booted, 'cli-no-ws', [{ content: '好。' }], {
      workspace: undefined,
    });
    await runOn(thread);
    expect(baselineTexts(thread.model.prompts[0] ?? [])).toHaveLength(0);
    await closeThread(thread);
  }, 60000);

  it('沒有樹的呼叫端：同一個行程裡兩份無樹組裝（同一個 thread id、各自的工作區）各注入各的 AGENTS.md，互不相見', async () => {
    const env = home();
    // 沒有樹：`loadDefaultPlugins` 不帶 tree，橋接列走 `bindDetached`，注入走那一次組裝自己的 host-services `fs`。
    const loadedA = await loadDefaultPlugins({ env, warn: warnNothing });
    const loadedB = await loadDefaultPlugins({ env, warn: warnNothing });
    const workspaceA = workspaceWith('無樹甲的規矩。');
    const workspaceB = workspaceWith('無樹乙的規矩。');
    const builtA = await createCliAgent(
      { live: false, workspace: workspaceA, sandbox: 'workspace-write' },
      withScriptedModel([...loadedA.plugins], [{ content: '甲好。' }]),
      workspaceA,
    );
    const builtB = await createCliAgent(
      { live: false, workspace: workspaceB, sandbox: 'workspace-write' },
      withScriptedModel([...loadedB.plugins], [{ content: '乙好。' }]),
      workspaceB,
    );
    const attachA = builtA.attachSessions(new SessionRegistry('same-id'));
    const attachB = builtB.attachSessions(new SessionRegistry('same-id'));
    const config = { configurable: { thread_id: 'same-id' } };
    await Promise.all([
      builtA.agent.invoke(toAgentInvocation('跑。'), config),
      builtB.agent.invoke(toAgentInvocation('跑。'), config),
    ]);

    const modelA = builtA.model as unknown as ScriptedChatModel;
    const modelB = builtB.model as unknown as ScriptedChatModel;
    const textsA = baselineTexts(modelA.prompts[0] ?? []);
    const textsB = baselineTexts(modelB.prompts[0] ?? []);
    expect(textsA).toHaveLength(1);
    expect(textsB).toHaveLength(1);
    expect(textsA[0]).toContain('無樹甲的規矩。');
    expect(textsA[0]).not.toContain('無樹乙的規矩。');
    expect(textsB[0]).toContain('無樹乙的規矩。');
    expect(textsB[0]).not.toContain('無樹甲的規矩。');
    await attachA.detach();
    await attachB.detach();
    await builtA.dispose();
    await builtB.dispose();
  }, 90000);
});

describe('D：輪數不變——這顆 middleware 每次 invoke 一格、每輪零格，有沒有 --workspace 都一樣', () => {
  /**
   * 預設上限 100、出貨清單、CLI 的形狀（沒有插話載體）：`floor((100 - 1) / 3) = 33` 是提醒器打底的輪數，再加 `beforeAgent` 這一格
   * 是 32（`settings/recursion-limit.ts` 引用的數字）。**沒給 `--workspace` 時組裝點照樣墊一顆 StateBackend，宿主的
   * middleware 照建**，所以兩種組裝一樣是 32；若沒有 backend 就不建，沒給 workspace 的那一邊會變回 33。
   */
  it.each([
    ['有 --workspace', true],
    ['沒給 --workspace', false],
  ] as const)(
    '%s：出貨清單在預設上限下跑 32 輪',
    async (_label, withWorkspace) => {
      const shipped = await shippedPlugins();
      const workspace = withWorkspace ? workspaceWith('規矩。') : undefined;
      const model = new LoopingChatModel();
      const { agent, dispose } = await createNexusAgent({
        model,
        plugins: shipped,
        summarization: false,
        ...(workspace !== undefined && {
          backend: new ContainedFilesystemBackend({ rootDir: workspace, mode: 'workspace-write' }),
        }),
      });
      try {
        await expect(agent.invoke(toAgentInvocation('一直跑'))).rejects.toThrow(/Recursion limit/);
      } finally {
        await dispose();
      }
      expect(model.calls).toBe(32);
      // 有 workspace 時第一輪 prompt 裡有基線，沒有時沒有——輪數相同，內容不同。
      expect(baselineTexts(model.seen[0] ?? [])).toHaveLength(withWorkspace ? 1 : 0);
    },
    60000,
  );
});

/**
 * **middleware 鏈的名字與順序**（[#1479](https://github.com/DemianLi/nexus-agent/issues/1479)，#1474 驗收 D）。
 *
 * 期望值**寫死**，是 `b0a74042`（#1475 之前、agent-instructions 還是舊外殼 `useWithBackend` 的最後一個 develop）上實際錄到的名單，
 * 不是拿當前分支自己比自己：遷到樹上、改由橋接列 `registry.middleware.use` 折進之後，`AgentInstructionsMiddleware` 必須還在
 * 同一格（`nexusSessionCheckpoint` 之後、`nexusSandboxPolicy` 之前），其餘一個都不能多、不能少、不能換位。
 *
 * 錄法（PR 內文也寫了）：`git worktree add --detach <dir> b0a74042`、`pnpm install --frozen-lockfile`，在 `apps/harness/src/` 放一個
 * 臨時測試，三種組裝各建一次（出貨清單＝`createNexusAgent({ plugins: await shippedPlugins(), summarization: false, backend })`；
 * CLI／serve＝`createCordisRoot({ channel: entryApprovalChannel(HEADLESS_APPROVALS | undefined), contained: true })` ＋ `loadDefaultPlugins(…, { tree })` ＋
 * `root.boot('cli' | 'serve')` ＋ `assembly.create(…)`），都帶一個放了 AGENTS.md 的工作區；名單取自建好的 agent 身上那份
 * middleware stack（與 `summarization.test.ts` 的 `middlewareNames` 同一個走法）。同一支探針在這個分支上跑，三份與下面逐字相同。
 * CLI 與 serve 錄到的兩份相同；出貨清單（不經 `root.boot`，沒有入口掛的列）比它們少 `nexusStreamRetry` 與 `nexusFileReference` 兩格。
 */
const CHAIN_SHIPPED = [
  'SkillsMiddleware',
  'FilesystemMiddleware',
  'subAgentMiddleware',
  'SummarizationMiddleware',
  'patchToolCallsMiddleware',
  'nexusToolBarrier',
  'nexusToolFailureContainment',
  'nexusTurnCancel',
  'nexusSearchOverflow',
  'nexusPlanMode',
  'nexusToolPreExecute',
  'nexusApprovalGate',
  'nexusFileObservationPolicy',
  'nexusRepeatToolReminder',
  'nexusModelCallEvents',
  'nexusEmptyResponse',
  'nexusModelUsage',
  'nexusSessionCheckpoint',
  'AgentInstructionsMiddleware',
  'nexusSandboxPolicy',
  'nexusSystemPrompt',
  'nexusToolPostExecute',
  'nexusToolOutputSchema',
  'nexusFsToolErrors',
  'nexusReadContinuation',
  'nexusInvalidToolArgs',
  'nexusToolExecute',
  'nexusMaxTokens',
  'nexusRequestSnapshot',
  'nexusTurnCancelModelSignal',
] as const;

const CHAIN_CLI = [
  'SkillsMiddleware',
  'FilesystemMiddleware',
  'subAgentMiddleware',
  'SummarizationMiddleware',
  'patchToolCallsMiddleware',
  'nexusToolBarrier',
  'nexusToolFailureContainment',
  'nexusTurnCancel',
  'nexusSearchOverflow',
  'nexusPlanMode',
  'nexusToolPreExecute',
  'nexusApprovalGate',
  'nexusFileObservationPolicy',
  'nexusRepeatToolReminder',
  'nexusStreamRetry',
  'nexusModelCallEvents',
  'nexusEmptyResponse',
  'nexusModelUsage',
  'nexusSessionCheckpoint',
  'AgentInstructionsMiddleware',
  'nexusSandboxPolicy',
  'nexusFileReference',
  'nexusSystemPrompt',
  'nexusToolPostExecute',
  'nexusToolOutputSchema',
  'nexusFsToolErrors',
  'nexusReadContinuation',
  'nexusInvalidToolArgs',
  'nexusToolExecute',
  'nexusMaxTokens',
  'nexusRequestSnapshot',
  'nexusTurnCancelModelSignal',
] as const;

const CHAIN_SERVE = [
  'SkillsMiddleware',
  'FilesystemMiddleware',
  'subAgentMiddleware',
  'SummarizationMiddleware',
  'patchToolCallsMiddleware',
  'nexusToolBarrier',
  'nexusToolFailureContainment',
  'nexusTurnCancel',
  'nexusSearchOverflow',
  'nexusPlanMode',
  'nexusToolPreExecute',
  'nexusApprovalGate',
  'nexusFileObservationPolicy',
  'nexusRepeatToolReminder',
  'nexusStreamRetry',
  'nexusModelCallEvents',
  'nexusEmptyResponse',
  'nexusModelUsage',
  'nexusSessionCheckpoint',
  'AgentInstructionsMiddleware',
  'nexusSandboxPolicy',
  'nexusFileReference',
  'nexusSystemPrompt',
  'nexusToolPostExecute',
  'nexusToolOutputSchema',
  'nexusFsToolErrors',
  'nexusReadContinuation',
  'nexusInvalidToolArgs',
  'nexusToolExecute',
  'nexusMaxTokens',
  'nexusRequestSnapshot',
  'nexusTurnCancelModelSignal',
] as const;

/** agent 身上那份 middleware stack 的名字；找不到就失敗（基座的內部形狀變了，紅了正是要知道的事）。 */
function middlewareNames(agent: unknown): string[] {
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number): string[] | null => {
    if (depth > 5 || node == null || typeof node !== 'object' || seen.has(node)) return null;
    seen.add(node);
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'middleware' && Array.isArray(value)) {
        return value.map((entry) => String((entry as { name?: string })?.name));
      }
      const found = walk(value, depth + 1);
      if (found) return found;
    }
    return null;
  };
  const names = walk(agent, 0);
  if (!names) throw new Error('找不到 agent 的 middleware stack——基座的內部形狀變了。');
  return names;
}

/**
 * #1625 之後清單上多一列 `time-context`，緊接在 `agent-instructions` 下面、走同一個 `agent/pre-step` 接縫：宿主為每位 listener 各建一顆
 * `beforeAgent` middleware，所以鏈上在 `AgentInstructionsMiddleware` 後面多**恰好一格** `TimeContextMiddleware`。上面寫死的名單仍是
 * `b0a74042` 錄到的那一份，只在這裡插這一格，其餘一個都不能多、不能少、不能換位。
 */
const withTimeContext = (chain: readonly string[]): string[] =>
  chain.flatMap((name) =>
    name === 'AgentInstructionsMiddleware' ? [name, 'TimeContextMiddleware'] : [name],
  );

describe('D：middleware 鏈的名字與順序，與 b0a74042 實際錄到的逐字相同（出貨清單、CLI、serve 各一次）', () => {
  it('出貨清單（createNexusAgent）', async () => {
    const shipped = await shippedPlugins();
    const { agent, dispose } = await createNexusAgent({
      model: new LoopingChatModel(),
      plugins: shipped,
      summarization: false,
      backend: new ContainedFilesystemBackend({
        rootDir: workspaceWith('規矩。'),
        mode: 'workspace-write',
      }),
    });
    try {
      expect(middlewareNames(agent)).toEqual(withTimeContext(CHAIN_SHIPPED));
    } finally {
      await dispose();
    }
  }, 60000);

  it.each([
    ['CLI', 'cli', CHAIN_CLI],
    ['serve', 'serve', CHAIN_SERVE],
  ] as const)(
    '%s 的樹（root.boot）',
    async (_label, entry, expected) => {
      const booted = await boot(home(), entry);
      const thread = await openThread(booted, `chain-${entry}`, [{ content: '好。' }], {
        workspace: workspaceWith('規矩。'),
      });
      try {
        expect(middlewareNames(thread.built.agent)).toEqual(withTimeContext(expected));
      } finally {
        await closeThread(thread);
      }
    },
    60000,
  );
});

/** 一個 home 底下所有會話落了盤的事件，連同它來自哪一份的日誌檔（經 `session-files.fixture.ts`，#1868）。 */
async function logEventsOf(home: string): Promise<{ file: string; type: string; data: unknown }[]> {
  const dir = join(home, 'sessions');
  if (!existsSync(dir)) return [];
  const out: { file: string; type: string; data: unknown }[] = [];
  for (const session of await sessionsUnder(dir)) {
    for (const event of await closedSessionEvents(session))
      out.push({ file: session.logPath, type: event.type, data: event.data });
  }
  return out;
}

describe('真的入口：runCli 與 runServe（落盤的會話日誌是證據）', () => {
  it.each([
    ['有 --workspace', true],
    ['沒給 --workspace', false],
  ] as const)(
    'runCli，%s：日誌裡%s基線',
    async (_label, withWorkspace) => {
      const home = scratch();
      const workspace = workspaceWith('命令列入口的規矩。');
      const patch = join(home, 'scripted.patch.yml');
      writeFileSync(patch, scriptedPatchText([{ content: '好。' }]), { mode: 0o600 });
      const lines: string[] = [];
      const record = (...parts: unknown[]): void => void lines.push(parts.join(' '));
      await runCli({
        argv: ['--patch', patch, ...(withWorkspace ? ['--workspace', workspace] : []), '開工。'],
        input: new PassThrough(),
        output: new PassThrough(),
        printer: { log: record, error: record },
        env: { [HARNESS_HOME_ENV]: home },
        cwd: workspace,
      });
      const injected = (await logEventsOf(home)).filter(
        (event) =>
          event.type === 'user/message' &&
          (event.data as { source?: { plugin?: string } }).source?.plugin ===
            AGENT_INSTRUCTIONS_MIDDLEWARE_NAME,
      );
      expect(lines.join('\n')).toContain('好。');
      expect(injected).toHaveLength(withWorkspace ? 1 : 0);
      if (withWorkspace) expect(JSON.stringify(injected[0]?.data)).toContain('命令列入口的規矩。');
    },
    60000,
  );

  it('runServe：同一台 serve 同時活著兩條 thread，各自的日誌裡各有一則基線，內容是 --workspace 的 AGENTS.md', async () => {
    const home = scratch();
    const workspace = workspaceWith('serve 入口的規矩。');
    const patch = join(home, 'scripted.patch.yml');
    writeFileSync(patch, scriptedPatchText([{ content: '好。' }]), { mode: 0o600 });
    const running = (await runServe({
      argv: ['--port', '0', '--workspace', workspace, '--patch', patch],
      log: () => undefined,
      env: { [HARNESS_HOME_ENV]: home },
    })) as RunningServe;
    try {
      const client = await serveClient(running);
      const [downA, downB] = await Promise.all([
        client.openEvents('serve-thread-a'),
        client.openEvents('serve-thread-b'),
      ]);
      await Promise.all([
        client.runStart('serve-thread-a', '開工甲。'),
        client.runStart('serve-thread-b', '開工乙。'),
      ]);
      await Promise.all([foldTurn(downA), foldTurn(downB)]);
      await downA.return?.(undefined);
      await downB.return?.(undefined);
    } finally {
      await running.close();
    }
    const injected = (await logEventsOf(home)).filter(
      (event) =>
        event.type === 'user/message' &&
        (event.data as { source?: { plugin?: string } }).source?.plugin ===
          AGENT_INSTRUCTIONS_MIDDLEWARE_NAME,
    );
    expect(injected).toHaveLength(2);
    expect(new Set(injected.map((event) => event.file)).size).toBe(2);
    for (const event of injected)
      expect(JSON.stringify(event.data)).toContain('serve 入口的規矩。');
  }, 90000);
});
