/**
 * token-meter 在 Cordis 樹上，投影接縫上樹（[#1421](https://github.com/DemianLi/nexus-agent/issues/1421)）：驗收 B、C、E、F、I。
 * 量的是產品路徑——真的 `createCordisRoot`、真的 `loadDefaultPlugins`／`loadPluginConfig`（帶樹）、真的寫入口 `changePlugin`、
 * 真的 `createCliAgent`；不手搭 `ctx.plugin`。
 *
 * 「這一條 thread 有沒有這個投影」看的是組出來的 agent 的 `projections.list()`（宿主把它交給 wire 的投影通道，
 * `agent-factory.ts`），不是清單長什麼樣。
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { manifest as tokenMeterManifest, tokenMeterUnit } from '@nexus/plugin-token-meter';
import { effectiveReload } from '@nexus/sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { createCliAgent } from './assembly-root.js';
import { toAgentInvocation } from './messages.js';
import type { ScriptedChatModel } from './scripted-model.js';
import { createCordisRoot } from './cordis-root.js';
import type { CordisRoot } from './cordis-root.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { changePlugin } from './plugin-change.js';
import { isBridgeEntry, loadDefaultPlugins, loadPluginConfig } from './plugin-config.js';
import type { LoadedPluginConfig } from './plugin-config.js';
import { classOfRow } from './plugin-row-classes.js';
import { buildPluginSnapshot } from './plugin-snapshot.js';
import { auditStartupEntries } from './startup-audit.js';

const temporary: string[] = [];
const roots: CordisRoot[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await root.dispose().catch(() => {});
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-token-meter-tree-'));
  chmodSync(dir, 0o700);
  temporary.push(dir);
  return dir;
}

function write(dir: string, name: string, source: string): string {
  const path = join(dir, name);
  writeFileSync(path, source, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function newRoot(): CordisRoot {
  const root = createCordisRoot();
  roots.push(root);
  return root;
}

const warnNothing = (): void => {};

const KEY = tokenMeterUnit.key;

/** 一條 thread 的組裝：讀清單（帶樹，臨界區）→ 組 agent → 交回這條 thread 的投影單元與工具名。 */
async function openThread(root: CordisRoot, env: NodeJS.ProcessEnv) {
  const loaded = await loadDefaultPlugins({ env, warn: warnNothing }, { tree: root.tree });
  return assemble(loaded);
}

async function assemble(loaded: LoadedPluginConfig) {
  const built = await createCliAgent({ live: false }, loaded.plugins);
  return {
    loaded,
    built,
    units: built.projections.list(),
    keys: built.projections.list().map((unit) => unit.key),
    /** 打一輪讓模型綁工具，交回綁了哪些工具名。 */
    async toolNames(): Promise<string[]> {
      await built.agent.invoke(toAgentInvocation('看一下。'), {
        configurable: { thread_id: 'names' },
      });
      return (built.model as ScriptedChatModel).boundTools.map(
        (tool) => (tool as { name: string }).name,
      );
    },
  };
}

function home(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = scratch();
  return { dir, env: { [HARNESS_HOME_ENV]: dir } };
}

