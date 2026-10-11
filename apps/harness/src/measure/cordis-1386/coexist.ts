/**
 * [#1386](https://github.com/DemianLi/nexus-agent/issues/1386) 驗收 ③：同一顆插件的兩個版本各在一個 isolate realm、各被不同 thread 使用；
 * 舊版的最後一個 thread 結束後由引用計數撤掉，活資源回到載入前。
 *
 * 選 `nexus-plugin-mcp`，因為它是出貨插件裡少數 `apply` 會開**真的**行程級資源的：一台 stdio 的 MCP server 子行程
 * （它自己的 `fixture-server.ts`）加三條管線。用不開資源的插件量「回到載入前」是空的通過。
 *
 * 各層是什麼：
 *
 * - **版本副本**：`packages/nexus-plugin-mcp/src` 複製成 `v1`、`v2` 兩份放在套件目錄底下（相依住在套件自己的
 *   `node_modules`，見 `plugin-coexist-real.ts`），各自 `import()`——兩份模組、兩個實例。
 * - **一個版本＝Loader 的一列**：{@link nexusVersion} 把一顆 `NexusPlugin` 包成 Cordis 插件，`apply` 裡
 *   `loadPlugins` 並把載好的 registry 以服務 `mcp` 提供出去，回傳的收尾函式就是 `dispose`。列上帶
 *   `isolate: { mcp: <版本標籤> }`，所以兩個版本的同名服務各在一個 GlobalRealm 裡。
 *   這是「單顆 NexusPlugin 包成一列」的轉接，不是 ② 那種「整個 PluginRegistry 包成一顆相容層」——兩者形狀不同，報告寫明。
 * - **thread＝Loader 的一列**：`inject: ['mcp']`，列上的 `isolate` 指向它被路由到的版本標籤；`apply` 時呼叫一次工具，證明是那一版的連線在服務它。
 * - **版本路由**（{@link VersionRouter}）：持有版本表，新 thread 一律導到最新版；thread 結束時引用計數減一，
 *   不是最新版又歸零就 `loader.remove()` 那一版。
 *
 * 在 tsx 子行程裡跑（`coexist-cli.ts`），理由同 `plugin-coexist.test.ts`：模組載入要量的是產品的 Node＋tsx，不是 vitest 的執行器。
 *
 * @module
 */

import { cp, mkdtemp, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Context } from '@nexus/cordis';
import type { Loader } from '@nexus/cordis-plugin-loader';
import { loadPlugins } from '@nexus/core';
import type { NexusPlugin, PluginRegistry } from '@nexus/core';
import { STATE, boot, createEntry, fiberOf } from './tree.js';

const REPO = join(import.meta.dirname, '../../../../..');
const MCP = join(REPO, 'packages', 'nexus-plugin-mcp');
const FIXTURE_SERVER = join(MCP, 'src', 'fixture-server.ts');
const TOOL = 'mcp__fixture__fetch_release_note';

declare module '@nexus/cordis' {
  interface Context {
    mcp: McpVersion;
  }
}

/** 一個版本提供出去的東西。 */
export interface McpVersion {
  readonly label: string;
  readonly registry: PluginRegistry;
  readonly plugin: NexusPlugin<unknown>;
}

/** 把一顆 NexusPlugin 的某一版包成 Cordis 插件：apply 載入並提供服務，收尾就是 dispose。 */
export function nexusVersion(label: string, plugin: NexusPlugin<unknown>) {
  return {
    name: `mcp-version`,
    async apply(ctx: Context, config: Record<string, unknown>) {
      const loaded = await loadPlugins([{ plugin, id: label, config }]);
      // 收尾一開完資源就登記，排在 provide 前面：provide 撞名拋錯時（見 runWithoutIsolate），
      // 失敗的 fiber 照樣跑已登記的收尾；寫成 `return () => loaded.dispose()` 的話這時還沒登記，子行程就漏了。
      ctx.effect(() => () => loaded.dispose(), 'loadPlugins');
      ctx.provide('mcp', { label, registry: loaded.registry, plugin } satisfies McpVersion);
    },
  };
}

/** thread：拿它被路由到的那一版，呼叫一次工具。 */
export function threadPlugin(log: { thread: string; label: string; result: string }[]) {
  return {
    name: 'thread',
    inject: ['mcp'],
    async apply(ctx: Context) {
      const version = ctx.mcp;
      const tool = version.registry.tools.effective().get(TOOL);
      if (tool === undefined) throw new Error(`${version.label} 沒有 ${TOOL}`);
      const result = String(await tool.value.invoke({ topic: ctx.fiber.entry!.options.id }));
      log.push({ thread: ctx.fiber.entry!.options.id, label: version.label, result });
    },
  };
}

