/**
 * serve 記憶體量具的**設定條目**（[#1490](https://github.com/DemianLi/nexus-agent/issues/1490)，demian 2026-10-16 拍板 Q2：
 * 只寫 serve 日誌、啟動一行、之後依間隔一行、預設關閉、不動 `plugin-snapshot.json`）。量具本體與偏離登記見 `../memory-gauge.ts`。
 *
 * **這一顆不裝功能，只講設定**，`apply` 是空的，同 `thread-capacity`：值由 `startupSetting` 在起動期讀出來。**改了要重啟 serve**
 * （分類 `startup-read`，`plugin-row-classes.ts`）。
 *
 * ## 預設關閉，所以這一列關得掉
 *
 * `reportIntervalMs` 預設 `0`＝不啟動量具，除了清單多一列（`[對照快照]` 的列數、`plugin-snapshot.json`、`--dump-config`），serve 的行為與日誌和沒有這一列時一樣（#1490 驗收 B）。
 * `startupSetting` 把關掉的列當成沒有那一列、值回到預設——預設就是「關」，所以關掉這一列與不寫它等價，**不需要**放進
 * `PROTECTED_ENTRY_NAMES`（保險絲類的列才要，因為它們的預設是「開」）。
 *
 * @module
 */

import { z } from 'zod';

import type { NexusPlugin, PluginRegistry } from '@nexus/core';
import { MAX_TIMER_DELAY_MS } from '@nexus/timeout';

/** 這一列在訊息裡叫什麼。 */
export const MEMORY_GAUGE_PLUGIN_NAME = 'memory-gauge';

/** 開了之後最短的間隔：再短只是把日誌灌滿。 */
export const MIN_MEMORY_REPORT_INTERVAL_MS = 1000;

/**
 * 計時器的最大延遲（毫秒）。超過 2³¹−1 時 Node 發 `TimeoutOverflowWarning` 並把間隔改成 1 ms——一個驗得過的設定會讓日誌每毫秒寫一行。
 * 就是 `@nexus/timeout` 的 `MAX_TIMER_DELAY_MS`（照 dsh `packages/util/timeout/src/index.ts:25`）；這個數字在 repo 裡只有那一份。
 */
export const MAX_MEMORY_REPORT_INTERVAL_MS = MAX_TIMER_DELAY_MS;

/** 用量警告門檻的範圍與預設（[#1493](https://github.com/DemianLi/nexus-agent/issues/1493)，demian 2026-10-18 拍板 Q2）。 */
export const MIN_WARN_AT_PERCENT = 1;
export const MAX_WARN_AT_PERCENT = 99;
export const DEFAULT_WARN_AT_PERCENT = 75;

/** `strictObject`：多寫一個欄位是打錯字，同其他幾列。 */
export const memoryGaugeConfigSchema = z.strictObject({
  /**
   * 兩次記憶體日誌之間的毫秒數。`0`（預設）是不啟動量具；開了就是 1000 到 2_147_483_647（計時器上限）的整數，起動時另外立刻寫一行。
   */
  reportIntervalMs: z
    .number()
    .int()
    .max(MAX_MEMORY_REPORT_INTERVAL_MS)
    .default(0)
    .refine((value) => value === 0 || value >= MIN_MEMORY_REPORT_INTERVAL_MS, {
      message: `reportIntervalMs 要嘛是 0（不啟動），要嘛至少 ${String(MIN_MEMORY_REPORT_INTERVAL_MS)}`,
    }),
  /**
   * 用量警告門檻（百分比，1 到 99 的整數，預設 75；[#1493](https://github.com/DemianLi/nexus-agent/issues/1493)，保險絲第 0 級）。
   * **跟著取樣開關走**：`reportIntervalMs` 是 0（取樣關著）就不檢查，這個值被忽略；取樣開了，每次讀數之後和它比，嚴格超過就在日誌警告一次。
   */
  warnAtPercent: z
    .number()
    .int()
    .min(MIN_WARN_AT_PERCENT)
    .max(MAX_WARN_AT_PERCENT)
    .default(DEFAULT_WARN_AT_PERCENT),
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
