/**
 * echo 上樹的邊界（[#1416](https://github.com/DemianLi/nexus-agent/issues/1416) PR 2）：驗收 C 與 H，加上
 * 樹與相容層兩支疊 patch 演算法的等價、沒遷移的列不上樹、`cordis.serve.yml` 那一層的已知限制、
 * 設定帶 `__jsExpr`、插件自我停用的閃動。
 *
 * 主線（D、E、F、並發、寫回）在 `echo-on-tree.test.ts`。這裡的清單用暫存的出貨檔搭，模組也是暫存的：
 * 要造「契約不相容」「自己停用自己」這種出貨清單上不會有的插件。
 */

import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { manifest as echoManifest } from '@nexus/plugin-echo';
import { effectiveReload } from '@nexus/sdk';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createCordisRoot } from './cordis-root.js';
import type { CordisRoot } from './cordis-root.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import {
  applyEntryPatches,
  loadDefaultPlugins,
  loadPluginConfig,
  PluginConfigError,
} from './plugin-config.js';
import { classOfRow } from './plugin-row-classes.js';
import { buildPluginSnapshot } from './plugin-snapshot.js';
import type { SnapshotSource } from './plugin-snapshot.js';
import { PluginTreeError } from './plugin-tree.js';
import { auditStartupEntries, startupWarning } from './startup-audit.js';

