/**
 * serve 記憶體量具的**設定條目**（[#1490](https://github.com/DemianLi/nexus-agent/issues/1490)，demian 2026-10-16 拍板 Q2：
 * 只寫 serve 日誌、啟動一行、之後依間隔一行、預設關閉、不動 `plugin-snapshot.json`）。量具本體與偏離登記見 `../memory-gauge.ts`。
 *
 * **這一顆不裝功能，只講設定**，`apply` 是空的，同 `thread-capacity`：值由 `startupSetting` 在起動期讀出來。**改了要重啟 serve**
 * （分類 `startup-read`，`plugin-row-classes.ts`）。
 *
 * ## 預設關閉，所以這一列關得掉
 *
 * `reportIntervalMs` 預設 `0`＝不啟動量具，serve 的行為與日誌和沒有這一列時一個字都一樣（#1490 驗收 B）。
 * `startupSetting` 把關掉的列當成沒有那一列、值回到預設——預設就是「關」，所以關掉這一列與不寫它等價，**不需要**放進
 * `PROTECTED_ENTRY_NAMES`（保險絲類的列才要，因為它們的預設是「開」）。
 *
 * @module
 */

import { z } from 'zod';

import type { NexusPlugin, PluginRegistry } from '@nexus/core';

/** 這一列在訊息裡叫什麼。 */
export const MEMORY_GAUGE_PLUGIN_NAME = 'memory-gauge';

/** 開了之後最短的間隔：再短只是把日誌灌滿。 */
export const MIN_MEMORY_REPORT_INTERVAL_MS = 1000;

/** `strictObject`：多寫一個欄位是打錯字，同其他幾列。 */
export const memoryGaugeConfigSchema = z.strictObject({
  /**
   * 兩次記憶體日誌之間的毫秒數。`0`（預設）是不啟動量具；開了就是一個至少 1000 的整數，起動時另外立刻寫一行。
   */
  reportIntervalMs: z
    .number()
    .int()
    .max(Number.MAX_SAFE_INTEGER)
    .default(0)
    .refine((value) => value === 0 || value >= MIN_MEMORY_REPORT_INTERVAL_MS, {
      message: `reportIntervalMs 要嘛是 0（不啟動），要嘛至少 ${String(MIN_MEMORY_REPORT_INTERVAL_MS)}`,
    }),
});

/** 驗過的設定。 */
export type MemoryGaugeConfig = z.infer<typeof memoryGaugeConfigSchema>;

/** 只講設定的那一顆，見檔頭。 */
export const memoryGaugePlugin: NexusPlugin<MemoryGaugeConfig> = {
  name: MEMORY_GAUGE_PLUGIN_NAME,
  Config: memoryGaugeConfigSchema,
  apply: (_registry: PluginRegistry, _config: MemoryGaugeConfig): void => {
    // 空的：組裝期沒有消費者。
  },
};

export default memoryGaugePlugin;