describe('B：出貨清單上的 token-meter 經樹進來，位置與名字不變', () => {
  it('是橋接列、樹上那一列 ACTIVE、沒有掉列；啟動稽核過；快照上是 mounted', async () => {
    const { env } = home();
    const root = newRoot();
    const loaded = await loadDefaultPlugins({ env, warn: warnNothing }, { tree: root.tree });
    const entry = loaded.plugins.find((candidate) => loaded.rows.get(candidate)?.id === KEY);
    expect(entry).toBeDefined();
    expect(entry !== undefined && isBridgeEntry(entry)).toBe(true);
    expect(entry?.plugin.name).toBe('token-meter');
    expect(loaded.dropped).toEqual([]);
    expect(loaded.rows.get(entry as never)).toEqual({
      id: KEY,
      module: '@nexus/plugin-token-meter',
    });
    expect(() => auditStartupEntries(loaded, { live: false })).not.toThrow();

    const tree = await root.tree.context();
    expect(tree.loader.resolve(`include:${KEY}`).fiber?.ctx.fiber.state).toBe(2);
    // 投影登記處與工具登記處是樹上兩列，都起來了。
    expect(tree.loader.resolve('projections').fiber?.ctx.fiber.state).toBe(2);
    expect(tree.loader.resolve('tools').fiber?.ctx.fiber.state).toBe(2);

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
    expect(snapshot.rows.find((row) => row.id === KEY)).toMatchObject({
      module: '@nexus/plugin-token-meter',
      running: { state: 'mounted' },
      saved: { state: 'mounted' },
      sync: 'same',
    });
  }, 60000);

  it('經樹進來的那一條 thread 有 token-meter 的投影，單元是同一組函式；沒有樹的呼叫端也有', async () => {
    const { env } = home();
    const root = newRoot();
    const thread = await openThread(root, env);
    expect(thread.keys).toContain(KEY);
    const unit = thread.units.find((candidate) => candidate.key === KEY);
    expect(unit?.apply).toBe(tokenMeterUnit.apply);
    expect(unit?.children).toBe(true);
    await thread.built.dispose();

    const detached = await loadPluginConfig({});
    const built = await createCliAgent({ live: false }, detached.plugins);
    expect(built.projections.list().map((candidate) => candidate.key)).toContain(KEY);
    await built.dispose();
  }, 60000);

  it('樹與沒有樹，這條 thread 的投影單元與順序一樣', async () => {
    const { env } = home();
    const root = newRoot();
    const onTree = await openThread(root, env);
    const detached = await loadPluginConfig({});
    const built = await createCliAgent({ live: false }, detached.plugins);
    expect(onTree.keys).toEqual(built.projections.list().map((unit) => unit.key));
    await onTree.built.dispose();
    await built.dispose();
  }, 60000);
});

describe('C：寫入口停用 token-meter', () => {
  it('寫入之後立刻開的 thread 沒有它的投影；開著的那條照舊有、單元照舊折得動；再啟用也一樣', async () => {
    const { env } = home();
    const root = newRoot();
    const first = await openThread(root, env);
    expect(first.keys).toContain(KEY);

    await changePlugin({ op: 'disable', id: KEY }, { env });
    // 寫入之後**立刻**開的 thread 就看到新值：不靠等待時間的運氣。
    const second = await openThread(root, env);
    expect(second.keys).not.toContain(KEY);
    const tree = await root.tree.context();
    expect(tree.loader.resolve(`include:${KEY}`).fiber?.ctx.fiber.state).toBe(4);

    // 開著的那條：單元是純函式的折疊，樹上那一列卸了之後照樣折得動（決議 §3-2 第 6 條）。
    expect(first.keys).toContain(KEY);
    const unit = first.units.find((candidate) => candidate.key === KEY);
    expect(unit).toBeDefined();
    let state = unit?.init();
    state = unit?.apply(state, {
      seq: 0,
      time: 1,
      type: 'turn/start',
      data: { kind: 'message', text: 'hi' },
    } as never);
    state = unit?.apply(state, { seq: 1, time: 2, type: 'turn/end', data: {} } as never);
    expect(JSON.parse(JSON.stringify(unit?.view(state)))).toMatchObject({
      turns: expect.any(Array),
    });

    await changePlugin({ op: 'enable', id: KEY }, { env });
    const third = await openThread(root, env);
    expect(third.keys).toContain(KEY);
    for (const thread of [first, second, third]) await thread.built.dispose();
  }, 60000);
});

describe('I：reload 分類', () => {
  it('manifest 宣告的 reload 不比宿主的分類寬；快照上是「下一條 thread」那一類', async () => {
    const host = {
      config: classOfRow(KEY, KEY) === 'startup-read' ? 'restart' : 'next-thread',
    } as const;
    expect(effectiveReload(tokenMeterManifest.reload, host)).toEqual({
      code: 'restart',
      config: 'next-thread',
    });
    expect(effectiveReload(tokenMeterManifest.reload, host).config).toBe('next-thread');

    const { env } = home();
    const running = await loadDefaultPlugins({ env, warn: warnNothing }, { tree: newRoot().tree });
    await changePlugin({ op: 'disable', id: KEY }, { env });
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
    expect(snapshot.rows.find((row) => row.id === KEY)).toMatchObject({
      running: { state: 'mounted' },
      saved: { state: 'disabled' },
      sync: 'next-thread',
    });
  }, 60000);
});

