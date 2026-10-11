/**
 * serve 每條 thread 組裝時重讀一次清單（[#1405](https://github.com/DemianLi/nexus-agent/issues/1405)）。
 *
 * ## 換得到的與換不到的
 *
 * 重讀用的是同一個 `loadDefaultPlugins`、同一份 env、home 層與 `--patch`，所以改了 home 層的 `cordis.yml`，下一條新 thread
 * 看得到：列的掛與不掛、組裝期讀的設定（`.docs/plugin-reload-classification-2026-10-08.md` 的 B、C 表）。**換不到程式碼版本**：
 * `import()` 有 ESM 快取，同一個 specifier 第二次拿到的是同一個模組物件；換版本是版本路由的事（決議 §3-2 第 6 條）。
 *
 * 起動期讀一次的列（{@link ThreadPluginListOptions.startupRead}）照舊到重啟才生效：重讀時它的值跟執行中的不同，就在伺服器
 * 日誌記一句「已儲存，待重啟」，同一個值只講一次，不讓它靜靜不生效。
 *
 * ## 掉了的列（demian 2026-10-11 拍板，#1405 Q1、Q2）
 *
 * - **必掛的列掉了，只讓這一條 thread 建不起來**：拋跟啟動那一次同一種 `StartupError`，伺服器照常，下一條再讀一次。
 *   不沿用上一份讀得起來的清單：那會讓「改壞了」靜靜不生效。
 * - **可少掛的列，同一列的設定沒變就一直算沒掛**：啟動試組掉了的列、讀清單時掉了的列，都以「列 id 加那一列疊完的宣告」
 *   記成已知，不每條 thread 重試、各印一次——同啟動那一段的性質。那一列的宣告一改，下一條 thread 就重新試它；重試又
 *   掉了，新的宣告也記成已知（{@link ThreadPluginReader.noteDropped}），讀清單時新掉的列在伺服器日誌記一次。
 *   啟動試組沒掉、某一條 thread 組裝時才掉的列不在這條規則裡，照舊只在那一條不掛。
 *
 * 讀清單交出的警告（例如 patch 指到不存在的 id）也只記一次，進伺服器日誌。
 *
 * ## 偏離登記
 *
 * dsh 開 HMR 時設定一改立即影響使用那個 profile 的全部會話，沒開就保留到重啟（dsh
 * `packages/boot/plugin-manager/README.zh.md`〈概述〉）。我們是組 thread 時拉、只給新 thread：產品需求超出 dsh 的射程，
 * 歸在決議 `.docs/decisions-2026-10-11.md` §3-2 第 6 條（插件更新只給新對話）。清單仍不由 Loader 讀出來（決議 §3-5）。
 *
 * @module
 */

import { isDeepStrictEqual } from 'node:util';

import type { NexusPlugin, PluginEntry } from '@nexus/core';

import type { LoadedPluginConfig, PluginConfigWarn } from './plugin-config.js';
import { startupEntryMounted, startupSetting } from './settings/startup.js';
import { stableStringify } from './stable-stringify.js';
import {
  auditStartupEntries,
  describeDrop,
  optionalEntriesOf,
  type StartupAuditOptions,
} from './startup-audit.js';

/** 一條 thread 組裝用的那份清單。 */
export interface ThreadPluginList {
  /**
   * 這一次讀出來的結果，`plugins` 與 `rows` 已換成標過已知掉了的列的那一份：查 id 與模組名（`assemblyDropsOf`、
   * `describeWarnings`）、會話 header 的清單與雜湊（`entries`）都從這裡拿。
   */
  readonly loaded: LoadedPluginConfig;
  /** 交給組裝的清單：已知掉了、宣告沒變的列標成 `disabled: true`。 */
  readonly plugins: readonly PluginEntry[];
  /** 這一份裡可以少掛的條目（`optionalEntriesOf`）。 */
  readonly optionalEntries: ReadonlySet<PluginEntry>;
}

/** {@link createThreadPluginList} 的輸入。 */
export interface ThreadPluginListOptions {
  /** 讀一次清單，同啟動那一次的 `loadDefaultPlugins` 與參數，警告交給 `warn`。 */
  readonly load: (warn: PluginConfigWarn) => Promise<LoadedPluginConfig>;
  /** 啟動那一次讀出來的結果。 */
  readonly startup: LoadedPluginConfig;
  /** 啟動試組掉了的條目（取自 `startup.plugins`；組裝點自己加的外掛不在清單上，略過）。 */
  readonly trialDropped: Iterable<PluginEntry>;
  /** 必掛名單怎麼算，同啟動那一次。 */
  readonly audit: StartupAuditOptions;
  /** 起動期讀一次的設定列：值以啟動那一份為準，重讀時不同就記「已儲存，待重啟」。 */
  readonly startupRead: readonly NexusPlugin<unknown>[];
  /** 伺服器日誌。 */
  readonly log: (line: string) => void;
}

