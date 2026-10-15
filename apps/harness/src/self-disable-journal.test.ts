/**
 * 插件自己停用了自己，寫進變更紀錄、止住閃動（[#1424](https://github.com/DemianLi/nexus-agent/issues/1424)，Part of #1385）。
 *
 * 決議（demian 2026-10-14）：Q1 (b)——只在行程裡停著，紀錄記一筆只記不折的 `self-disabled`；Q2 (a)——actor 沿用 `serve`。
 *
 * | 驗收 | 在哪 |
 * | --- | --- |
 * | A 止住閃動、B 記一筆、F 不產生 `failed`／快照判成 `disabled` | serve：「自我停用只記一筆、只掛一次」 |
 * | C 宣告改了才重試、改別的列不會 | serve：「宣告改了才重試」 |
 * | D 重啟就回來 | serve：「重啟之後那一列重新試一次」 |
 * | E 關機與重建不誤寫 | serve 關機＋樹：「拆卸與重建」（含**切換出貨路徑**——Include restart，`UNLOADING` 條件是承重的） |
 * | G 沒有紀錄檔 | serve：「沒有紀錄檔」 |
 * | H 只有插件自己 `ctx.fiber.dispose()` 才交給宿主 | 樹：「只有自己停用才有事件」＋serve：寫入口的 `disable` |
 *
 * 量具：一顆**遷出的函式插件**（有 `manifest` 匯出），`apply` 裡數一次、`ctx.fiber.dispose()`。出貨清單上沒有任何插件
 * 會這樣做，所以只能用夾具。
 */

import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FIBER_STATE } from '@nexus/sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { createCordisRoot } from './cordis-root.js';
import type { CordisRoot } from './cordis-root.js';
import { foldTurn, serveClient } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { changePlugin } from './plugin-change.js';
import type { PluginChange } from './plugin-change.js';
import { loadPluginConfig } from './plugin-config.js';
import { journalPathOf, seedHomePatch } from './plugin-journal.fixture.js';
import { readJournal } from './plugin-journal.js';
import type { JournalRecord } from './plugin-journal.js';
import { pluginSnapshotPath } from './plugin-snapshot.js';
import type { PluginSnapshot } from './plugin-snapshot.js';
import type { SelfDisableEvent } from './plugin-tree.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

const temporary: string[] = [];
const roots: CordisRoot[] = [];
let running: RunningServe | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
  for (const root of roots.splice(0)) await root.dispose().catch(() => undefined);
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ECHO_MODULE = import.meta.resolve('@nexus/plugin-echo');

/** 一顆函式插件：`Config` 收一個可選的數字 `n`（讓宣告可以改），`apply` 的本體由呼叫端給。 */
function functionPlugin(id: string, apply: string): string {
  return `import { z } from 'zod';
export const name = ${JSON.stringify(id)};
export const inject = { tools: { range: '^1.0.0' } };
export const Config = z.strictObject({ n: z.number().optional() });
export const manifest = {
  id: ${JSON.stringify(id)}, version: '1.0.0', owner: 't',
  provides: [], consumes: [{ token: 'tools', range: '^1.0.0' }],
  config: Config, reload: { code: 'restart', config: 'next-thread' }, capabilities: [],
};
export function apply(ctx, config) { ${apply} }
`;
}

interface Home {
  readonly env: NodeJS.ProcessEnv;
  readonly dir: string;
  readonly module: string;
  /** `apply` 跑過幾次。 */
  applied(): number;
  change(change: PluginChange): Promise<number | undefined>;
}

let counterSeed = 0;

