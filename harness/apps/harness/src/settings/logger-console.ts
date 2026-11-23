/**
 * serve 的**伺服器日誌**怎麼印：等級門檻、文字或一行一筆 JSON（[#1534](https://github.com/DemianLi/nexus-agent/issues/1534)）。
 *
 * **這一顆不裝功能，只講設定**，`apply` 是空的，同 `thread-capacity` 那一列：值由 `startupSetting` 在起動期讀出來，交給
 * `../server-log.ts` 的 `mountServerLog`，它把 exporter 掛在 Cordis 根的 logger 上。**改了要重啟 serve**（分類 `startup-read`，
 * `plugin-row-classes.ts`）。只有 `serve` 載這一列（`cordis.serve.yml`）；CLI 的輸出走 `Printer`，不歸它管。
 *
 * ## 對 dsh 的做法
 *
 * 等級在 Cordis 的 logger 層，輸出由一顆 `logger-console` exporter 決定，設定格照 dsh
 * （`vendor/logger-console/src/shared.ts` 的 `ConsoleExporter.Config`）：`levels`（以 logger 名為鍵、`default` 是預設）、`showTime`、
 * `colors`、`maxLength`。文字格式也照 dsh 的 `render`：`yyyy-MM-dd hh:mm:ss [W] serve 訊息`。
 *
 * ### 偏離一：`levels` 收等級**名稱**，不收數字（理由 1：基座表達不出來）
 *
 * dsh 的 Cordis 是自己的 fork，等級順序是 `ERROR 0、INFO 1、WARN 2、DEBUG 3`；nexus vendor 的是上游 rc.11，順序是
 * `ERROR 0、WARN 1、INFO 2、DEBUG 3`（`vendor/cordis/src/logger.ts`）。同一個數字在兩邊意思不同，所以設定寫名稱，
 * 換算在 `../server-log.ts` 的 `LOG_LEVEL_NUMBERS`（一張表、測試對著 vendor 實際行為釘住）。
 *
 * ### 偏離二：多一格 `format: 'json'`（理由 2：產品需求超出 dsh）
 *
 * dsh 的 exporter 只會輸出人讀的文字（`git grep -i json 1517a4db -- vendor/logger-console/src` → 0 筆）。nexus 要把 serve 的 stdout 經 journald
 * 交給內網的日誌平台，所以多一個一行一個 JSON 物件的格式，判準取 JSON Lines；欄位名取 OTel Logs 資料模型的慣用語意，**不引入 OTel SDK、不送出去**。
 * 欄位表見 `docs/operations.md`「伺服器日誌的等級與格式」。
 *
 * 一輪對話失敗的那一行（#1536）另外帶 `thread_id`、`run_id`、`session_id`（背景子代理才有）、`seq`、`code`、`status`、`provider_request_id` 幾個鍵，文字格式的行不看它們；
 * 其他行沒有這幾個鍵。這幾個鍵是同一個偏離的一部分：dsh 沒有 JSON，也就沒有結構化欄位。
 *
 * ### 偏離三：設定住在 `#settings/` 的設定列，不是 Cordis 樹上的一列（理由 2：產品需求超出 dsh；**偏離 #1534 卡面**，PM 於 #1752 裁決）
 *
 * 卡面寫「這一列掛在 Cordis 樹上」，照 dsh：`logger-console` 是樹上一個 plugin，建構時 `ctx.logger.exporter(this)`。
 * **基座做得到樹上那一種**（PM 的探針 C／F／G 都抓到過），所以這不是「基座表達不出來」。
 *
 * 症狀是真的：`ctx.logger.exporter()` 是一個 `ctx.effect`，登記跟著那一列的 fiber 走；根卸載時所有 disposer 並行收，exporter 常常先被收掉，
 * Cordis 在 `_unload` 裡把 disposer 拋的錯記成 `ctx.logger.error` 時它已經不在，錯誤只進緩衝（實測：exporter 掛在根上時
 * `server-log.test.ts` 的「樹上的錯誤印得出來」是紅的，突變 M7）。dsh 樹上的 logger-console 同樣會丟——dsh 不出貨 console exporter，
 * 它自己要留住卸載錯誤的收集器就**放在樹外**：`app-boot/src/index.ts:1207-1212`，另建一個 `diagnostics = new Context()`、
 * `diagnostics.logger = ctx.logger`，再走公開的 `diagnostics.logger.exporter(...)`，註解寫著 "The collector must outlive root disposal to retain asynchronous cleanup errors."。
 *
 * nexus 要在**出貨產品**裡把根卸載時的錯誤印到 console，這是 dsh 沒有的需求，所以是理由 2。退到的做法照 dsh app-boot：exporter 掛在樹外、活過根卸載的 keeper Context 上
 * （`../server-log.ts` 的 `mountServerLog`，只走公開 API，不碰 logger 服務的私有欄位），設定由 `startupSetting` 在清單讀完後解出（同 `thread-capacity`）。
 * 撤除條件：dsh 出貨一顆能活過根卸載的 console exporter 的那一天，改回樹上的一列。
 *
 * 次要的事：serve 在讀清單之前就要記話（代理、home 鎖、變更紀錄那幾行），exporter 要讀完清單才有設定——這一點靠回放緩衝解決
 * （照 dsh，`apps/cli/tests/profiles/web/tests/web-failure-matrix.expected.e2e.ts:52-53`：`ctx.logger.buffer.forEach` 之後才 `ctx.logger.exporter`），
 * 不是非設定列不可的理由。
 *
 * ## 這一列關不掉
 *
 * 全部格都有 schema 預設，`startupSetting` 把關掉的列當成沒有那一列、值回到預設，也就是**日誌照樣印、門檻照樣是 info**——
 * `disabled: true` 讀起來卻像把日誌關了。所以它在 `PROTECTED_ENTRY_NAMES` 上。要少印，把 `levels.default` 調高。
 *
 * @module
 */

