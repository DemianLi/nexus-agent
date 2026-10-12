/**
 * 「已儲存」與「執行中」的逐列對照，寫成 home 底下一份 JSON 快照檔
 * （[#1406](https://github.com/DemianLi/nexus-agent/issues/1406)，Part of #1385）。
 *
 * ## 回答什麼
 *
 * `--dump-config` 只印磁碟上疊出來的那一份。#1405 之後，改了 home 層的 `cordis.patch.yml`，新對話吃得到組裝期的設定，但
 * 起動期讀一次的 13 列照舊要重啟。管理員看不出「現在跑著的是哪一份」，也看不出哪些已儲存、還沒生效。這份快照逐列回答：
 *
 * | `sync` | 意思 |
 * |---|---|
 * | `same` | 已儲存的跟執行中的沒有差別 |
 * | `next-thread` | 已儲存，新對話生效 |
 * | `restart` | 已儲存，待重啟 |
 *
 * 分類見 `plugin-row-classes.ts`，「待重啟」的判定與日誌那一句共用 `plugin-row-state.ts`。
 *
 * ## 「執行中」是什麼
 *
 * **serve 啟動時讀進去、試組過的那一份**（`startup` ＋試組掉的列）。對起動期讀的 13 列，這就是現在實際生效的；對組裝期
 * 讀的列，它是「啟動時的樣子」，已儲存的那一份已經在新對話生效（`sync` 是 `next-thread`）。
 *
 * ## 不帶什麼（PM 2026-10-12 拍板）
 *
 * **不帶設定值，也不帶 drop 訊息原文。** 一列的 `config` 可能放了秘密，而這台主機是多人共用、瀏覽器會話沒有角色概念。
 * 每列只有 `id`、`module`、`running`、`saved`、`sync`，`running`／`saved` 裡只有 `state` 與 `dropStage`。drop 的原文照舊
 * 只進伺服器日誌（`startup-audit.ts` 的 `describeDrop`）。
 *
 * ## 偏離登記
 *
 * 1. **出口是主機端的檔，不是給 trusted client 的 inventory。** dsh 經 `pluginInventory/list` 給 trusted client
 *    （`packages/host/plugin-inventory/src/index.ts:70-73`）。我們沒有管理員身分，表達不出 trusted；wire 的 `/threads`
 *    底下每個登入的人都看得到。所以退到寫成 home 底下的檔，只有進得了主機的人讀得到，跟 `--dump-config` 同一群人。
 *    管理員身分落地後（#1385 排程第 3 步）改成走那道閘的只讀路由。
 * 2. **「執行中」不從 Loader 讀。** dsh 每次直接讀 `ctx.loader.entries()`，不留快取（`index.ts:85`）。我們的清單不是
 *    Loader 的樹（`cordis-root.ts:25-27`），退到啟動那一份 `LoadedPluginConfig` 加試組結果。決議 §3-5 讓樹由變更紀錄導出
 *    之後，應改回讀 Loader。
 * 3. **沒有 `fiberPhase`**：清單上的列沒有各自的 fiber，用 `mounted`／`disabled`／`dropped`／`absent` 四態取代，掉在哪一步用
 *    `dropStage`。
 * 4. **`dropStage` 在 `running` 與 `saved` 各一份**，不是一個平的欄位：啟動時掉了、改設定之後重試掉在別一步，兩邊會不同。
 * 5. **逐列對照 dsh 沒有**：它只讓客戶端「比較快照」，plugin-manager 只對單次操作回 `applied`／`restart-required`
 *    （`packages/boot/plugin-manager/src/types.ts:121-125`）。這是產品需求，範圍超出 dsh。
 *
 * @module
 */

import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { PluginEntry } from '@nexus/core';

import { resolveHarnessHome } from './harness-home.js';
import type { ConfigEntry, StartupDrop } from './plugin-config.js';
import { classOfRow, STARTUP_READ_PLUGINS } from './plugin-row-classes.js';
import type { RowClass } from './plugin-row-classes.js';
import { rowKey, snapshotOf, snapshotsDiffer } from './plugin-row-state.js';

/** 快照檔在 harness home 底下的檔名。 */
export const PLUGIN_SNAPSHOT_FILE_NAME = 'plugin-snapshot.json';

/** 快照檔的格式版本。 */
export const PLUGIN_SNAPSHOT_VERSION = 1;

/**
 * 快照檔的路徑。
 *
 * @param env - 決定 harness home 落在哪。
 * @returns 絕對路徑。
 */
export function pluginSnapshotPath(env: Readonly<Record<string, string | undefined>>): string {
  return join(resolveHarnessHome(env), PLUGIN_SNAPSHOT_FILE_NAME);
}

/** 一列在某一份清單上的狀態。`absent`＝那一份上沒有這一列。 */
export type RowState = 'mounted' | 'disabled' | 'dropped' | 'absent';

/** 掉在哪一步，同 {@link StartupDrop.stage}。 */
export type DropStage = StartupDrop['stage'];

/** 這一列已儲存的跟執行中的差在哪。 */
export type RowSync = 'same' | 'next-thread' | 'restart';