/** 一個 harness home，裡面有一顆自己停用自己的函式插件（`quitter`），可選地寫進紀錄當成 `insert` 的列。 */
function home(options: { readonly seedInsert?: boolean; readonly apply?: string } = {}): Home {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-self-disable-'));
  temporary.push(dir);
  chmodSync(dir, 0o700);
  counterSeed += 1;
  const counter = `__selfDisable1424_${String(Date.now())}_${String(counterSeed)}`;
  const module = join(dir, 'quitter.mjs');
  writeFileSync(
    module,
    functionPlugin(
      'quitter',
      options.apply ??
        `globalThis[${JSON.stringify(counter)}] = (globalThis[${JSON.stringify(counter)}] ?? 0) + 1; ctx.fiber.dispose()`,
    ),
    { mode: 0o600 },
  );
  chmodSync(module, 0o600);
  const env = { [HARNESS_HOME_ENV]: dir };
  if (options.seedInsert !== false) {
    seedHomePatch(dir, `- insert:\n    - id: quitter\n      name: 'file://${module}'\n`);
  }
  return {
    env,
    dir,
    module,
    applied: () => ((globalThis as Record<string, unknown>)[counter] as number | undefined) ?? 0,
    change: async (change) => (await changePlugin(change, { env })).record?.seq,
  };
}

async function start(
  env: NodeJS.ProcessEnv,
  lines: string[] = [],
  extra: string[] = [],
): Promise<RunningServe> {
  const server = (await runServe({
    argv: ['--port', '0', ...extra],
    log: (line) => lines.push(line),
    env,
  })) as RunningServe;
  running = server;
  return server;
}

async function say(server: RunningServe, thread: string): Promise<string | undefined> {
  const client = await serveClient(server);
  const events = await client.openEvents(thread).catch((error: unknown) => error as Error);
  if (events instanceof Error) return events.message;
  try {
    const started = await client.runStart(thread, '說點什麼');
    if (started.type === 'error') return started.message;
    await foldTurn(events);
    return undefined;
  } finally {
    await events.return?.(undefined);
  }
}

async function stop(): Promise<void> {
  await running?.close();
  running = undefined;
}

type SelfDisabled = Extract<JournalRecord, { op: 'self-disabled' }>;

function recordsOf(dir: string): JournalRecord[] {
  return [...(readJournal(journalPathOf(dir))?.records ?? [])];
}

function selfDisabledOf(dir: string): SelfDisabled[] {
  return recordsOf(dir).filter((entry): entry is SelfDisabled => entry.op === 'self-disabled');
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`等不到：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('自我停用只記一筆、只掛一次（驗收 A、B、F）', () => {
  it('開三條 thread：apply 只跑一次；紀錄多一筆 self-disabled（id、name、actor serve），沒有 failed；快照判成 disabled', async () => {
    const h = home();
    const lines: string[] = [];
    const server = await start(h.env, lines);
    // 啟動那一刻樹上掛了一次，插件自己停用。
    expect(h.applied()).toBe(1);
    for (const thread of ['a', 'b', 'c']) expect(await say(server, thread)).toBeUndefined();
    // 以前：每條 thread 重掛一次（#1416 PR 2 的已知限制）。
    expect(h.applied()).toBe(1);

    await waitFor(() => selfDisabledOf(h.dir).length === 1, '那一筆 self-disabled');
    // 再開幾條也不會多記。
    expect(await say(server, 'd')).toBeUndefined();
    const records = selfDisabledOf(h.dir);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      op: 'self-disabled',
      seq: 2,
      id: 'quitter',
      name: `file://${h.module}`,
      actor: { kind: 'serve' },
    });
    // 驗收 F：它在紀錄裡有一筆被接受的改動（seq 1 的 insert），自己停用不是「掛不上」，所以沒有 `failed`。
    expect(recordsOf(h.dir).filter((entry) => entry.op === 'failed')).toEqual([]);
    expect(lines.some((line) => line.includes('quitter') && line.includes('這一列沒掛上'))).toBe(
      false,
    );

    // 快照照現有四種狀態：`disabled`，不是 `dropped`。
    const snapshot = JSON.parse(readFileSync(pluginSnapshotPath(h.env), 'utf8')) as PluginSnapshot;
    const row = snapshot.rows.find((entry) => entry.id === 'quitter');
    expect(row?.running.state).toBe('disabled');
    expect(row?.saved.state).toBe('disabled');
  }, 120000);
});

