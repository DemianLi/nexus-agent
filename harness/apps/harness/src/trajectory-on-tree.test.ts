/**
 * trajectory 在 Cordis 樹上，沿用投影接縫（[#1435](https://github.com/DemianLi/nexus-agent/issues/1435)）：驗收 B、C、D、F。
 * 量的是產品路徑——真的 `createCordisRoot`、真的 `loadDefaultPlugins`／`loadPluginConfig`（帶樹）、真的寫入口 `changePlugin`、
 * 真的 `createCliAgent`；不手搭 `ctx.plugin`，也不走舊外殼（`trajectory.fixture.ts`）。
 *
 * 「這一條 thread 有沒有這個投影」看的是組出來的 agent 的 `projections.list()`（宿主把它交給 wire 的投影通道，
 * `agent-factory.ts`），不是清單長什麼樣。接線的紅燈在這裡，不在三支走舊外殼的 wire 測試：外殼自己登記兩個單元，
 * `apply` 少登記一個，那三支不會紅。
 */

import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionLog } from '@nexus/core';
import {
  manifest as trajectoryManifest,
  requestSnapshotsUnit,
  trajectoryUnit,
} from '@nexus/plugin-trajectory';
import { effectiveReload } from '@nexus/sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { createCliAgent } from './assembly-root.js';
import { createCordisRoot } from './cordis-root.js';
import type { CordisRoot } from './cordis-root.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { changePlugin } from './plugin-change.js';
import { isBridgeEntry, loadDefaultPlugins, loadPluginConfig } from './plugin-config.js';
import type { LoadedPluginConfig } from './plugin-config.js';
import { classOfRow } from './plugin-row-classes.js';
import { buildPluginSnapshot } from './plugin-snapshot.js';
import { auditStartupEntries } from './startup-audit.js';
import { createTrajectoryPlugin } from './trajectory.fixture.js';