const temporary: string[] = [];
const roots: CordisRoot[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await root.dispose().catch(() => {});
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-echo-edge-'));
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

/** 一顆函式插件：沒有 import 以外的依賴，工具範圍可調，`apply` 的本體由呼叫端給。 */
function functionPlugin(options: { id: string; range: string; apply: string }): string {
  return `import { z } from 'zod';
export const name = ${JSON.stringify(options.id)};
export const inject = { tools: { range: ${JSON.stringify(options.range)} } };
export const Config = z.strictObject({});
export const manifest = {
  id: ${JSON.stringify(options.id)}, version: '1.0.0', owner: 't',
  provides: [], consumes: [{ token: 'tools', range: ${JSON.stringify(options.range)} }],
  config: Config, reload: { code: 'restart', config: 'next-thread' }, capabilities: [],
};
export function apply(ctx) { ${options.apply} }
`;
}

/**
 * echo 模組的絕對位置。出貨檔在暫存目錄時，Include 裡的裸 specifier 錨在**出貨檔所在目錄**（`vendor/include` 的
 * `ctx.baseUrl`），解不出 `@nexus/plugin-echo`；真正的出貨檔住在 `apps/harness`，沒有這個問題。
 */
const ECHO_MODULE = import.meta.resolve('@nexus/plugin-echo');

const ECHO_SHIPPED = `- id: echo\n  name: '${ECHO_MODULE}'\n`;

describe('C：echo 對 tools 契約不相容', () => {
  it('那一列掉在 requires，訊息帶契約錯誤；其餘列照樣起來；啟動稽核把它列進去', async () => {
    const dir = scratch();
    // 同一個 id `echo`、`inject` 要的範圍是 tools 給不起的 `^2.0.0`：跟「出貨的 echo 對上了不相容的 tools」同一個形狀。
    const module = write(
      dir,
      'echo-v2.mjs',
      functionPlugin({ id: 'echo', range: '^2.0.0', apply: '' }),
    );
    const shipped = write(
      dir,
      'cordis.yml',
      `- id: echo\n  name: 'file://${module}'\n- id: other\n  name: '${ECHO_MODULE}'\n`,
    );
    const root = newRoot();
    const loaded = await loadPluginConfig({ shipped, warn: warnNothing }, { tree: root.tree });

    const echo = loaded.dropped.find((drop) => drop.id === 'echo');
    expect(echo?.stage).toBe('requires');
    expect(echo?.message).toMatch(/tools/u);
    expect(echo?.message).toMatch(/\^2\.0\.0/u);
    // 另一列（echo 的出貨模組，對 tools 範圍是相容的）不受牽連。
    expect(loaded.dropped.find((drop) => drop.id === 'other')).toBeUndefined();

    // 稽核：echo 不在必掛名單上，不拋；可少掛的那一段警告指名這一列與原因。
    expect(() => auditStartupEntries(loaded, { live: false })).not.toThrow();
    const lines = startupWarning(loaded, []).join('\n');
    expect(lines).toContain('echo');
    expect(lines).toContain('要用的服務沒人提供');
    expect(lines).toMatch(/\^2\.0\.0/u);
  }, 60000);

  it('契約不相容的列在樹上是等待中的，沒有登記任何工具', async () => {
    const dir = scratch();
    const module = write(
      dir,
      'echo-v2.mjs',
      functionPlugin({
        id: 'echo',
        range: '^2.0.0',
        apply: "ctx.tools.register({ name: 'ghost' })",
      }),
    );
    const shipped = write(dir, 'cordis.yml', `- id: echo\n  name: 'file://${module}'\n`);
    const root = newRoot();
    await loadPluginConfig({ shipped, warn: warnNothing }, { tree: root.tree });
    const tree = await root.tree.context();
    // 0 = PENDING（等不到相容的服務），不是 2 = ACTIVE。
    expect(tree.loader.resolve('include:echo').fiber?.ctx.fiber.state).toBe(0);
  }, 60000);
});

describe('H：快照與列分類對上樹的 echo', () => {
  async function sourceOf(patch?: string): Promise<SnapshotSource> {
    const dir = scratch();
    if (patch !== undefined) write(dir, 'cordis.patch.yml', patch);
    const root = newRoot();
    const loaded = await loadDefaultPlugins(
      { serve: false, env: { [HARNESS_HOME_ENV]: dir }, warn: warnNothing },
      { tree: root.tree },
    );
    return {
      entries: loaded.entries,
      ids: loaded.ids,
      plugins: loaded.plugins,
      rows: loaded.rows,
      drops: loaded.dropped.map(({ id, stage }) => ({ id, stage })),
    };
  }

  it('echo 在快照上是「下一條 thread」那一類，停用了就是 disabled、掉了的階段不變', async () => {
    const running = await sourceOf();
    const saved = await sourceOf('- id: echo\n  disabled: true\n');
    const snapshot = buildPluginSnapshot({ running, saved, generatedAt: new Date(0) });
    const echo = snapshot.rows.find((row) => row.id === 'echo');
    expect(echo).toMatchObject({
      module: '@nexus/plugin-echo',
      running: { state: 'mounted' },
      saved: { state: 'disabled' },
      sync: 'next-thread',
    });
    // 沒改什麼的那一對：同一份。
    const same = buildPluginSnapshot({ running, saved: running, generatedAt: new Date(0) });
    expect(same.rows.find((row) => row.id === 'echo')?.sync).toBe('same');
  }, 60000);

  it('echo 宣告的 reload 不比宿主的分類寬：宿主把它挪進起動期讀，那份宣告就是謊話', () => {
    const host = {
      config: classOfRow('echo', 'echo') === 'startup-read' ? 'restart' : 'next-thread',
    } as const;
    expect(effectiveReload(echoManifest.reload, host)).toEqual(echoManifest.reload);
  });
});

/**
 * 上游 Include 疊 patch 的那支。**用變數當 specifier 動態載入**：它在 `vendor/include/src` 裡，沒有 `.d.ts` 輸出，
 * 靜態 import 會讓 harness 的 tsc 把整個 vendor 原始碼拉進自己的嚴格設定裡檢查（vendor 有自己的 tsconfig 在管）。
 */
type UpstreamApplyPatches = (
  data: Record<string, unknown>[],
  patches: Record<string, unknown>[] | undefined,
  warn: (format: string, ...args: unknown[]) => void,
) => Record<string, unknown>[];
const UPSTREAM_PATCH_MODULE = '@nexus/cordis-plugin-include/src/patch.ts';

describe('兩支疊 patch 的演算法：相容層的 applyEntryPatches 與上游 Include 的 applyPatches', () => {
  let applyPatches: UpstreamApplyPatches;
  beforeAll(async () => {
    const loaded = (await import(/* @vite-ignore */ UPSTREAM_PATCH_MODULE)) as {
      applyPatches: UpstreamApplyPatches;
    };
    applyPatches = loaded.applyPatches;
  });
  const base = [
    { id: 'a', name: 'm-a', config: { x: 1 } },
    { id: 'echo', name: '@nexus/plugin-echo', config: {} },
    { id: 'b', name: 'm-b', disabled: true },
  ];
  const project = (rows: readonly Record<string, unknown>[]) =>
    rows.map((row) => ({
      id: row['id'],
      name: row['name'],
      disabled: row['disabled'] === true,
      config: row['config'] ?? {},
    }));
  const compat = (patches: Record<string, unknown>[]) =>
    project(applyEntryPatches(base, patches as never, warnNothing));
  const upstream = (patches: Record<string, unknown>[]) =>
    project(applyPatches(structuredClone(base), patches, warnNothing));

  const OPS: readonly (readonly [string, Record<string, unknown>[]])[] = [
    ['disable', [{ id: 'echo', disabled: true }]],
    ['enable', [{ id: 'b', disabled: false }]],
    [
      'disable 再 enable',
      [
        { id: 'echo', disabled: true },
        { id: 'echo', disabled: false },
      ],
    ],
    ['config-set', [{ id: 'echo', name: '@nexus/plugin-echo', config: { prefix: 'x' } }]],
    ['config-reset（折疊後沒有那一條 patch）', []],
    ['--patch：改設定加停用', [{ id: 'a', config: { x: 2 }, disabled: true }]],
    ['--patch：插入一列', [{ insert: [{ id: 'new', name: '@nexus/plugin-echo' }] }]],
    ['name 對不上：兩邊都跳過', [{ id: 'echo', name: '@nexus/other', disabled: true }]],
    ['找不到 id：兩邊都跳過', [{ id: 'nope', disabled: true }]],
  ];

  it.each(OPS)('%s：疊出來的 id／name／disabled／config 與順序一樣', (_label, patches) => {
    expect(compat(patches)).toEqual(upstream(patches));
  });

  it('已知的差別：帶 id 的 insert，相容層接到尾巴、上游往群組裡塞（不是群組就跳過）——樹那一側把 id 拿掉再推', () => {
    const patches = [{ id: 'echo', insert: [{ id: 'extra', name: 'm-extra' }] }];
    expect(compat(patches).map((row) => row.id)).toEqual(['a', 'echo', 'b', 'extra']);
    expect(upstream(patches).map((row) => row.id)).toEqual(['a', 'echo', 'b']);
  });

  it('產品路徑：帶 id 的 insert 照樣讓插進來的列上樹（推給樹的 patch 已拿掉 id）', async () => {
    const dir = scratch();
    const shipped = write(dir, 'cordis.yml', ECHO_SHIPPED);
    const overlay = write(
      dir,
      'overlay.yml',
      `- id: echo\n  insert:\n    - id: echo-two\n      name: '${ECHO_MODULE}'\n      config:\n        prefix: 二\n`,
    );
    const root = newRoot();
    const loaded = await loadPluginConfig(
      { shipped, overlays: [overlay], warn: warnNothing },
      { tree: root.tree },
    );
    // 兩列都叫 `echo` 這個工具名：第二列撞名掉了，不是因為沒上樹。
    expect(loaded.ids).toEqual(['echo', 'echo-two']);
    const tree = await root.tree.context();
    expect(tree.loader.resolve('include:echo-two').options.config).toEqual({ prefix: '二' });
    // 出貨的那一列不受牽連：還是 ACTIVE，工具登記著；掉的是撞名的第二列。
    expect(tree.loader.resolve('include:echo').fiber?.ctx.fiber.state).toBe(2);
    expect(loaded.dropped.map((drop) => drop.id)).toEqual(['echo-two']);
  }, 60000);
});

describe('沒遷移的列不上樹，也不會被兩邊各套一次', () => {
  it('樹上 include 底下只有函式插件那一列；工具只登記一次', async () => {
    const dir = scratch();
    const root = newRoot();
    const loaded = await loadDefaultPlugins(
      { env: { [HARNESS_HOME_ENV]: dir }, warn: warnNothing },
      { tree: root.tree },
    );
    expect(loaded.plugins.length).toBeGreaterThan(5);
    const tree = await root.tree.context();
    const rows = Object.keys(tree.loader.resolve('include').subtree?.store ?? {});
    expect(rows).toEqual(['echo']);
  }, 60000);
});

describe('已知限制：cordis.serve.yml 那一層不經 Include', () => {
  it('serve 專屬層裡的函式插件上不了樹，那一列掉在 apply 並指名原因', async () => {
    const dir = scratch();
    const module = write(
      dir,
      'serve-only.mjs',
      functionPlugin({ id: 'serve-only', range: '^1.0.0', apply: '' }),
    );
    const shipped = write(dir, 'cordis.yml', ECHO_SHIPPED);
    const serveLayer = write(
      dir,
      'cordis.serve.yml',
      `- id: serve-only\n  name: 'file://${module}'\n`,
    );
    const root = newRoot();
    const loaded = await loadPluginConfig(
      { shipped, shippedLayers: [serveLayer], warn: warnNothing },
      { tree: root.tree },
    );
    const drop = loaded.dropped.find((candidate) => candidate.id === 'serve-only');
    expect(drop?.stage).toBe('apply');
    expect(drop?.message).toContain('cordis.serve.yml');
    // 出貨檔那一層的 echo 不受影響。
    expect(loaded.dropped.find((candidate) => candidate.id === 'echo')).toBeUndefined();
  }, 60000);
});

describe('兩邊疊出來對不上：不靜靜地各走各的', () => {
  async function verdictFor(patches: Record<string, unknown>[], config: Record<string, unknown>) {
    const dir = scratch();
    const shipped = write(dir, 'cordis.yml', ECHO_SHIPPED);
    const root = newRoot();
    const snapshot = await root.tree.run(() =>
      root.tree.sync({
        shipped,
        patches,
        rows: [{ id: 'echo', module: ECHO_MODULE, disabled: false, config }],
      }),
    );
    return snapshot.verdict('echo');
  }

  it('設定不一致：那一列掉在 apply，訊息指出是兩邊對不上', async () => {
    const verdict = await verdictFor([{ id: 'echo', config: { prefix: 'x' } }], { prefix: 'y' });
    expect(verdict.kind).toBe('dropped');
    expect(verdict.kind === 'dropped' && verdict.stage).toBe('apply');
    expect(verdict.kind === 'dropped' && verdict.message).toMatch(/不一致/u);
  }, 60000);

  it('停用不一致：樹上停用、清單卻是啟用，同樣掉在 apply', async () => {
    const verdict = await verdictFor([{ id: 'echo', disabled: true }], {});
    expect(verdict.kind).toBe('dropped');
    expect(verdict.kind === 'dropped' && verdict.message).toMatch(/停用/u);
  }, 60000);

  it('一致就是 active，帶著它登記的工具', async () => {
    const verdict = await verdictFor([{ id: 'echo', config: { prefix: 'x' } }], { prefix: 'x' });
    expect(verdict.kind).toBe('active');
    expect(verdict.kind === 'active' && verdict.tools.map((tool) => tool.name)).toEqual(['echo']);
  }, 60000);
});

describe('設定帶 __jsExpr', () => {
  it('讀清單就整份拒絕（相容層那一關），寫入前驗證走同一條，所以不會寫進紀錄', async () => {
    const dir = scratch();
    const shipped = write(dir, 'cordis.yml', ECHO_SHIPPED);
    const overlay = write(
      dir,
      'overlay.yml',
      `- id: echo\n  config:\n    prefix:\n      __jsExpr: "process.exit(1)"\n`,
    );
    const root = newRoot();
    await expect(
      loadPluginConfig({ shipped, overlays: [overlay], warn: warnNothing }, { tree: root.tree }),
    ).rejects.toThrow(PluginConfigError);
    await expect(
      loadPluginConfig({ shipped, overlays: [overlay], warn: warnNothing }, { tree: root.tree }),
    ).rejects.toThrow(/__jsExpr/u);
    // 沒有樹的呼叫端也一樣：這一關在相容層，不靠樹。
    await expect(
      loadPluginConfig({ shipped, overlays: [overlay], warn: warnNothing }),
    ).rejects.toThrow(/__jsExpr/u);
  }, 60000);

  it('推上樹那一關是後盾：直接把帶 __jsExpr 的 patch 交給樹也拒絕', async () => {
    const root = newRoot();
    const dir = scratch();
    const shipped = write(dir, 'cordis.yml', ECHO_SHIPPED);
    await expect(
      root.tree.run(() =>
        root.tree.sync({
          shipped,
          patches: [{ id: 'echo', config: { prefix: { __jsExpr: '1' } } }],
          rows: [{ id: 'echo', module: ECHO_MODULE, disabled: false, config: {} }],
        }),
      ),
    ).rejects.toThrow(PluginTreeError);
  }, 60000);
});

describe('已知限制：插件自我停用只在記憶體，下一條 thread 會被重新掛上', () => {
  it('不寫檔、不進紀錄；每次讀清單都重掛一次（閃動）', async () => {
    const dir = scratch();
    const counter = `__selfDisable_${String(Date.now())}`;
    const module = write(
      dir,
      'self-disable.mjs',
      functionPlugin({
        id: 'quitter',
        range: '^1.0.0',
        apply: `globalThis[${JSON.stringify(counter)}] = (globalThis[${JSON.stringify(counter)}] ?? 0) + 1; ctx.fiber.dispose()`,
      }),
    );
    const shippedBody = `- id: quitter\n  name: 'file://${module}'\n`;
    const shipped = write(dir, 'cordis.yml', shippedBody);
    const root = newRoot();
    const count = (): number => (globalThis as Record<string, unknown>)[counter] as number;

    const first = await loadPluginConfig({ shipped, warn: warnNothing }, { tree: root.tree });
    expect(count()).toBe(1);
    // 樹上那一列自己停用了自己，清單疊出來是啟用的：這一列掉了，訊息講得出為什麼。
    expect(first.dropped.find((drop) => drop.id === 'quitter')?.message).toMatch(/停用/u);

    await loadPluginConfig({ shipped, warn: warnNothing }, { tree: root.tree });
    // 清單是「想要的狀態」：同步時把它重新掛上，又停用一次。
    expect(count()).toBe(2);

    // 沒有任何檔被寫：出貨檔位元組不變，目錄裡只有那兩個檔。
    expect(readFileSync(shipped, 'utf8')).toBe(shippedBody);
    expect(readdirSync(dir).sort()).toEqual(['cordis.yml', 'self-disable.mjs']);
  }, 60000);
});

describe('安裝樹不可寫：Loader 的 .cordis 輔助檔不是產品路徑的前提', () => {
  it('出貨檔所在專案根唯讀，裸 specifier 的 echo 仍然 ACTIVE，目錄裡沒有多出任何檔', async () => {
    const dir = scratch();
    // 上游 `createResolve` 會在 `baseUrl` 所屬專案根（最近有 package.json 的目錄）建 `.cordis/`。
    write(dir, 'package.json', '{"name":"readonly-install","private":true,"type":"module"}\n');
    const shipped = write(dir, 'cordis.yml', "- id: echo\n  name: '@nexus/plugin-echo'\n");
    chmodSync(dir, 0o500);
    try {
      const root = newRoot();
      const loaded = await loadPluginConfig({ shipped, warn: warnNothing }, { tree: root.tree });
      expect(loaded.dropped).toEqual([]);
      const tree = await root.tree.context();
      // 2 = ACTIVE。
      expect(tree.loader.resolve('include:echo').fiber?.ctx.fiber.state).toBe(2);
      expect(readdirSync(dir).sort()).toEqual(['cordis.yml', 'package.json']);
    } finally {
      chmodSync(dir, 0o700);
    }
  }, 60000);
});
