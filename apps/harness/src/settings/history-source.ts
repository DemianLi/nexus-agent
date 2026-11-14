/**
 * 模型歷史從哪裡來的**設定條目**（[#2355](https://github.com/DemianLi/nexus-agent/issues/2355)）。
 *
 * 形狀同 `recursion-limit`：消費點在組裝期（`agent-factory.ts`），`apply` 把驗過的值提供成 {@link HISTORY_SOURCE_SERVICE}，
 * 組裝點去讀；CLI 的 `--history-source` 在組裝點蓋過這一列。值的意思見 `@nexus/core` 的 `history-shadow.ts`：
 *
 * - `state`：把 LangGraph state 原樣送給模型，什麼都不掛。裸組裝（不掛這一列、也沒有入口幫忙給預設）的值就是它，見 {@link DEFAULT_HISTORY_SOURCE}。
 * - `shadow`：送的仍是 state，另在 root 緊貼請求快照外側拿從日誌推出來的歷史比一次；不是 `match` 的那幾次 serve 走伺服器日誌的
 *   `history-shadow` logger（debug 等級），CLI 印在標準錯誤；計數留在組裝點拿到的 tally。都不寫進會話日誌。
 * - `log`（出廠）：在同一格拿從日誌推出來的歷史換掉要送的那一串；找不到日誌、推不出來，這次呼叫就失敗，不退回 state。
 *   只講 root：子代理仍走 state（`fold.ts` 的 `historyFromLog` 宣告 `rootOnly`）。
 *
 * **關得掉，關掉就是沒人講**：入口（CLI、serve、背景冷啟、樹上入口，都走 `createCliAgent`）給的預設是 `log`，所以關掉或整列掉下來
 * 落到 `log`，**不等於寫 `state`**；要 `state` 就在這一列明寫 `source: state`，或帶 `--history-source state`。
 *
 * @module
 */

import { z } from 'zod';

import { HISTORY_SOURCES } from '@nexus/core';
import type { HistorySource, NexusPlugin, PluginRegistry } from '@nexus/core';

/** 這一列在訊息裡叫什麼。 */
export const HISTORY_SOURCE_PLUGIN_NAME = 'history-source';

/** 驗過的值，由 `#settings/history-source` 提供。 */
export const HISTORY_SOURCE_SERVICE = 'historySource';

/**
 * **裸組裝**的值：`createNexusAgent` 沒被明著傳、清單上也沒有這一列、呼叫端也沒給預設時用它。裸組裝不掛會話日誌，`log` 在那裡
 * 一次模型呼叫都過不了，所以它維持 `state`。跟 {@link HISTORY_SOURCE_ROW_DEFAULT} 是兩件事，值也不同。
 */
export const DEFAULT_HISTORY_SOURCE: HistorySource = 'state';

/**
 * **這一列沒寫 `source` 時的值**，也是四個入口（`createCliAgent`）在這一列關掉、掉下來時給的預設：出廠值。
 */
export const HISTORY_SOURCE_ROW_DEFAULT: HistorySource = 'log';

/** 一格。`strictObject`：多寫一個欄位是打錯字，不是擴充點。 */
export const historySourceConfigSchema = z.strictObject({
  source: z.enum(HISTORY_SOURCES).default(HISTORY_SOURCE_ROW_DEFAULT),
});

/** 驗過的設定。 */
export type HistorySourceConfig = z.infer<typeof historySourceConfigSchema>;

declare module '@nexus/core' {
  interface NexusServices {
    /** 模型歷史從哪裡來，由 `#settings/history-source` 提供。沒人提供時是 `undefined`，組裝點落回呼叫端給的預設，再沒有就是 {@link DEFAULT_HISTORY_SOURCE}。 */
    historySource: HistorySource;
  }
}

/** 只講設定的那一顆，見檔頭。 */
export const historySourcePlugin: NexusPlugin<HistorySourceConfig> = {
  name: HISTORY_SOURCE_PLUGIN_NAME,
  Config: historySourceConfigSchema,
  apply: (registry: PluginRegistry, config: HistorySourceConfig): void => {
    registry.services.provide(HISTORY_SOURCE_SERVICE, config.source);
  },
};

export default historySourcePlugin;