import { z } from 'zod';

import type { NexusPlugin, PluginRegistry } from '@nexus/core';

/** 這一列在訊息裡叫什麼。 */
export const LOGGER_CONSOLE_PLUGIN_NAME = 'logger-console';

/** 等級名稱，由輕到重的反向：`debug` 最囉嗦，`error` 最安靜。 */
export const LOG_LEVEL_NAMES = ['error', 'warn', 'info', 'debug'] as const;

/** 一個等級名稱。 */
export type LogLevelName = (typeof LOG_LEVEL_NAMES)[number];

/** 出廠的時間前綴樣板，照 dsh 的 `ConsoleExporter.getDefaults()`；空字串＝不印時間（journald 底下不會重複）。 */
export const DEFAULT_SHOW_TIME = 'yyyy-MM-dd hh:mm:ss ';

/** `strictObject`：多寫一個欄位是打錯字，同其他幾列。 */
export const loggerConsoleConfigSchema = z.strictObject({
  /** `text`：人讀的一行（照 dsh 的 `render`）；`json`：一行一個 JSON 物件，訊息裡的換行留在字串裡。 */
  format: z.enum(['text', 'json']).default('text'),
  /**
   * 門檻，以 logger 名為鍵、值是**等級名稱**；`default` 是沒有單獨寫的 logger 的門檻。一則訊息的等級比門檻**更囉嗦**就不印。
   * 出廠 `{ default: 'info' }`。例：共用主機只留 warn 以上寫 `{ default: warn }`。
   */
  levels: z.record(z.string(), z.enum(LOG_LEVEL_NAMES)).default({ default: 'info' }),
  /** 文字格式的時間前綴樣板（`yyyy-MM-dd hh:mm:ss ` 這種）；空字串不印。JSON 格式一律帶 `ts`，不看這一格。 */
  showTime: z.string().default(DEFAULT_SHOW_TIME),
  /** 文字格式的 ANSI 色階；出廠 `false`（日誌是給 journald 與檔案的）。JSON 格式一律不上色。 */
  colors: z
    .union([z.literal(false), z.literal(0), z.literal(1), z.literal(2), z.literal(3)])
    .default(false),
  /**
   * 一行最多幾個字元，超過的行尾接 `...`（每一行各算，換行不算）。**這同樣會截斷 JSON 的 `msg`**——它是對 `Logger.format` 的結果截的。
   * 省略＝用 vendor 的預設 10240。
   */
  maxLength: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
});

/** 驗過的設定。 */
export type LoggerConsoleConfig = z.infer<typeof loggerConsoleConfigSchema>;

/** 只講設定的那一顆，見檔頭。 */
export const loggerConsolePlugin: NexusPlugin<LoggerConsoleConfig> = {
  name: LOGGER_CONSOLE_PLUGIN_NAME,
  Config: loggerConsoleConfigSchema,
  apply: (_registry: PluginRegistry, _config: LoggerConsoleConfig): void => {
    // 空的：組裝期沒有消費者。
  },
};

export default loggerConsolePlugin;