const temporary: string[] = [];
const roots: CordisRoot[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await root.dispose().catch(() => {});
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function newRoot(): CordisRoot {
  const root = createCordisRoot();
  roots.push(root);
  return root;
}

function home(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-trajectory-tree-'));
  chmodSync(dir, 0o700);
  temporary.push(dir);
  return { dir, env: { [HARNESS_HOME_ENV]: dir } };
}

const warnNothing = (): void => {};

const ROW = 'trajectory';
const KEYS = [trajectoryUnit.key, requestSnapshotsUnit.key];

/** 一條 thread 的組裝：讀清單（帶樹，臨界區）→ 組 agent → 交回這條 thread 的投影單元。 */
async function openThread(root: CordisRoot, env: NodeJS.ProcessEnv) {
  const loaded = await loadDefaultPlugins({ env, warn: warnNothing }, { tree: root.tree });
  const built = await createCliAgent({ live: false }, loaded.plugins);
  return { loaded, built, units: built.projections.list() };
}

/** 一段日誌：一輪 message，帶一次模型呼叫。 */
function sampleLog(): SessionLog {
  const log = new SessionLog('sample');
  log.append('turn/start', { kind: 'message', text: '看一下' });
  log.append('model/start', {});
  log.append('turn/end', {});
  return log;
}

function foldView(
  unit: { init(): unknown; apply(s: never, e: never): unknown; view(s: never): unknown },
  log: SessionLog,
) {
  let state = unit.init();
  for (const event of log.events) state = unit.apply(state as never, event as never);
  return JSON.stringify(unit.view(state as never));
}

describe('B：出貨清單上的 trajectory 經樹進來，位置與名字不變', () => {
  it('是橋接列、樹上那一列 ACTIVE、沒有掉列；啟動稽核過；快照上是 mounted', async () => {
    const { env } = home();
    const root = newRoot();
    const loaded = await loadDefaultPlugins({ env, warn: warnNothing }, { tree: root.tree });
    const entry = loaded.plugins.find((candidate) => loaded.rows.get(candidate)?.id === ROW);
    expect(entry).toBeDefined();
    expect(entry !== undefined && isBridgeEntry(entry)).toBe(true);
    expect(entry?.plugin.name).toBe('trajectory');
    expect(loaded.dropped).toEqual([]);
    expect(loaded.rows.get(entry as never)).toEqual({
      id: ROW,
      module: '@nexus/plugin-trajectory',
    });
    expect(() => auditStartupEntries(loaded, { live: false })).not.toThrow();

    const tree = await root.tree.context();
    expect(tree.loader.resolve(`include:${ROW}`).fiber?.ctx.fiber.state).toBe(2);

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
    expect(snapshot.rows.find((row) => row.id === ROW)).toMatchObject({
      module: '@nexus/plugin-trajectory',
      running: { state: 'mounted' },
      saved: { state: 'mounted' },
      sync: 'same',
    });
  }, 60000);

  it('經樹進來的那一條 thread 有兩份投影（軌跡、請求快照），都宣告 children，單元是同一組函式', async () => {
    const { env } = home();
    const root = newRoot();
    const thread = await openThread(root, env);
    for (const key of KEYS) expect(thread.units.map((unit) => unit.key)).toContain(key);
    const trajectory = thread.units.find((unit) => unit.key === trajectoryUnit.key);
    const snapshots = thread.units.find((unit) => unit.key === requestSnapshotsUnit.key);
    // 驗收 F：單元只有一個出處——外殼與樹上那一列登記的是同一組函式。
    expect(trajectory?.apply).toBe(trajectoryUnit.apply);
    expect(snapshots?.apply).toBe(requestSnapshotsUnit.apply);
    expect(trajectory?.children).toBe(true);
    expect(snapshots?.children).toBe(true);
    await thread.built.dispose();
  }, 60000);

  it('驗收 C：樹與沒有樹，這條 thread 的投影單元與順序一樣；折同一段日誌，兩份 view 逐位元組相同', async () => {
    const { env } = home();
    const root = newRoot();
    const onTree = await openThread(root, env);
    const detached = await loadPluginConfig({});
    const built = await createCliAgent({ live: false }, detached.plugins);
    const detachedUnits = built.projections.list();
    expect(onTree.units.map((unit) => unit.key)).toEqual(detachedUnits.map((unit) => unit.key));
    const log = sampleLog();
    for (const key of KEYS) {
      const left = onTree.units.find((unit) => unit.key === key);
      const right = detachedUnits.find((unit) => unit.key === key);
      expect(left).toBeDefined();
      expect(foldView(left as never, log)).toBe(foldView(right as never, log));
    }
    // 舊外殼（測試夾具）登記的也是同一組。
    const shell = createTrajectoryPlugin();
    expect(shell.plugin.name).toBe('trajectory');
    await onTree.built.dispose();
    await built.dispose();
  }, 60000);
});

describe('D：寫入口停用 trajectory', () => {
  it('寫入之後立刻開的 thread 沒有兩份投影；開著的那條照舊有、單元照舊折得動；再啟用也一樣', async () => {
    const { env } = home();
    const root = newRoot();
    const first = await openThread(root, env);
    for (const key of KEYS) expect(first.units.map((unit) => unit.key)).toContain(key);

    await changePlugin({ op: 'disable', id: ROW }, { env });
    const second = await openThread(root, env);
    for (const key of KEYS) expect(second.units.map((unit) => unit.key)).not.toContain(key);
    const tree = await root.tree.context();
    expect(tree.loader.resolve(`include:${ROW}`).fiber?.ctx.fiber.state).toBe(4);

    // 開著的那條：單元是純函式的折疊，樹上那一列卸了之後照樣折得動（決議 §3-2 第 6 條）。
    const unit = first.units.find((candidate) => candidate.key === trajectoryUnit.key);
    expect(unit).toBeDefined();
    expect(JSON.parse(foldView(unit as never, sampleLog()))).toMatchObject({
      turns: expect.any(Array),
    });

    await changePlugin({ op: 'enable', id: ROW }, { env });
    const third = await openThread(root, env);
    for (const key of KEYS) expect(third.units.map((candidate) => candidate.key)).toContain(key);
    for (const thread of [first, second, third]) await thread.built.dispose();
  }, 60000);
});

describe('reload 分類', () => {
  it('manifest 宣告的 reload 不比宿主的分類寬；快照上是「下一條 thread」那一類', async () => {
    const host = {
      config: classOfRow(ROW, ROW) === 'startup-read' ? 'restart' : 'next-thread',
    } as const;
    expect(effectiveReload(trajectoryManifest.reload, host)).toEqual({
      code: 'restart',
      config: 'next-thread',
    });

    const { env } = home();
    const running = await loadDefaultPlugins({ env, warn: warnNothing }, { tree: newRoot().tree });
    await changePlugin({ op: 'disable', id: ROW }, { env });
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
    expect(snapshot.rows.find((row) => row.id === ROW)).toMatchObject({
      running: { state: 'mounted' },
      saved: { state: 'disabled' },
      sync: 'next-thread',
    });
  }, 60000);
});
