/**
 * feedback 在 Cordis 樹上，命令接縫與「插件提供、宿主消費」的服務接縫上樹（[#1456](https://github.com/DemianLi/nexus-agent/issues/1456)）：
 * 驗收 B、D、E、F、G 與 Q5 那條已知的縫。量的是產品路徑——真的 `createCordisRoot`、真的 `loadDefaultPlugins`（帶樹）、真的寫入口
 * `changePlugin`、真的 `createCliAgent`；不手搭 `ctx.plugin`。
 *
 * 「這一條 thread 有沒有評分服務與 `/feedback`」看的是組裝點交出來的 `built.feedback` 與 `built.commands`——wire handler 與 pump
 * 讀的就是這兩樣，不是清單長什麼樣。驗收 C（行為不變的 golden）是一次性錄製，不在這個檔，做法與數字寫在 PR 內文。
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemorySaver } from '@langchain/langgraph';
import { FeedbackDurabilityUnavailableError, SessionLog } from '@nexus/core';
import { manifest as feedbackManifest } from '@nexus/plugin-feedback';
import { effectiveReload } from '@nexus/sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { createCliAgent } from './assembly-root.js';
import { createCordisRoot } from './cordis-root.js';
import type { CordisRoot } from './cordis-root.js';
import { createFeedbackPlugin } from './feedback.fixture.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { changePlugin } from './plugin-change.js';
import { isBridgeEntry, loadDefaultPlugins, loadPluginConfig } from './plugin-config.js';
import type { LoadedPluginConfig } from './plugin-config.js';
import { classOfRow } from './plugin-row-classes.js';
import { buildPluginSnapshot } from './plugin-snapshot.js';
import { ScriptedChatModel } from './scripted-model.js';
import { auditStartupEntries } from './startup-audit.js';

const temporary: string[] = [];
const roots: CordisRoot[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await root.dispose().catch(() => {});
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix = 'nexus-feedback-tree-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(dir, 0o700);
  temporary.push(dir);
  return dir;
}

function newRoot(): CordisRoot {
  const root = createCordisRoot();
  roots.push(root);
  return root;
}

const warnNothing = (): void => {};
const ID = 'feedback';

function home(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = scratch();
  return { dir, env: { [HARNESS_HOME_ENV]: dir } };
}

function write(dir: string, name: string, source: string): string {
  const path = join(dir, name);
  writeFileSync(path, source, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/** 一份 `--patch` 覆蓋層。 */
function overlay(dir: string, body: string, name = 'overlay.yml'): string {
  return write(dir, name, body);
}

async function assemble(loaded: LoadedPluginConfig) {
  const built = await createCliAgent({ live: false }, loaded.plugins, undefined);
  return { loaded, built };
}

/**
 * 清單是自己搭的（暫存的出貨檔，沒有模型提供者那幾列）時用：直接用腳本模型組一個 agent，看組裝點交出來的 `feedback` 與
 * `commands`。
 */
async function assembleBare(loaded: LoadedPluginConfig) {
  const built = await createNexusAgent({
    model: new ScriptedChatModel({ turns: [] }),
    checkpointer: new MemorySaver(),
    plugins: loaded.plugins,
  });
  return { loaded, built };
}

/** 一條 thread：讀清單（帶樹，臨界區）→ 組 agent。 */
async function openThread(
  root: CordisRoot,
  env: NodeJS.ProcessEnv,
  options: { patches?: string[] } = {},
) {
  const loaded = await loadDefaultPlugins(
    { env, warn: warnNothing, ...(options.patches && { patches: options.patches }) },
    { tree: root.tree },
  );
  return assemble(loaded);
}

type Thread = Awaited<ReturnType<typeof openThread>>;

/** 這條 thread 的備註上限：送一則一定超過的備註，看服務回報的 `maxBytes`。 */
async function limitOf(thread: Thread): Promise<number | undefined> {
  const feedback = thread.built.feedback;
  if (feedback === undefined) return undefined;
  const result = await feedback.put(new SessionLog('limit'), {
    messageId: 'x',
    rating: 'positive',
    note: 'x'.repeat(100_000),
    ifVersion: null,
  });
  return !result.ok && result.error.code === 'note-too-large' ? result.error.maxBytes : undefined;
}