describe('宣告改了才重試（驗收 C）', () => {
  it('改它自己的設定：下一條 thread 重掛、又停用，再記一筆；改別的列不會讓它重試', async () => {
    const h = home();
    const server = await start(h.env);
    expect(await say(server, 'warm')).toBeUndefined();
    expect(h.applied()).toBe(1);
    await waitFor(() => selfDisabledOf(h.dir).length === 1, '第一筆');

    // 改**樹上別的列**（echo 是樹上的函式插件列，skills 不是）：Include 把整棵樹重疊、每一列的 options 整份換掉，
    // 但它的宣告沒變，宿主替它推著 `disabled`，不重掛（#1424 補件）。
    expect(
      await h.change({ op: 'config-set', id: 'echo', config: { prefix: 'other' } }),
    ).toBeGreaterThan(1);
    expect(await say(server, 'other-row')).toBeUndefined();
    expect(h.applied()).toBe(1);
    expect(selfDisabledOf(h.dir)).toHaveLength(1);

    // 改它自己的設定：宣告變了，重試一次。
    await h.change({ op: 'config-set', id: 'quitter', config: { n: 1 } });
    expect(await say(server, 'own-row')).toBeUndefined();
    expect(h.applied()).toBe(2);
    await waitFor(() => selfDisabledOf(h.dir).length === 2, '第二筆');
    // 重試完又穩住了：再開不會再掛。
    expect(await say(server, 'after-retry')).toBeUndefined();
    expect(h.applied()).toBe(2);
    expect(selfDisabledOf(h.dir)).toHaveLength(2);
  }, 120000);
});

describe('重啟之後那一列重新試一次（驗收 D）', () => {
  it('重啟：apply 又跑一次、又自己停用，記一筆新的', async () => {
    const h = home();
    const first = await start(h.env);
    expect(await say(first, 'a')).toBeUndefined();
    await waitFor(() => selfDisabledOf(h.dir).length === 1, '第一筆');
    await stop();

    const second = await start(h.env);
    expect(h.applied()).toBe(2);
    expect(await say(second, 'b')).toBeUndefined();
    await waitFor(() => selfDisabledOf(h.dir).length === 2, '重啟後的那一筆');
    expect(h.applied()).toBe(2);
  }, 120000);
});

describe('關機不誤寫（驗收 E）', () => {
  it('serve 正常關機：紀錄逐位元組不變', async () => {
    const h = home({ seedInsert: true });
    const server = await start(h.env);
    expect(await say(server, 'a')).toBeUndefined();
    await waitFor(() => selfDisabledOf(h.dir).length === 1, '那一筆');
    // 別的列：出貨的列都是正常掛著的，關機時它們的 fiber 一起卸載，不能被當成自我停用。
    await new Promise((resolve) => setTimeout(resolve, 300));
    const before = readFileSync(journalPathOf(h.dir));
    await stop();
    expect(readFileSync(journalPathOf(h.dir)).equals(before)).toBe(true);
  }, 120000);
});

describe('沒有紀錄檔（驗收 G）', () => {
  it('閃動照樣止住：記憶體那一頭不靠紀錄', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-self-disable-nojournal-'));
    temporary.push(dir);
    chmodSync(dir, 0o700);
    const counter = `__selfDisableG_${String(Date.now())}`;
    const module = join(dir, 'quitter.mjs');
    writeFileSync(
      module,
      functionPlugin(
        'quitter',
        `globalThis[${JSON.stringify(counter)}] = (globalThis[${JSON.stringify(counter)}] ?? 0) + 1; ctx.fiber.dispose()`,
      ),
      { mode: 0o600 },
    );
    chmodSync(module, 0o600);
    const shipped = join(dir, 'cordis.yml');
    writeFileSync(shipped, `- id: quitter\n  name: 'file://${module}'\n`, { mode: 0o600 });
    const root = createCordisRoot();
    roots.push(root);
    // 沒有掛接收者（CLI 與沒有紀錄的場面）：事件沒人收，閃動照樣止住。
    for (let read = 0; read < 4; read += 1) {
      const loaded = await loadPluginConfig(
        { shipped, warn: () => undefined },
        { tree: root.tree },
      );
      // 判成 off、標成停用，不是 dropped（不會因為自己停用就被當成掛不上）。
      expect(loaded.dropped).toEqual([]);
      expect(loaded.plugins.map((plugin) => plugin.disabled)).toEqual([true]);
    }
    expect((globalThis as Record<string, unknown>)[counter]).toBe(1);
    expect(readdirSync(dir).sort()).toEqual(['cordis.yml', 'quitter.mjs']);
  }, 60000);
});