interface VersionRow {
  readonly label: string;
  readonly entry: string;
  readonly threads: Set<string>;
}

/** 版本路由：新 thread 導到最新版，舊版的最後一個 thread 結束就撤。 */
export class VersionRouter {
  readonly #versions: VersionRow[] = [];

  constructor(
    readonly loader: Loader,
    readonly isolate: boolean = true,
  ) {}

  get latest(): VersionRow | undefined {
    return this.#versions.at(-1);
  }

  /** 還在表上的版本與各自的 thread 數。 */
  table(): { label: string; threads: number }[] {
    return this.#versions.map((row) => ({ label: row.label, threads: row.threads.size }));
  }

  /** 裝一個新版本：開一列，帶自己的 realm 標籤。 */
  async install(label: string, builtin: string, config: Record<string, unknown>): Promise<string> {
    const entry = label.replace(/[^\w@.-]/gu, '_');
    await createEntry(this.loader, {
      id: entry,
      name: `cordis:${builtin}`,
      config,
      ...(this.isolate ? { isolate: { mcp: label } } : {}),
    });
    await this.loader.await();
    this.#versions.push({ label, entry, threads: new Set() });
    return entry;
  }

  /** 開一個 thread：導到最新版。 */
  async start(thread: string): Promise<string> {
    const row = this.latest;
    if (row === undefined) throw new Error('還沒有任何版本');
    row.threads.add(thread);
    await createEntry(this.loader, {
      id: thread,
      name: 'cordis:thread',
      ...(this.isolate ? { isolate: { mcp: row.label } } : {}),
    });
    await this.loader.await();
    return row.label;
  }

  /** thread 結束：引用計數減一；不是最新版又歸零就撤掉那一版。回傳撤掉的版本標籤。 */
  async end(thread: string): Promise<string | undefined> {
    const row = this.#versions.find((candidate) => candidate.threads.has(thread));
    if (row === undefined) throw new Error(`沒有 thread ${thread}`);
    this.loader.remove(thread);
    row.threads.delete(thread);
    await this.loader.await();
    if (row === this.latest || row.threads.size > 0) return undefined;
    this.loader.remove(row.entry);
    this.#versions.splice(this.#versions.indexOf(row), 1);
    await this.loader.await();
    return row.label;
  }
}

/** 行程的活資源，按類型計數。 */
export function resources(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const type of process.getActiveResourcesInfo()) counts[type] = (counts[type] ?? 0) + 1;
  return counts;
}

/** 兩份計數的差（只列有差的類型）。 */
export function delta(after: Record<string, number>, before: Record<string, number>) {
  const out: Record<string, number> = {};
  for (const type of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const diff = (after[type] ?? 0) - (before[type] ?? 0);
    if (diff !== 0) out[type] = diff;
  }
  return out;
}

/** 讓剛關掉的子行程、管線與計時器離場。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 20));
}

/** mcp 那一列的設定：連自己套件裡的 stdio fixture server。 */
function mcpConfig(): Record<string, unknown> {
  return {
    serverName: 'fixture',
    connection: {
      transport: 'stdio',
      command: process.execPath,
      args: ['--import', 'tsx', FIXTURE_SERVER],
    },
  };
}