/** 這條 thread 的 `/feedback` 記進日誌之後，日誌裡有幾顆 `feedback/record`。 */
async function recordsAfterCommand(thread: Thread, text: string): Promise<number> {
  const command = thread.built.commands.find('feedback');
  if (command === undefined) throw new Error('這條 thread 沒有 /feedback');
  const log = new SessionLog('records');
  await command.handler({
    commandId: 'c1',
    rawInput: text,
    signal: new AbortController().signal,
    sessionLog: log,
    attachments: [],
    steer: () => undefined,
  });
  return log.events.filter((event) => event.type === 'feedback/record').length;
}

describe('B：出貨清單上的 feedback 經樹進來，位置與名字不變', () => {
  it('是橋接列、樹上那一列與命令登記處都 ACTIVE、沒有掉列；啟動稽核過；快照上是 mounted', async () => {
    const { env } = home();
    const root = newRoot();
    const loaded = await loadDefaultPlugins({ env, warn: warnNothing }, { tree: root.tree });
    const entry = loaded.plugins.find((candidate) => loaded.rows.get(candidate)?.id === ID);
    expect(entry).toBeDefined();
    expect(entry !== undefined && isBridgeEntry(entry)).toBe(true);
    expect(entry?.plugin.name).toBe('feedback');
    expect(loaded.dropped).toEqual([]);
    expect(loaded.rows.get(entry as never)).toEqual({ id: ID, module: '@nexus/plugin-feedback' });
    expect(() => auditStartupEntries(loaded, { live: false })).not.toThrow();

    const tree = await root.tree.context();
    expect(tree.loader.resolve(`include:${ID}`).fiber?.ctx.fiber.state).toBe(2);
    // 命令登記處是樹上一列，起來了；它是必掛的列（跟工具、投影、技能來源登記處一樣）。
    expect(tree.loader.resolve('commands').fiber?.ctx.fiber.state).toBe(2);

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
      module: '@nexus/plugin-feedback',
      running: { state: 'mounted' },
      saved: { state: 'mounted' },
      sync: 'same',
    });
  }, 60000);

  // 驗收 G：歸屬判斷靠 `.provider`，要經 Cordis 的 traceable proxy 讀得到。
  it('G：宿主從 root 取得的服務，`.provider` 是樹上那一列、`.contractVersion` 是定義套件的', async () => {
    const { env } = home();
    const root = newRoot();
    await loadDefaultPlugins({ env, warn: warnNothing }, { tree: root.tree });
    const tree = await root.tree.context();
    const service = tree.get('messageFeedback') as
      { provider?: string; contractVersion?: string } | undefined;
    expect(service?.provider).toBe(`include:${ID}`);
    expect(service?.contractVersion).toBe('2.0.0');
  }, 60000);

  it('經樹進來的 thread 有評分服務與 /feedback（同一份清單，沒有樹的呼叫端也一樣）', async () => {
    const { env } = home();
    const thread = await openThread(newRoot(), env);
    expect(thread.built.feedback).toBeDefined();
    expect(await limitOf(thread)).toBe(8192);
    const command = thread.built.commands.find('feedback');
    expect(command).toMatchObject({ name: 'feedback', recordInput: false });
    expect(thread.built.commands.list().map((descriptor) => descriptor.name)).toContain('feedback');
    expect(await recordsAfterCommand(thread, '回答錯了')).toBe(1);
    await thread.built.dispose();

    // 沒有樹的呼叫端：手搭的清單走 `mountDetached`，同一份清單；那一次掛載用完即丟、沒有落盤確認，所以評分存不住（#1606），
    // 評語照常。
    const detached = await loadDefaultPlugins({ env, warn: warnNothing });
    const bare = await assemble(detached);
    await expect(limitOf(bare)).rejects.toThrow(FeedbackDurabilityUnavailableError);
    expect(await recordsAfterCommand(bare, '回答錯了')).toBe(1);
    await bare.built.dispose();
  }, 60000);

  it('reload 分類：manifest 宣告的不比宿主的分類寬；快照上停用後是「下一條 thread」那一類', async () => {
    const host = {
      config:
        classOfRow(ID, '@nexus/plugin-feedback') === 'startup-read' ? 'restart' : 'next-thread',
    } as const;
    expect(effectiveReload(feedbackManifest.reload, host)).toEqual({
      code: 'restart',
      config: 'next-thread',
    });

    const { env } = home();
    const running = await loadDefaultPlugins({ env, warn: warnNothing }, { tree: newRoot().tree });
    await changePlugin({ op: 'disable', id: ID }, { env });
    const saved = await loadDefaultPlugins({ env, warn: warnNothing }, { tree: newRoot().tree });
    const pick = (loaded: LoadedPluginConfig) => ({
      entries: loaded.entries,
      ids: loaded.ids,
      plugins: loaded.plugins,
      rows: loaded.rows,
      drops: loaded.dropped.map(({ id, stage }) => ({ id, stage })),
    });
    const snapshot = buildPluginSnapshot({
      running: pick(running),
      saved: pick(saved),
      generatedAt: new Date(0),
    });
    expect(snapshot.rows.find((row) => row.id === ID)).toMatchObject({
      running: { state: 'mounted' },
      saved: { state: 'disabled' },
      sync: 'next-thread',
    });
  }, 60000);
});

