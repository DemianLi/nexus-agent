/**
 * 拿**真的** plugin 套件走一遍並存——[#1136](https://github.com/DemianLi/nexus-agent/issues/1136) 的探針。
 *
 * `plugin-coexist.ts` 用生出來的夾具量機制；這裡換成出貨的套件：把 `packages/nexus-plugin-<name>/src`（去掉測試）複製成
 * `v1`、`v2` 兩份，放在 `apps/harness/` 底下（裸 specifier 錨在 importer，放在 repo 外會找不到 `@nexus/core`），
 * 各用 `import()` 載進來，再各開一個 thread（`loadPlugins`）並行跑。檢查：
 *
 * 1. 兩份模組是不同的實例，但註冊出來的工具名與命令名相同；
 * 2. 兩個 thread 並行載入不互相拋錯（服務重名、單例之類）；
 * 3. A 收掉之後 B 的註冊還在、B 自己收得掉；
 * 4. 兩個都收掉之後，行程的活資源（計時器、socket、子行程⋯）回到載入前的數量。
 *
 * 設定取自出貨的 `cordis.yml` 那一列；沒有那一列的套件（選配）用呼叫端給的設定。
 *
 * @module
 */

import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadPlugins } from '@nexus/core';
import type { NexusPlugin } from '@nexus/core';
import { parse as parseYaml } from 'yaml';

const HARNESS = join(import.meta.dirname, '../..');
const REPO = join(HARNESS, '../..');

export interface RealProbeResult {
  readonly pkg: string;
  readonly status: 'ok' | 'failed';
  /** 失敗時卡在哪一步與訊息。 */
  readonly detail?: string;
  readonly tools: readonly string[];
  readonly commands: readonly string[];
  readonly distinctInstances: boolean;
  readonly sameSurface: boolean;
  readonly survivorIntact: boolean;
  /** 載入前後活資源數量的差（只列有差的類型）。 */
  readonly leakedResources: Record<string, number>;
}

function resourceCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const type of process.getActiveResourcesInfo())
    counts.set(type, (counts.get(type) ?? 0) + 1);
  return counts;
}

/** 出貨清單裡某顆套件那一列的設定。 */
export async function shippedConfig(pkg: string): Promise<Record<string, unknown> | undefined> {
  const rows = parseYaml(await readFile(join(HARNESS, 'cordis.yml'), 'utf8')) as {
    name: string;
    config?: Record<string, unknown>;
  }[];
  return rows.find((row) => row.name === `@nexus/plugin-${pkg}`)?.config;
}

/** 一顆套件兩個版本並行跑一遍。 */
export async function probeRealPlugin(
  pkg: string,
  config?: Record<string, unknown>,
  hostServices: Record<string, unknown> = {},
): Promise<RealProbeResult> {
  // 副本放在**套件自己的目錄底下**：它的相依（`diff`、`quickjs-emscripten`、MCP adapter⋯）住在套件自己的
  // `node_modules`，放到別處裸 specifier 就找不到——這本身就是「新版要連同自己的 node_modules 一起裝」的證據。
  const root = await mkdtemp(join(REPO, 'packages', `nexus-plugin-${pkg}`, '.coexist-real-'));
  const failed = (detail: string): RealProbeResult => ({
    pkg,
    status: 'failed',
    detail,
    tools: [],
    commands: [],
    distinctInstances: false,
    sameSurface: false,
    survivorIntact: false,
    leakedResources: {},
  });
  try {
    for (const version of ['v1', 'v2']) {
      await cp(join(REPO, 'packages', `nexus-plugin-${pkg}`, 'src'), join(root, version), {
        recursive: true,
        filter: (source) =>
          !/\.test\.ts$/u.test(source) && !/fixture/u.test(relative(REPO, source)),
      });
    }
    const load = async (version: string): Promise<NexusPlugin<unknown>> => {
      const module = (await import(pathToFileURL(join(root, version, 'index.ts')).href)) as {
        default?: NexusPlugin<unknown>;
      };
      if (module.default === undefined) throw new Error(`${version}/index.ts 沒有 default 匯出`);
      return module.default;
    };
    const [p1, p2] = [await load('v1'), await load('v2')];
    const entryOf = (plugin: NexusPlugin<unknown>, id: string) => ({
      plugin,
      id,
      ...(config === undefined ? {} : { config }),
    });
    // 宿主在組裝點替它提供的服務（例如 `systemPromptVariables`），排在被測的那一列前面。
    const host = (id: string) => ({
      id: `${id}-host`,
      plugin: {
        name: 'probe-host',
        apply(registry: Parameters<NexusPlugin['apply']>[0]) {
          for (const [key, value] of Object.entries(hostServices))
            registry.services.provide(key, value);
        },
      } satisfies NexusPlugin,
    });
    // 讀檔、載入剛結束時還有幾個沒收的非同步請求，等它們離場再量基線。
    await new Promise((resolve) => setTimeout(resolve, 50));
    const before = resourceCounts();
    let a;
    let b;
    try {
      [a, b] = await Promise.all([
        loadPlugins([host('thread-a'), entryOf(p1, 'thread-a')]),
        loadPlugins([host('thread-b'), entryOf(p2, 'thread-b')]),
      ]);
    } catch (error) {
      return failed(`並行載入失敗：${error instanceof Error ? error.message : String(error)}`);
    }
    const surface = (registry: typeof a.registry) => ({
      tools: [...registry.tools.effective().keys()].sort(),
      commands: registry.commands
        .list()
        .map((command) => command.name)
        .sort(),
    });
    const sa = surface(a.registry);
    const sb = surface(b.registry);
    await a.dispose();
    const survivor = surface(b.registry);
    const survivorIntact = JSON.stringify(survivor) === JSON.stringify(sb);
    await b.dispose();
    // 讓剛 clear 的計時器、關掉的 socket 有一個 tick 離場。
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const after = resourceCounts();
    const leaked: Record<string, number> = {};
    for (const type of new Set([...before.keys(), ...after.keys()])) {
      const delta = (after.get(type) ?? 0) - (before.get(type) ?? 0);
      if (delta !== 0) leaked[type] = delta;
    }
    return {
      pkg,
      status: 'ok',
      tools: sa.tools,
      commands: sa.commands,
      distinctInstances: p1 !== p2,
      sameSurface: JSON.stringify(sa) === JSON.stringify(sb),
      survivorIntact,
      leakedResources: leaked,
    };
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