/** 一列在一份清單上的樣子。**不帶設定值，不帶 drop 原文。** */
export interface PluginSnapshotSide {
  readonly state: RowState;
  /** 只在 `state` 是 `dropped` 時有。 */
  readonly dropStage?: DropStage;
}

/** 快照上的一列。 */
export interface PluginSnapshotRow {
  readonly id: string;
  /** 模組 specifier（那一列的 `name`）。 */
  readonly module: string;
  /** 啟動時讀進去、試組過的那一份。 */
  readonly running: PluginSnapshotSide;
  /** 這一刻磁碟上的那一份。 */
  readonly saved: PluginSnapshotSide;
  readonly sync: RowSync;
}

/** 整份快照。 */
export interface PluginSnapshot {
  readonly version: typeof PLUGIN_SNAPSHOT_VERSION;
  /** 這一份是什麼時候算的（ISO 8601）。 */
  readonly generatedAt: string;
  /** 各種 `sync` 幾列。 */
  readonly summary: Readonly<Record<RowSync, number>>;
  readonly rows: readonly PluginSnapshotRow[];
}

/** 一份清單（啟動那一份，或這一刻磁碟上的那一份）。 */
export interface SnapshotSource {
  /** `LoadedPluginConfig.entries`：磁碟上疊完的宣告，掉了的列也在。 */
  readonly entries: readonly ConfigEntry[];
  /** `LoadedPluginConfig.ids`：`entries` 每一列解析後的 id，一格對一格。 */
  readonly ids: readonly string[];
  /** 交給組裝的清單。 */
  readonly plugins: readonly PluginEntry[];
  /** `plugins` 每一顆的 id 與模組名。 */
  readonly rows: ReadonlyMap<PluginEntry, { readonly id: string; readonly module: string }>;
  /** 掉了的列：讀清單那一步與組裝那一步都在。 */
  readonly drops: readonly Pick<StartupDrop, 'id' | 'stage'>[];
}

interface SideRow {
  readonly module: string;
  readonly state: RowState;
  readonly dropStage?: DropStage;
  readonly entry?: PluginEntry;
}

function sideRows(source: SnapshotSource): Map<string, SideRow> {
  const drops = new Map(source.drops.map((drop) => [drop.id, drop.stage] as const));
  const entries = new Map<string, PluginEntry>();
  for (const entry of source.plugins) {
    const row = source.rows.get(entry);
    if (row !== undefined) entries.set(row.id, entry);
  }
  const result = new Map<string, SideRow>();
  for (const [index, declared] of source.entries.entries()) {
    const id = source.ids[index] ?? declared.id ?? declared.name;
    const stage = drops.get(id);
    const entry = entries.get(id);
    const state: RowState =
      stage !== undefined ? 'dropped' : declared.disabled === true ? 'disabled' : 'mounted';
    result.set(id, {
      module: declared.name,
      state,
      ...(stage !== undefined && { dropStage: stage }),
      ...(entry !== undefined && { entry }),
    });
  }
  return result;
}

/**
 * 算一份快照。純函式：不讀檔、不寫檔、不看時鐘（時間由呼叫端給）。
 *
 * **列的全集從 `entries`／`ids` 走**，不從 `rows` 或 `plugins` 走：模組那一步掉了的列、與停用而且模組載不起來的列不在
 * 那兩份裡，從它們出發列數會跟 `--dump-config` 對不上。順序是啟動那一份的順序，之後才接磁碟上新出現的列。
 *
 * @param input.running - 啟動時讀進去、試組過的那一份。
 * @param input.saved - 這一刻磁碟上的那一份。
 * @param input.generatedAt - 算的時間。
 * @param input.classify - 一列屬於哪一類；省略即 {@link classOfRow}（出貨的表）。測試用它造 `mount-restart` 的列。
 * @returns 快照。
 */
export function buildPluginSnapshot(input: {
  readonly running: SnapshotSource;
  readonly saved: SnapshotSource;
  readonly generatedAt: Date;
  readonly classify?: (id: string, pluginName: string | undefined) => RowClass;
}): PluginSnapshot {
  const running = sideRows(input.running);
  const saved = sideRows(input.saved);
  const ids = [...running.keys(), ...[...saved.keys()].filter((id) => !running.has(id))];
  const rows = ids.map((id): PluginSnapshotRow => {
    const was = running.get(id);
    const now = saved.get(id);
    const pluginName = (now?.entry ?? was?.entry)?.plugin.name;
    const sync = syncOf({
      kind: (input.classify ?? classOfRow)(id, pluginName),
      id,
      pluginName,
      running: input.running,
      saved: input.saved,
      was,
      now,
    });
    return {
      id,
      module: (now ?? was)?.module ?? id,
      running: sideOf(was),
      saved: sideOf(now),
      sync,
    };
  });
  const summary: Record<RowSync, number> = { same: 0, 'next-thread': 0, restart: 0 };
  for (const row of rows) summary[row.sync] += 1;
  return {
    version: PLUGIN_SNAPSHOT_VERSION,
    generatedAt: input.generatedAt.toISOString(),
    summary,
    rows,
  };
}