describe('D：樹上那一列停用或改設定，開著的 thread 照舊，下一條才看到新的', () => {
  it('停用：寫入之後開的 thread 沒有服務也沒有 /feedback（回 not_supported 那一側）；開著的那條照舊評得到、記得到；再啟用又有', async () => {
    const { env } = home();
    const root = newRoot();
    const first = await openThread(root, env);

    await changePlugin({ op: 'disable', id: ID }, { env });
    const second = await openThread(root, env);
    const tree = await root.tree.context();
    expect(tree.loader.resolve(`include:${ID}`).fiber?.ctx.fiber.state).toBe(4);
    // 卸下之後 root 上讀不到，宿主不會再把它折給新的 thread。
    expect(tree.get('messageFeedback')).toBeUndefined();

    expect(second.built.feedback).toBeUndefined();
    expect(second.built.commands.find('feedback')).toBeUndefined();

    // 開著的那條：組裝當下那一份快照在它手上，樹上那一列卸了它也照樣呼叫（決議 §3-2 第 6 條；驗收 D）。
    expect(await limitOf(first)).toBe(8192);
    expect(await recordsAfterCommand(first, '卸下之後還記得到')).toBe(1);
    expect(await first.built.feedback?.list(new SessionLog('l'))).toEqual({
      ok: true,
      value: { items: [] },
    });

    await changePlugin({ op: 'enable', id: ID }, { env });
    const third = await openThread(root, env);
    expect(await limitOf(third)).toBe(8192);
    for (const thread of [first, second, third]) await thread.built.dispose();
  }, 90000);

  it('改 maxNoteBytes：下一條 thread 用新的上限，開著的那條照舊；改回去又是原本的', async () => {
    const { env } = home();
    const root = newRoot();
    const first = await openThread(root, env);

    await changePlugin({ op: 'config-set', id: ID, config: { maxNoteBytes: 16 } }, { env });
    const second = await openThread(root, env);
    expect(await limitOf(second)).toBe(16);
    expect(await limitOf(first)).toBe(8192);

    await changePlugin({ op: 'config-reset', id: ID }, { env });
    const third = await openThread(root, env);
    expect(await limitOf(third)).toBe(8192);
    for (const thread of [first, second, third]) await thread.built.dispose();
  }, 90000);
});