describe('只有自己停用才有事件（驗收 H）', () => {
  async function treeFor(
    dir: string,
    rows: string,
  ): Promise<{ root: CordisRoot; shipped: string }> {
    const shipped = join(dir, 'cordis.yml');
    writeFileSync(shipped, rows, { mode: 0o600 });
    chmodSync(shipped, 0o600);
    const root = createCordisRoot();
    roots.push(root);
    return { root, shipped };
  }

  it('寫入口的 disable（樹上的 echo）：不產生 self-disabled；紀錄與快照的存檔那一側都是 disabled', async () => {
    // 出貨清單上的 echo 是樹上的函式插件列：寫入口停用它走的是 Loader 的 `entry.update`，不是插件自己 `ctx.fiber.dispose()` 那一格。
    const h = home({ seedInsert: false });
    const server = await start(h.env);
    expect(await say(server, 'a')).toBeUndefined();
    const stateOf = (side: 'running' | 'saved'): string | undefined => {
      const snapshot = JSON.parse(
        readFileSync(pluginSnapshotPath(h.env), 'utf8'),
      ) as PluginSnapshot;
      return snapshot.rows.find((entry) => entry.id === 'echo')?.[side].state;
    };
    expect(stateOf('saved')).toBe('mounted');
    await h.change({ op: 'disable', id: 'echo' });
    expect(await say(server, 'b')).toBeUndefined();
    // 動作真的生效：存檔那一側是 disabled（running 是啟動時試組的結果，重啟才換——快照語意）。
    expect(stateOf('saved')).toBe('disabled');
    expect(stateOf('running')).toBe('mounted');
    await stop();
    expect(selfDisabledOf(h.dir)).toEqual([]);
  }, 120000);

  it('清單把樹上的 echo 停用：樹上那一列真的卸載，沒有 self-disable 事件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-self-disable-listoff-'));
    temporary.push(dir);
    chmodSync(dir, 0o700);
    const { root, shipped } = await treeFor(dir, `- id: echo\n  name: '${ECHO_MODULE}'\n`);
    const events: SelfDisableEvent[] = [];
    root.tree.onSelfDisable = (event) => void events.push(event);
    const stateOfEcho = async (): Promise<number | undefined> => {
      const context = await root.tree.context();
      return context.loader.resolve('include:echo').fiber?.ctx.fiber.state;
    };
    await loadPluginConfig({ shipped, warn: () => undefined }, { tree: root.tree });
    expect(await stateOfEcho()).toBe(FIBER_STATE.ACTIVE);
    const overlay = join(dir, 'off.yml');
    writeFileSync(overlay, '- id: echo\n  disabled: true\n', { mode: 0o600 });
    chmodSync(overlay, 0o600);
    const loaded = await loadPluginConfig(
      { shipped, overlays: [overlay], warn: () => undefined },
      { tree: root.tree },
    );
    expect(loaded.plugins.find((plugin) => plugin.id === 'echo')?.disabled).toBe(true);
    // 動作真的生效：樹上那一列不再是 ACTIVE。
    expect(await stateOfEcho()).not.toBe(FIBER_STATE.ACTIVE);
    expect(events).toEqual([]);
  }, 120000);

  it('插件呼叫 ctx.fiber.update()（走 internal/commit）：沒有事件；真的自己停用才有', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-self-disable-tree-'));
    temporary.push(dir);
    chmodSync(dir, 0o700);
    const updater = join(dir, 'updater.mjs');
    const seenConfigs = `__selfDisableUpdater_${String(Date.now())}`;
    writeFileSync(
      updater,
      functionPlugin(
        'updater',
        `(globalThis[${JSON.stringify(seenConfigs)}] ??= []).push(config?.n ?? null); if (config?.n !== 2) ctx.fiber.update({ n: 2 })`,
      ),
      { mode: 0o600 },
    );
    chmodSync(updater, 0o600);
    const quitter = join(dir, 'quitter.mjs');
    writeFileSync(quitter, functionPlugin('quitter', 'ctx.fiber.dispose()'), { mode: 0o600 });
    chmodSync(quitter, 0o600);
    const { root, shipped } = await treeFor(
      dir,
      `- id: updater\n  name: 'file://${updater}'\n- id: echo\n  name: '${ECHO_MODULE}'\n`,
    );
    const events: SelfDisableEvent[] = [];
    root.tree.onSelfDisable = (event) => void events.push(event);
    await loadPluginConfig({ shipped, warn: () => undefined }, { tree: root.tree });
    // `updater` 改了自己的設定、echo 照常掛著：都不是自我停用。
    expect(events).toEqual([]);
    // 動作真的發生了：apply 跑了兩次，第二次拿到的是 update 給的設定（update 哪天變成 no-op，這條會紅）。
    expect((globalThis as Record<string, unknown>)[seenConfigs]).toEqual([null, 2]);

    // 對照：同一棵樹上換成會自己停用的那顆，事件才出現。
    const second = await treeFor(
      dir,
      `- id: quitter\n  name: 'file://${quitter}'\n- id: echo\n  name: '${ECHO_MODULE}'\n`,
    );
    const seen: SelfDisableEvent[] = [];
    second.root.tree.onSelfDisable = (event) => void seen.push(event);
    await loadPluginConfig(
      { shipped: second.shipped, warn: () => undefined },
      { tree: second.root.tree },
    );
    expect(seen).toEqual([{ id: 'quitter', module: `file://${quitter}` }]);
  }, 120000);
});

