/**
 * 清單上一列「變沒變」的兩支判定（[#1406](https://github.com/DemianLi/nexus-agent/issues/1406)）。
 *
 * 從 `thread-plugin-list.ts` 抽出來，是因為「改了、已儲存、待重啟」這句話有兩個說的人：伺服器日誌（每條 thread 重讀
 * 時記一句，`reportStartupDrift`）與 home 底下的快照檔（`plugin-snapshot.ts` 逐列標 `sync`）。**兩個說的人不能各算各的**：
 * 一邊說待重啟、另一邊說沒變，管理員只會以為其中一個壞了。所以判定只在這裡一份。
 *
 * 兩支判定的差別是**比的東西不同，而且不能互換**：
 *
 * - {@link rowKey}：疊完的**宣告**（`entries` 照宣告留著）。宣告字串變了就不同，連「明寫一個等於預設的值」也算變了。用在
 *   「這一列被動過」：已知掉了的列要不要重試、組裝期那幾列是不是「新對話生效」。
 * - {@link snapshotOf}／{@link snapshotsDiffer}：**解析後的值**加上掛沒掛。明寫一個等於預設的值，宣告變了、值沒變，這裡
 *   判沒變。用在起動期讀的那幾列：啟動時讀進去的是值，重讀時值一樣就沒有東西待重啟。
 *
 * @module
 */

import { isDeepStrictEqual } from 'node:util';

import type { NexusPlugin, PluginEntry } from '@nexus/core';

import type { LoadedPluginConfig } from './plugin-config.js';
import { startupEntryMounted, startupSetting } from './settings/startup.js';
import { stableStringify } from './stable-stringify.js';

/**
 * 一列的鍵：id 加那一列疊完的宣告（`entries` 照宣告留著，連讀清單時掉了的列也在）。宣告一改鍵就不同。
 *
 * **宣告用位置找，不用宣告上的 `id`**：`insert` 進來沒寫 id 的列，宣告上沒有 `id`，載入器補了號；停用而且載不進來的列
 * 也是補的號。拿補的號去比宣告上的 `id` 永遠找不到，鍵退化成只剩 id，設定怎麼改都「沒變」。`ids` 與 `entries` 逐位對齊
 * （`LoadedPluginConfig.ids`），所以用 `ids.indexOf(id)` 取同一個位置的宣告。
 *
 * @param loaded - 讀清單的結果（只用 `entries` 與 `ids`）。
 * @param id - 列 id。
 * @returns 鍵；清單上沒有那一列時宣告那一段是空的。
 */
export function rowKey(loaded: Pick<LoadedPluginConfig, 'entries' | 'ids'>, id: string): string {
  const position = loaded.ids.indexOf(id);
  const declared = position < 0 ? undefined : loaded.entries[position];
  return `${id}\0${declared === undefined ? '' : stableStringify(declared)}`;
}

/**
 * `undefined` 與 `{}` 在這裡是同一件事：相容層沒寫 `config` 就是 `{}`，樹那一側為了 strictObject 補的也是 `{}`。
 *
 * @param config - 一列宣告上的 `config`。
 * @returns 沒寫就是 `{}`。
 */
export const normalizedConfig = (config: unknown): unknown => config ?? {};

/**
 * 一列**宣告的簽章**：「是什麼插件、怎麼設定」。輸入是三格（列 id、模組名、設定）；`disabled` 這種跟版本無關的欄位不在
 * 裡面，`undefined` 與 `{}` 算同一份（{@link normalizedConfig}）。序列化用共用的 `stable-stringify.ts`，跟 {@link rowKey}
 * 同一支，所以鍵順序不影響。
 *
 * **兩個人共用這一支**（[#1442](https://github.com/DemianLi/nexus-agent/issues/1442) Q1 (a)）：樹上自我停用的記憶與去重
 * （`plugin-tree.ts`，#1424）、與「活著的設定版本 → 用到它的 thread」那張表（`plugin-live-versions.ts`）。兩邊判「同一份
 * 宣告」的尺不能各寫一把。
 *
 * **輸出含設定明文**，不要原樣往外送：進快照檔的是它的帶鍵雜湊（`session-header-metadata.ts` 的 `hmacHashOf`）。
 *
 * @param id - 列 id。
 * @param module - 模組 specifier，即那一列的 `name`。
 * @param config - 那一列的 `config`。
 * @returns 簽章字串。
 */
export const declarationSignature = (id: string, module: string, config: unknown): string =>
  stableStringify({ id, module, config: normalizedConfig(config) });

/**
 * 起動期讀的一列在這份清單上的樣子：掛沒掛、讀出來的值；讀不出來就記原因。
 *
 * @param plugins - 一份解析好的條目清單。
 * @param plugin - 起動期讀的那顆只講設定的 plugin。
 * @returns 可以拿去比的值（不要往外送：`value` 是設定值）。
 */
export function snapshotOf(plugins: readonly PluginEntry[], plugin: NexusPlugin<unknown>): unknown {
  try {
    return {
      mounted: startupEntryMounted(plugins, plugin),
      value: startupSetting(plugins, plugin),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 兩份 {@link snapshotOf} 的結果不同嗎。**判「已儲存，待重啟」的唯一一處。**
 *
 * @param running - 啟動時那一份。
 * @param next - 現在磁碟上那一份。
 * @returns 不同就是 `true`。
 */
export function snapshotsDiffer(running: unknown, next: unknown): boolean {
  return !isDeepStrictEqual(running, next);
}