describe('E：宿主取服務時自己檢查契約版本（Q2 (a)）', () => {
  /** 一顆假的提供者：提供 `messageFeedback`，契約版本與歸屬可調；沒有任何 import 以外的依賴。 */
  function fakeProvider(options: { id: string; version: string }): string {
    return `import { z } from 'zod';
export const name = ${JSON.stringify(options.id)};
export const Config = z.strictObject({});
export const manifest = {
  id: ${JSON.stringify(options.id)}, version: '1.0.0', owner: 't',
  provides: [{ token: 'messageFeedback', version: ${JSON.stringify(options.version)} }],
  consumes: [], config: Config, reload: { code: 'restart', config: 'next-thread' }, capabilities: [],
};
export function apply(ctx) {
  ctx.provide('messageFeedback', {
    provider: 'include:${options.id}', contractVersion: ${JSON.stringify(options.version)},
    put() {}, delete() {}, list() {}, record() {},
  });
}
`;
  }

  it('主版號不合：提供者那一列掉在 requires，訊息指名「宿主」、提供者與兩個版本；其餘列照常', async () => {
    const dir = scratch();
    const module = write(dir, 'fb-v1.mjs', fakeProvider({ id: 'fb-v1', version: '1.4.0' }));
    const shipped = write(dir, 'cordis.yml', `- id: fb-v1\n  name: 'file://${module}'\n`);
    const root = newRoot();
    const loaded = await loadPluginConfig({ shipped, warn: warnNothing }, { tree: root.tree });
    const drop = loaded.dropped.find((candidate) => candidate.id === 'fb-v1');
    expect(drop?.stage).toBe('requires');
    expect(drop?.message).toContain('宿主');
    expect(drop?.message).toContain('messageFeedback');
    expect(drop?.message).toContain('^2.0.0');
    expect(drop?.message).toContain('include:fb-v1');
    expect(drop?.message).toContain('1.4.0');
    // 掉了的列的服務沒有交給任何一條 thread。
    const thread = await assembleBare(loaded);
    expect(thread.built.feedback).toBeUndefined();
    await thread.built.dispose();
  }, 60000);

  it('同一個主版號、次版號不同：照常折進去', async () => {
    const dir = scratch();
    const module = write(dir, 'fb-v24.mjs', fakeProvider({ id: 'fb-v24', version: '2.4.0' }));
    const shipped = write(dir, 'cordis.yml', `- id: fb-v24\n  name: 'file://${module}'\n`);
    const root = newRoot();
    const loaded = await loadPluginConfig({ shipped, warn: warnNothing }, { tree: root.tree });
    expect(loaded.dropped).toEqual([]);
    const thread = await assembleBare(loaded);
    expect(thread.built.feedback).toBeDefined();
    await thread.built.dispose();
  }, 60000);
});