/**
 * 兩個函式插件模組放暫存目錄：**不 import 任何套件**，`zod` 與 `@langchain/core` 用絕對檔案 URL。裸 specifier 錨在
 * 做 import 的那個模組的位置，暫存目錄解析不到它們。
 */
const ZOD_URL = import.meta.resolve('zod');
const TOOLS_URL = import.meta.resolve('@langchain/core/tools');

interface Contribution {
  readonly id: string;
  /** 登記的投影單元：key 與版本。 */
  readonly projections?: readonly { key: string; version: number }[];
  /** 登記的工具名。 */
  readonly tools?: readonly string[];
}

function contributor(options: Contribution): string {
  const units = (options.projections ?? [])
    .map(
      ({ key, version }) =>
        `  ctx.projections.register({ key: ${JSON.stringify(key)}, stateVersion: ${String(version)}, ` +
        `init: () => 0, apply: (state) => state, view: (state) => ({ from: ${JSON.stringify(options.id)}, state }) });`,
    )
    .join('\n');
  const tools = (options.tools ?? [])
    .map(
      (name) =>
        `  ctx.tools.register(tool(() => 'ok', { name: ${JSON.stringify(name)}, description: '測試用', schema: z.object({}) }));`,
    )
    .join('\n');
  return `import { z } from ${JSON.stringify(ZOD_URL)};
import { tool } from ${JSON.stringify(TOOLS_URL)};
export const name = ${JSON.stringify(options.id)};
export const inject = { projections: { range: '^1.0.0' }, tools: { range: '^1.0.0' } };
export const Config = z.strictObject({});
export const manifest = {
  id: ${JSON.stringify(options.id)}, version: '1.0.0', owner: 't',
  provides: [], consumes: [{ token: 'projections', range: '^1.0.0' }, { token: 'tools', range: '^1.0.0' }],
  config: Config, reload: { code: 'restart', config: 'next-thread' }, capabilities: [],
};
export function apply(ctx) {
${units}
${tools}
}
`;
}

/**
 * 一份 `--patch` 覆蓋層：先 `insert` 這幾列（接在出貨清單後面，所以出貨的 token-meter 先登記），再接 `extra`
 * （例如停用某一列）。出貨清單照舊，模型提供者等其餘的列都在。
 */
function overlayOf(
  dir: string,
  inserts: readonly (readonly [string, string])[],
  extra = '',
  name = 'overlay.yml',
): string {
  const rows = inserts.map(([id, module]) => `    - id: ${id}\n      name: '${module}'\n`).join('');
  return write(dir, name, `- insert:\n${rows}${extra}`);
}

function modulePath(dir: string, options: Contribution): string {
  return `file://${write(dir, `${options.id}.mjs`, contributor(options))}`;
}

async function openWith(root: CordisRoot, dir: string, overlay: string) {
  const loaded = await loadDefaultPlugins(
    { env: { [HARNESS_HOME_ENV]: dir }, patches: [overlay], warn: warnNothing },
    { tree: root.tree },
  );
  return assemble(loaded);
}