/** 讀清單的那一支。 */
export interface ThreadPluginReader {
  /**
   * 讀一次，給一條要組裝的 thread。
   *
   * @returns 那條 thread 用的清單。
   * @throws {PluginConfigError} 任何一層讀不了、形狀不合；必掛的列掉了是其中的 `StartupError`，訊息同啟動那一次。
   */
  read(): Promise<ThreadPluginList>;
  /**
   * 組裝之後交回這一條掉了的條目。啟動試組掉過的列，宣告改了重試又掉，新的宣告記成已知，之後的 thread 不再試。
   *
   * @param list - 這一條用的那份（{@link read} 的回傳）。
   * @param dropped - 組裝時掉了的條目。
   */
  noteDropped(list: ThreadPluginList, dropped: readonly { readonly entry: PluginEntry }[]): void;
}

/**
 * 建一支每條 thread 重讀清單的讀取器。
 *
 * @param options - 啟動那一份、試組掉了的列、起動期讀的列、伺服器日誌。
 * @returns 讀取器。
 */
export function createThreadPluginList(options: ThreadPluginListOptions): ThreadPluginReader {
  const { startup, audit, log } = options;
  // 已知掉了的列，鍵是列 id 加那一列疊完的宣告，宣告一改鍵就不同。讀清單時掉的（`known`）由 `loadDefaultPlugins` 自己
  // 標成停用，這裡只管講不講；試組在組裝時才掉的（`knownAssembly`）要這裡標成停用，以後的 thread 才不重試。
  const known = new Set<string>();
  for (const drop of startup.dropped) known.add(rowKey(startup, drop.id));
  const knownAssembly = new Set<string>();
  // 啟動試組掉過的列 id：只有它們重試又掉時記新的宣告。
  const assemblyIds = new Set<string>();
  for (const entry of options.trialDropped) {
    const id = startup.rows.get(entry)?.id;
    if (id === undefined) continue;
    assemblyIds.add(id);
    knownAssembly.add(rowKey(startup, id));
  }
  // 讀清單的警告，同一句只記一次。
  const warned = new Set<string>();
  const warn: PluginConfigWarn = (message) => {
    if (warned.has(message)) return;
    warned.add(message);
    log(`[清單] ${message}`);
  };
  const running = options.startupRead.map((plugin) => ({
    plugin,
    snapshot: snapshotOf(startup.plugins, plugin),
  }));
  // 已經講過「待重啟」的那個值，同一個值不再講；改回執行中的值就清掉。
  const reported = new Map<string, unknown>();

  return {
    async read() {
      const loaded = await options.load(warn);
      auditStartupEntries(loaded, audit);
      for (const drop of loaded.dropped) {
        const key = rowKey(loaded, drop.id);
        if (known.has(key)) continue;
        known.add(key);
        log(`[清單] 這一列沒掛上，之後的 thread 也不掛，直到它的設定改了：${describeDrop(drop)}`);
      }
      const rows = new Map(loaded.rows);
      const plugins = loaded.plugins.map((entry) => {
        const row = loaded.rows.get(entry);
        if (row === undefined || entry.disabled === true) return entry;
        if (!knownAssembly.has(rowKey(loaded, row.id))) return entry;
        const off: PluginEntry = { ...entry, disabled: true };
        rows.set(off, row);
        return off;
      });
      reportStartupDrift(plugins);
      const view: LoadedPluginConfig = { ...loaded, plugins, rows };
      return { loaded: view, plugins, optionalEntries: optionalEntriesOf(view, audit) };
    },
    noteDropped(list, dropped) {
      for (const { entry } of dropped) {
        const id = list.loaded.rows.get(entry)?.id;
        if (id !== undefined && assemblyIds.has(id)) knownAssembly.add(rowKey(list.loaded, id));
      }
    },
  };

  function reportStartupDrift(plugins: readonly PluginEntry[]): void {
    for (const { plugin, snapshot } of running) {
      const next = snapshotOf(plugins, plugin);
      if (isDeepStrictEqual(next, snapshot)) {
        reported.delete(plugin.name);
        continue;
      }
      if (reported.has(plugin.name) && isDeepStrictEqual(reported.get(plugin.name), next)) continue;
      reported.set(plugin.name, next);
      log(
        `[清單] 「${plugin.name}」改了，已儲存，待重啟：這一列在啟動時讀一次，新對話照舊用啟動時的值`,
      );
    }
  }
}

/** 一列的鍵：id 加那一列疊完的宣告（`entries` 照宣告留著，連讀清單時掉了的列也在）。 */
function rowKey(loaded: Pick<LoadedPluginConfig, 'entries'>, id: string): string {
  const declared = loaded.entries.find((entry) => entry.id === id);
  return `${id}\0${declared === undefined ? '' : stableStringify(declared)}`;
}

/** 起動期讀的一列在這份清單上的樣子：掛沒掛、讀出來的值；讀不出來就記原因。 */
function snapshotOf(plugins: readonly PluginEntry[], plugin: NexusPlugin<unknown>): unknown {
  try {
    return {
      mounted: startupEntryMounted(plugins, plugin),
      value: startupSetting(plugins, plugin),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