/** 把 mcp 的 src 複製成 v1、v2，各自 import。回傳兩顆插件與收拾函式。 */
async function copies(): Promise<{
  v1: NexusPlugin<unknown>;
  v2: NexusPlugin<unknown>;
  cleanup: () => Promise<void>;
}> {
  // 放在套件自己的 node_modules 底下：相依照樣往上找得到，而掃整棵樹的測試（例如 known-event-types）
  // 都略過 node_modules，不會在這份副本被刪掉的那一刻讀到半個目錄。
  const root = await mkdtemp(join(MCP, 'node_modules', '.coexist-cordis-'));
  const load = async (version: string) => {
    await cp(join(MCP, 'src'), join(root, version), {
      recursive: true,
      filter: (source) => !/\.test\.ts$/u.test(source),
    });
    const module = (await import(pathToFileURL(join(root, version, 'index.ts')).href)) as {
      default: NexusPlugin<unknown>;
    };
    return module.default;
  };
  const [v1, v2] = [await load('v1'), await load('v2')];
  return { v1, v2, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** 主流程的量測結果。 */
export interface CoexistReport {
  readonly distinctModules: boolean;
  /** 每個 thread 被哪一版服務、工具回了什麼。 */
  readonly served: { thread: string; label: string; result: string }[];
  /** v1 還有 thread 時，路由有沒有撤它（應該沒有）。 */
  readonly v1KeptWhileInUse: boolean;
  /** 裝 v1 時多出來的活資源（證明這顆插件真的開了東西）。 */
  readonly v1Opened: Record<string, number>;
  /** 撤掉 v1 前後的差，應等於「v1Opened 的相反數」。 */
  readonly v1Drain: Record<string, number>;
  /** 撤掉 v1 之後，v1 那一列與它的 fiber。 */
  readonly v1EntryGone: boolean;
  readonly v1FiberState: number | undefined;
  /** 撤掉 v1 之後 v2 的 thread 還能用。 */
  readonly v2StillServes: boolean;
  /** 全部收掉之後與載入前的差，應為空。 */
  readonly finalLeak: Record<string, number>;
  readonly table: { label: string; threads: number }[];
}

/** 主流程：v1 → thread-a → v2 → thread-b → thread-a 結束（v1 排水）→ thread-b 結束、撤 v2。 */
export async function runCoexist(): Promise<CoexistReport> {
  const { v1, v2, cleanup } = await copies();
  const served: { thread: string; label: string; result: string }[] = [];
  try {
    const t = await boot({
      'mcp-v1': nexusVersion('mcp@1', v1),
      'mcp-v2': nexusVersion('mcp@2', v2),
      thread: threadPlugin(served),
    });
    const router = new VersionRouter(t.loader);
    await settle();
    const before = resources();

    const v1Entry = await router.install('mcp@1', 'mcp-v1', mcpConfig());
    await settle();
    const v1Opened = delta(resources(), before);
    await router.start('thread-a');

    await router.install('mcp@2', 'mcp-v2', mcpConfig());
    await router.start('thread-b');
    await settle();
    const v1KeptWhileInUse =
      t.state(v1Entry) === STATE.ACTIVE && router.table().some((row) => row.label === 'mcp@1');
    const v1Fiber = fiberOf(t.loader, v1Entry);

    const beforeDrain = resources();
    const drained = await router.end('thread-a');
    await settle();
    const v1Drain = delta(resources(), beforeDrain);
    const v1EntryGone = drained === 'mcp@1' && !(v1Entry in t.loader.store);

    // v2 的 thread 再開一個，確認撤掉 v1 沒有拖到 v2。
    await router.start('thread-c');
    const v2StillServes = served.at(-1)?.label === 'mcp@2';
    await router.end('thread-c');
    const table = router.table();

    await router.end('thread-b');
    t.loader.remove(router.latest!.entry);
    await t.loader.await();
    await settle();
    return {
      distinctModules: v1 !== v2,
      served,
      v1KeptWhileInUse,
      v1Opened,
      v1Drain,
      v1EntryGone,
      v1FiberState: v1Fiber?.state,
      v2StillServes,
      finalLeak: delta(resources(), before),
      table,
    };
  } finally {
    await cleanup();
  }
}

/** 負對照：不開 isolate，第二版 provide 同名服務會撞名，第二版那一列起不來；它已經開的子行程照樣收掉。 */
export async function runWithoutIsolate(): Promise<{
  /** 撞名之後、撤掉之前：失敗的 fiber 本來就是 FAILED。 */
  v2State: number | undefined;
  /** 撤掉之後同一顆 fiber 的狀態：要收斂到 DISPOSED（上游 #127）。 */
  v2StateAfterRemove: number | undefined;
  errors: string[];
  leak: Record<string, number>;
}> {
  const { v1, v2, cleanup } = await copies();
  try {
    const t = await boot({
      'mcp-v1': nexusVersion('mcp@1', v1),
      'mcp-v2': nexusVersion('mcp@2', v2),
    });
    const router = new VersionRouter(t.loader, false);
    await settle();
    const before = resources();
    await router.install('mcp@1', 'mcp-v1', mcpConfig());
    const v2Entry = await router.install('mcp@2', 'mcp-v2', mcpConfig());
    await settle();
    const v2State = t.state(v2Entry);
    const v2Fiber = fiberOf(t.loader, v2Entry);
    const errors = t.errors.flatMap((message) =>
      message.args.map((arg) => (arg instanceof Error ? arg.message : String(arg))),
    );
    for (const id of Object.keys(t.loader.store)) t.loader.remove(id);
    await t.loader.await();
    await settle();
    return {
      v2State,
      v2StateAfterRemove: v2Fiber?.state,
      errors,
      leak: delta(resources(), before),
    };
  } finally {
    await cleanup();
  }
}

/** 給報告用：副本放在哪裡（相對 repo）。 */
export const COPY_HOME = relative(REPO, MCP);
export const HERE = fileURLToPath(import.meta.url);