describe('E：同一個 key 由兩列登記（provider 這一層照 dsh 共用）', () => {
  const VERSION = tokenMeterUnit.stateVersion;

  it('同 key 同 stateVersion：兩列都 ACTIVE，這條 thread 只拿到一份，是先登記的那一列的定義', async () => {
    const dir = scratch();
    const twin = modulePath(dir, { id: 'twin', projections: [{ key: KEY, version: VERSION }] });
    const root = newRoot();
    const thread = await openWith(root, dir, overlayOf(dir, [['twin', twin]]));
    expect(thread.loaded.dropped).toEqual([]);
    const tree = await root.tree.context();
    expect(tree.loader.resolve(`include:${KEY}`).fiber?.ctx.fiber.state).toBe(2);
    expect(tree.loader.resolve('include:twin').fiber?.ctx.fiber.state).toBe(2);
    expect(thread.keys.filter((key) => key === KEY)).toHaveLength(1);
    expect(thread.units.find((unit) => unit.key === KEY)?.apply).toBe(tokenMeterUnit.apply);
    await thread.built.dispose();
  }, 60000);

  it('停掉共用的其中一列：下一條 thread 照舊有這個 key；兩列都停：沒有', async () => {
    const dir = scratch();
    const twin = modulePath(dir, { id: 'twin', projections: [{ key: KEY, version: VERSION }] });
    const root = newRoot();
    const open = (extra: string, name: string) =>
      openWith(root, dir, overlayOf(dir, [['twin', twin]], extra, name));
    const both = await open('', 'both.yml');
    expect(both.keys).toContain(KEY);
    // 停掉先登記的那一列：key 還在，由留下的那一列（twin）折進來；引用計數沒歸零，單元照舊是第一個登記者的定義（dsh）。
    const firstOff = await open(`- id: ${KEY}\n  disabled: true\n`, 'first-off.yml');
    expect(firstOff.keys.filter((key) => key === KEY)).toHaveLength(1);
    expect(firstOff.units.find((unit) => unit.key === KEY)?.apply).toBe(tokenMeterUnit.apply);
    // 停掉後登記的那一列：key 還在，是先登記的那一列的定義。
    const secondOff = await open('- id: twin\n  disabled: true\n', 'second-off.yml');
    expect(secondOff.units.find((unit) => unit.key === KEY)?.apply).toBe(tokenMeterUnit.apply);
    // 兩列都停掉：沒有這個 key。
    const bothOff = await open(
      `- id: ${KEY}\n  disabled: true\n- id: twin\n  disabled: true\n`,
      'both-off.yml',
    );
    expect(bothOff.keys).not.toContain(KEY);
    for (const thread of [both, firstOff, secondOff, bothOff]) await thread.built.dispose();
  }, 60000);

  it('stateVersion 不同：後到的那列被拒絕，錯誤指名 key、兩個版本與兩邊的來源，掉列進啟動結算；先到的照舊在', async () => {
    const dir = scratch();
    const clash = modulePath(dir, {
      id: 'clash',
      projections: [{ key: KEY, version: VERSION + 1 }],
    });
    const root = newRoot();
    const thread = await openWith(root, dir, overlayOf(dir, [['clash', clash]]));
    const drop = thread.loaded.dropped.find((candidate) => candidate.id === 'clash');
    expect(drop?.stage).toBe('apply');
    expect(drop?.message).toContain(KEY);
    expect(drop?.message).toContain(`stateVersion ${String(VERSION)}`);
    expect(drop?.message).toContain(`stateVersion ${String(VERSION + 1)}`);
    expect(drop?.message).toContain(`include:${KEY}`);
    expect(drop?.message).toContain('include:clash');
    expect(thread.loaded.dropped.find((candidate) => candidate.id === KEY)).toBeUndefined();
    expect(thread.keys.filter((key) => key === KEY)).toHaveLength(1);
    expect(thread.units.find((unit) => unit.key === KEY)?.apply).toBe(tokenMeterUnit.apply);
    await thread.built.dispose();
  }, 60000);
});

describe('F：一列同時貢獻工具與投影', () => {
  it('橋接列兩種都折入，而且都只折來源是那一列的', async () => {
    const dir = scratch();
    const alpha = modulePath(dir, {
      id: 'alpha',
      tools: ['alpha_tool'],
      projections: [{ key: 'alpha-view', version: 1 }],
    });
    const beta = modulePath(dir, {
      id: 'beta',
      tools: ['beta_tool'],
      projections: [{ key: 'beta-view', version: 1 }],
    });
    const inserts = [
      ['alpha', alpha],
      ['beta', beta],
    ] as const;
    const root = newRoot();
    const thread = await openWith(root, dir, overlayOf(dir, inserts, '', 'both.yml'));
    expect(thread.loaded.dropped).toEqual([]);
    expect(thread.keys.filter((key) => key.endsWith('-view'))).toEqual(['alpha-view', 'beta-view']);
    const names = new Set(await thread.toolNames());
    expect(names.has('alpha_tool')).toBe(true);
    expect(names.has('beta_tool')).toBe(true);
    await thread.built.dispose();

    // 停掉 alpha：它的工具與投影都不在了，beta 的照舊。
    const second = await openWith(
      root,
      dir,
      overlayOf(dir, inserts, '- id: alpha\n  disabled: true\n', 'alpha-off.yml'),
    );
    expect(second.keys.filter((key) => key.endsWith('-view'))).toEqual(['beta-view']);
    const remaining = new Set(await second.toolNames());
    expect(remaining.has('alpha_tool')).toBe(false);
    expect(remaining.has('beta_tool')).toBe(true);
    await second.built.dispose();
  }, 60000);
});