describe('拆卸與重建不誤認成自我停用（驗收 E）', () => {
  /** 兩份出貨清單，echo 一列：切換路徑讓 Include 走 restart（`config.path` 變了，`vendor/include/src/index.ts` 的 `internal/update`）。 */
  it('切換出貨路徑（Include restart，uid 保留、狀態 UNLOADING）：正常掛著的列沒有事件、不寫紀錄、仍然 ACTIVE', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-self-disable-switch-'));
    temporary.push(dir);
    chmodSync(dir, 0o700);
    const write = (name: string): string => {
      const path = join(dir, name);
      writeFileSync(path, `- id: echo\n  name: '${ECHO_MODULE}'\n`, { mode: 0o600 });
      chmodSync(path, 0o600);
      return path;
    };
    const first = write('first.yml');
    const second = write('second.yml');
    const root = createCordisRoot();
    roots.push(root);
    const events: SelfDisableEvent[] = [];
    root.tree.onSelfDisable = (event) => void events.push(event);
    const loadedFirst = await loadPluginConfig(
      { shipped: first, warn: () => undefined },
      { tree: root.tree },
    );
    expect(loadedFirst.dropped).toEqual([]);
    const loadedSecond = await loadPluginConfig(
      { shipped: second, warn: () => undefined },
      { tree: root.tree },
    );
    // 路徑換了、Include 整列重起：子列在卸載的路上被 Loader 當成「自己停用」的候選，只有 UNLOADING 條件擋得住它。
    expect(events).toEqual([]);
    expect(loadedSecond.dropped).toEqual([]);
    expect(loadedSecond.plugins.map((plugin) => plugin.disabled)).not.toContain(true);
  }, 120000);

  it('Include 整列重建之後，自我停用過的列照樣不重掛（宿主替它推著 disabled）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-self-disable-rebuild-'));
    temporary.push(dir);
    chmodSync(dir, 0o700);
    const counter = `__selfDisableRebuild_${String(Date.now())}`;
    const quitter = join(dir, 'quitter.mjs');
    writeFileSync(
      quitter,
      functionPlugin(
        'quitter',
        `globalThis[${JSON.stringify(counter)}] = (globalThis[${JSON.stringify(counter)}] ?? 0) + 1; ctx.fiber.dispose()`,
      ),
      { mode: 0o600 },
    );
    chmodSync(quitter, 0o600);
    const shipped = join(dir, 'cordis.yml');
    const good = `- id: quitter\n  name: 'file://${quitter}'\n- id: echo\n  name: '${ECHO_MODULE}'\n`;
    writeFileSync(shipped, good, { mode: 0o600 });
    chmodSync(shipped, 0o600);
    const root = createCordisRoot();
    roots.push(root);
    const events: SelfDisableEvent[] = [];
    root.tree.onSelfDisable = (event) => void events.push(event);
    const count = (): number => (globalThis as Record<string, unknown>)[counter] as number;
    const overlay = (prefix: string): string => {
      const path = join(dir, `overlay-${prefix}.yml`);
      writeFileSync(path, `- id: echo\n  config:\n    prefix: ${prefix}\n`, { mode: 0o600 });
      chmodSync(path, 0o600);
      return path;
    };
    const sources = (patch: string) => ({ shipped, overlays: [patch], warn: () => undefined });
    await loadPluginConfig(sources(overlay('a')), { tree: root.tree });
    await loadPluginConfig(sources(overlay('b')), { tree: root.tree });
    expect(count()).toBe(1);
    // 出貨檔弄壞再修好：Include 不是 ACTIVE，整列拆掉重建。
    writeFileSync(shipped, 'not: a list\n', { mode: 0o600 });
    await expect(loadPluginConfig(sources(overlay('c')), { tree: root.tree })).rejects.toThrow();
    writeFileSync(shipped, good, { mode: 0o600 });
    const loaded = await loadPluginConfig(sources(overlay('d')), { tree: root.tree });
    expect(count()).toBe(1);
    expect(events).toHaveLength(1);
    expect(loaded.dropped).toEqual([]);
    expect(loaded.plugins.find((plugin) => plugin.id === 'quitter')?.disabled).toBe(true);
  }, 120000);

  it('Include 那一列整列重建、整棵樹卸載：正常掛著的列沒有事件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-self-disable-teardown-'));
    temporary.push(dir);
    chmodSync(dir, 0o700);
    const shipped = join(dir, 'cordis.yml');
    const good = `- id: echo\n  name: '${ECHO_MODULE}'\n`;
    writeFileSync(shipped, good, { mode: 0o600 });
    chmodSync(shipped, 0o600);
    const root = createCordisRoot();
    roots.push(root);
    const events: SelfDisableEvent[] = [];
    root.tree.onSelfDisable = (event) => void events.push(event);
    const sources = (overlay: string) => ({
      shipped,
      overlays: [overlay],
      warn: () => undefined,
    });
    const overlay = (config: string): string => {
      const path = join(dir, `overlay-${String(Date.now())}-${String(Math.random())}.yml`);
      writeFileSync(path, `- id: echo\n  config:\n    prefix: ${config}\n`, { mode: 0o600 });
      chmodSync(path, 0o600);
      return path;
    };
    await loadPluginConfig(sources(overlay('a')), { tree: root.tree });
    expect(events).toEqual([]);
    // 把出貨檔弄壞，換一份 patch 讓 Include 重讀：Include 那一列 FAILED。
    writeFileSync(shipped, 'not: a list\n', { mode: 0o600 });
    await expect(loadPluginConfig(sources(overlay('b')), { tree: root.tree })).rejects.toThrow();
    // 修好、再換一份 patch：Include 不是 ACTIVE，整列拆掉重建——底下的 echo 一起卸載。
    writeFileSync(shipped, good, { mode: 0o600 });
    await loadPluginConfig(sources(overlay('c')), { tree: root.tree });
    expect(events).toEqual([]);
    await root.dispose();
    roots.splice(roots.indexOf(root), 1);
    expect(events).toEqual([]);
  }, 120000);
});