function sideOf(row: SideRow | undefined): PluginSnapshotSide {
  if (row === undefined) return { state: 'absent' };
  return row.dropStage === undefined
    ? { state: row.state }
    : { state: row.state, dropStage: row.dropStage };
}

function syncOf(input: {
  readonly kind: RowClass;
  readonly id: string;
  readonly pluginName: string | undefined;
  readonly running: SnapshotSource;
  readonly saved: SnapshotSource;
  readonly was: SideRow | undefined;
  readonly now: SideRow | undefined;
}): RowSync {
  const { id, was, now, kind } = input;
  if (kind === 'startup-read') {
    // 起動期讀進去的是**值**：比解析後的值與掛沒掛，不比宣告字串（明寫一個等於預設的值不算變）。
    // 判定與日誌那一句同一支（`snapshotsDiffer`），不另算一套。
    const plugin = STARTUP_READ_PLUGINS.find((candidate) => candidate.name === input.pluginName);
    if (plugin === undefined) return 'same';
    return snapshotsDiffer(
      snapshotOf(input.running.plugins, plugin),
      snapshotOf(input.saved.plugins, plugin),
    )
      ? 'restart'
      : 'same';
  }
  const mountedBefore = was?.state === 'mounted';
  const mountedAfter = now?.state === 'mounted';
  if (kind === 'mount-restart' && mountedBefore !== mountedAfter) return 'restart';
  const declaredSame =
    rowKey({ entries: input.running.entries }, id) === rowKey({ entries: input.saved.entries }, id);
  const same = declaredSame && was?.state === now?.state && was?.dropStage === now?.dropStage;
  return same ? 'same' : 'next-thread';
}

/** 伺服器日誌那一行摘要。 */
export function describeSnapshot(snapshot: PluginSnapshot, path: string): string {
  const { same, restart } = snapshot.summary;
  const next = snapshot.summary['next-thread'];
  return (
    `[對照快照] ${String(snapshot.rows.length)} 列，與執行中相同 ${String(same)}、` +
    `新對話生效 ${String(next)}、待重啟 ${String(restart)}；寫在 ${path}`
  );
}

/** 快照寫檔那一支。 */
export interface PluginSnapshotWriter {
  /**
   * 把一份快照寫進檔。**寫失敗不拋**（記一次警告）：這是給管理員看的對照，不能因為它寫不出來讓 serve 起不來或讓一條
   * thread 建不起來。
   *
   * @param snapshot - 這一次算出來的。
   * @param options.announce - 要不要在這一次記那一行摘要（預設要）。啟動時寫在印出網址之前，摘要留到啟動那幾行
   *   印完再自己記（{@link describeSnapshot}），不插在網址前面；這一次當作「已經講過」，之後只在 `sync` 變了才記。
   * @returns 寫成功了就是 `true`。
   */
  publish(snapshot: PluginSnapshot, options?: { readonly announce?: boolean }): Promise<boolean>;
}

/**
 * 建寫檔的那一支。
 *
 * - **原子**：先寫暫存檔、`sync`、再 `rename` 蓋過去，讀的人只會看到完整的舊檔或完整的新檔。
 * - **暫存檔名帶 pid 與遞增序號**：兩次寫入不會搶同一個暫存檔。
 * - **寫入排成一條鏈**：同時開兩條對話會同時重讀，後來的先落地的話新結果會被舊的蓋掉；排隊之後，檔案裡留下的是
 *   最後一次 `publish` 的那份。
 * - 檔案模式 0600，目錄 0700：只有進得了主機的那個使用者讀得到。
 * - 日誌那一行：第一次一定記（帶路徑），之後只在哪一列的 `sync` 變了才記，不讓每條 thread 都洗一行。
 *
 * @param options.path - 快照檔路徑。
 * @param options.log - 伺服器日誌。
 * @returns 寫檔那一支。
 */
export function createPluginSnapshotWriter(options: {
  readonly path: string;
  readonly log: (line: string) => void;
}): PluginSnapshotWriter {
  const { path, log } = options;
  let tail: Promise<void> = Promise.resolve();
  let sequence = 0;
  let lastDigest: string | undefined;
  const warned = new Set<string>();

  async function write(snapshot: PluginSnapshot, announce: boolean): Promise<boolean> {
    const staging = `${path}.${String(process.pid)}.${String((sequence += 1))}.tmp`;
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const handle = await open(staging, 'w', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(staging, path);
    } catch (error) {
      await rm(staging, { force: true }).catch(() => {});
      const message = error instanceof Error ? error.message : String(error);
      if (!warned.has(message)) {
        warned.add(message);
        log(`[對照快照] 寫不進 ${path}：${message}（serve 照常，下一次重讀再試）`);
      }
      return false;
    }
    const digest = snapshot.rows.map((row) => `${row.id}:${row.sync}`).join('\n');
    if (digest !== lastDigest) {
      lastDigest = digest;
      if (announce) log(describeSnapshot(snapshot, path));
    }
    return true;
  }

  return {
    publish(snapshot, publishOptions = {}) {
      const result = tail.then(() => write(snapshot, publishOptions.announce ?? true));
      tail = result.then(() => undefined);
      return result;
    },
  };
}