describe('F：兩列提供同一個服務、兩列登記同名命令（Q1、Q5 (a)）', () => {
  /** 在 feedback 後面再插一列同一個套件。 */
  const TWIN = (maxNoteBytes: number) =>
    `- insert:\n    - id: twin-feedback\n      name: '@nexus/plugin-feedback'\n      config:\n        maxNoteBytes: ${String(maxNoteBytes)}\n`;

  it('兩列 feedback：後掛的那一列掉在 apply，訊息指名先掛的那一列；先掛的照舊，這條 thread 組得起來', async () => {
    const { dir, env } = home();
    const loaded = await loadDefaultPlugins(
      { env, patches: [overlay(dir, TWIN(32))], warn: warnNothing },
      { tree: newRoot().tree },
    );
    const drop = loaded.dropped.find((candidate) => candidate.id === 'twin-feedback');
    expect(drop?.stage).toBe('apply');
    // Cordis 在 `provide` 當場拋，訊息指名服務與先掛的那一列。
    expect(drop?.message).toContain('messageFeedback');
    expect(drop?.message).toContain('has been registered');
    expect(loaded.dropped.find((candidate) => candidate.id === ID)).toBeUndefined();
    const thread = await assemble(loaded);
    expect(await limitOf(thread)).toBe(8192);
    await thread.built.dispose();
  }, 60000);

  /** 兩顆只登記同一個命令名的函式插件。 */
  function commandPlugin(id: string): string {
    return `import { z } from 'zod';
export const name = ${JSON.stringify(id)};
export const inject = { commands: { range: '^1.0.0' } };
export const Config = z.strictObject({});
export const manifest = {
  id: ${JSON.stringify(id)}, version: '1.0.0', owner: 't',
  provides: [], consumes: [{ token: 'commands', range: '^1.0.0' }],
  config: Config, reload: { code: 'restart', config: 'next-thread' }, capabilities: [],
};
export function apply(ctx) {
  ctx.commands.register({ name: 'dup', description: ${JSON.stringify(id)}, handler: () => ({ kind: 'success' }) });
}
`;
  }

  it('兩列登記同名命令：後掛的那一列掉在 apply，訊息指名兩邊；先掛的命令照舊在', async () => {
    const dir = scratch();
    const a = write(dir, 'cmd-a.mjs', commandPlugin('cmd-a'));
    const b = write(dir, 'cmd-b.mjs', commandPlugin('cmd-b'));
    const shipped = write(
      dir,
      'cordis.yml',
      `- id: cmd-a\n  name: 'file://${a}'\n- id: cmd-b\n  name: 'file://${b}'\n`,
    );
    const root = newRoot();
    const loaded = await loadPluginConfig({ shipped, warn: warnNothing }, { tree: root.tree });
    const drop = loaded.dropped.find((candidate) => candidate.id === 'cmd-b');
    expect(drop?.stage).toBe('apply');
    expect(drop?.message).toContain('/dup');
    expect(drop?.message).toContain('include:cmd-a');
    expect(drop?.message).toContain('include:cmd-b');
    expect(loaded.dropped.find((candidate) => candidate.id === 'cmd-a')).toBeUndefined();
    const thread = await assembleBare(loaded);
    expect(thread.built.commands.find('dup')?.description).toBe('cmd-a');
    await thread.built.dispose();
  }, 60000);

  it('同一列改設定重掛：不會被自己舊的那一份判成重名（跨多次寫入）', async () => {
    const { env } = home();
    const root = newRoot();
    for (const config of [{ maxNoteBytes: 64 }, { maxNoteBytes: 128 }, { maxNoteBytes: 8192 }]) {
      await changePlugin({ op: 'config-set', id: ID, config }, { env });
      const thread = await openThread(root, env);
      expect(thread.loaded.dropped).toEqual([]);
      expect(await limitOf(thread)).toBe(config.maxNoteBytes);
      await thread.built.dispose();
    }
  }, 90000);
});

describe('Q5 已知的縫：樹上的命令跟相容層的命令撞名，要到組 thread 時才掉', () => {
  it('讀清單那一步樹上的 /feedback 沒有問題（提供者看不到相容層的列）；組 thread 時 registry 拒絕，訊息指名兩邊', async () => {
    const { env } = home();
    const loaded = await loadDefaultPlugins({ env, warn: warnNothing }, { tree: newRoot().tree });
    expect(loaded.dropped).toEqual([]);
    // 相容層的一顆（NexusPlugin 外殼）登記同名命令：提供者只收樹上的列，這一筆不經它。
    const colliding = {
      plugin: {
        name: 'colliding-feedback',
        apply(registry: { commands: { register(definition: unknown): void } }) {
          registry.commands.register({
            name: 'feedback',
            description: '撞名',
            handler: () => ({ kind: 'success' }),
          });
        },
      },
    };
    await expect(
      createCliAgent({ live: false }, [...loaded.plugins, colliding as never], undefined),
    ).rejects.toThrow(/\/feedback/u);
  }, 60000);

  it('相容層那一顆的 feedback 外殼（夾具）仍然提供同一份行為：手搭清單的測試不受影響', async () => {
    const built = await createNexusAgent({
      model: new ScriptedChatModel({ turns: [] }),
      checkpointer: new MemorySaver(),
      plugins: [createFeedbackPlugin({ maxNoteBytes: 64 })],
    });
    expect(built.feedback).toBeDefined();
    expect(built.commands.find('feedback')?.recordInput).toBe(false);
    await built.dispose();
  }, 60000);
});
