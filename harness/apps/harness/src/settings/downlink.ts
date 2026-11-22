/**
 * 下行串流的**心跳間隔與每條線位元組上限**的設定條目（[#1504](https://github.com/DemianLi/nexus-agent/issues/1504)，
 * 「底座保險絲」之外、同一條路上的第二層：卡住的分頁不再讓 serve 的記憶體跟著長，也不再把 thread 的名額釘死）。
 *
 * **這一顆不裝功能，只講設定**，`apply` 是空的，同 `thread-capacity`、`projection-flush` 那幾列：值由 `startupSetting` 在起動期讀出來，
 * 一份交給 `startWireServer`（心跳間隔），一份交給 `createWireHandler`（位元組上限）。**改了要重啟 serve**
 * （分類 `startup-read`，`plugin-row-classes.ts`）。
 *
 * ## 偏離 dsh
 *
 * 逐條登記在別處，這裡只指路：
 *
 * - 偏離 A（SSE 註解行心跳＋「緩衝卡著、連兩拍沒排出去」才斷；理由 1）：`../wire-server.ts` 檔頭。
 * - 偏離 B（事件下行加每條線的位元組上限；理由 2）、偏離 C（超限或死線只斷線、不送終止 frame；理由 1）：`../bounded-event-queue.ts` 檔頭。
 *
 * ## 數值照 dsh，預設開
 *
 * - `heartbeatIntervalMs` 預設 2000，範圍 1 到 2,147,483,647：照 dsh `websocketHeartbeatIntervalMs`
 *   （`packages/api/gateway/src/index.ts:147`、`:156-161`、`:211-215`，`1517a4db`）。「漏 2 拍淘汰」是 dsh 的協定常數
 *   （`MAX_MISSED_HEARTBEATS = 2`，`stream-server.ts:42`），不開成設定。
 * - `maxQueuedBytes` 預設 2 MiB：照 dsh `maxBufferedBytes`（`packages/api/terminal-controller/src/index.ts:87`）。
 *
 * **預設開**（demian 2026-10-17 拍板）：只有不 drain 的線才會被動到，健康的線只多收到看不見的心跳註解行。
 *
 * ## 這一列關不掉
 *
 * 這一列預設是**開著**，`startupSetting` 把關掉的列當成沒有那一列、值回到 schema 的預設，也就是**保護還在**——讀起來卻像把保險絲拆了。
 * （`thread-capacity` 自 #1619 起出廠也開著，照這一列的前例同樣關不掉。）所以它在 `PROTECTED_ENTRY_NAMES` 上，寫
 * `disabled: true` 在啟動當場拋錯（dsh 的三項保護也都沒有關閉開關）。**要放寬，把數值調大**。理由見 `plugin-config.ts`。
 *
 * @module
 */

import { z } from 'zod';

import type { NexusPlugin, PluginRegistry } from '@nexus/core';

import { DEFAULT_DOWNLINK_MAX_BYTES } from '../bounded-event-queue.js';
import {
  DEFAULT_SSE_HEARTBEAT_INTERVAL_MS,
  MAX_SSE_HEARTBEAT_INTERVAL_MS,
} from '../wire-server.js';

/** 這一列在訊息裡叫什麼。 */
export const DOWNLINK_PLUGIN_NAME = 'downlink';

/** `strictObject`：多寫一個欄位是打錯字，同其他幾列。預設值各只有一份，在消費的那一邊。 */
export const downlinkConfigSchema = z.strictObject({
  /** SSE 心跳間隔，毫秒。自然數，範圍同 dsh：1 到 2,147,483,647（`setInterval` 收得下的上界）。 */
  heartbeatIntervalMs: z
    .number()
    .int()
    .min(1)
    .max(MAX_SSE_HEARTBEAT_INTERVAL_MS)
    .default(DEFAULT_SSE_HEARTBEAT_INTERVAL_MS),
  /** 每條下行線排著的位元組上限。正整數。 */
  maxQueuedBytes: z.number().int().positive().default(DEFAULT_DOWNLINK_MAX_BYTES),
});

/** 驗過的設定。 */
export type DownlinkConfig = z.infer<typeof downlinkConfigSchema>;

/** 只講設定的那一顆，見檔頭。 */
export const downlinkPlugin: NexusPlugin<DownlinkConfig> = {
  name: DOWNLINK_PLUGIN_NAME,
  Config: downlinkConfigSchema,
  apply: (_registry: PluginRegistry, _config: DownlinkConfig): void => {
    // 空的：組裝期沒有消費者。
  },
};

export default downlinkPlugin;
