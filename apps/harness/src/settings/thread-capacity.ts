/**
 * serve 行程裡 thread 數上限的**設定條目**（[#1476](https://github.com/DemianLi/nexus-agent/issues/1476)，
 * 「底座保險絲」逐級降載的第 2 級；背景是 [#1464](https://github.com/DemianLi/nexus-agent/issues/1464)：
 * 每條 thread 常駐約 2 MB heap、讀歷史也有，而且 serve 不回收）。檢查本體在 `../wire-handler.ts` 的 `threadFor`。
 *
 * **這一顆不裝功能，只講設定**，`apply` 是空的，同 `thread-search` 那一列：值由 `startupSetting` 在起動期讀出來，
 * 交給 `createWireHandler`。**改了要重啟 serve**（分類 `startup-read`，`plugin-row-classes.ts`）。
 *
 * ## 偏離 dsh：產品需求超出 dsh
 *
 * **dsh 沒有 thread 數上限**（`grep` 不到任何一處對會話數設限）。這一列是 serve 跑在多人共用的內網主機上、
 * 而 thread 不回收（#1464）才有的需求，登記為「產品需求超出 dsh」。它借的是 dsh 背景工作准入的形狀
 * （`packages/jobs/jobs-local/src/index.ts:221-223`，`1517a4db`：`start()` 在建立任何資源之前先比 `active >= maxConcurrentJobsPerOwner`；
 * 決策紀錄 `.agents/notes/archived/bug-fix/2026-08-11-bounded-background-job-admission.zh.md`），逐點對到我們：
 *
 * 1. 數量從權威紀錄現算，不另存一份計數——數 `threads.size`。
 * 2. 在建立任何資源之前拒絕——`createAgent` 之前，也不 `set`。
 * 3. 拒絕不留下任何紀錄——`threads` 上沒有這一條。
 * 4. 還在收尾的照樣佔名額——建構中的 promise 佔名額，建失敗刪掉才釋放。
 * 5. 錯誤訊息寫出上限，也寫出下一步——「重啟 serve 才會釋放」。
 * 6. 不排隊、不搶占、不自動終止最舊的（決策紀錄明確否決）。
 *
 * dsh 按 owner（Agent 物件）分桶；我們數的是 thread 本身，所以全行程一桶。
 *
 * ## 預設不設上限
 *
 * `maxThreads` 不寫就不限，行為與沒有這一列一樣（demian 2026-10-16 拍板）。Linux 的單條 thread 記憶體還沒量，
 * 給數字沒有依據；預設打開的話，既有部署會在某一天突然開始拒收。
 *
 * ## 這一列關得掉，而且關掉就是不限
 *
 * 跟 `thread-title` 那幾列相反，這一列**不在** `PROTECTED_ENTRY_NAMES` 上：`startupSetting` 把關掉的列當成沒有，
 * 回 schema 預設，而這裡的預設正是「不限」——所以 `disabled: true` 的字面意思（沒有這道保險絲）與實際行為一致，
 * 不會讓人以為自己關掉了什麼卻沒關掉。
 *
 * @module
 */

import { z } from 'zod';

import type { NexusPlugin, PluginRegistry } from '@nexus/core';

/** 這一列在訊息裡叫什麼。 */
export const THREAD_CAPACITY_PLUGIN_NAME = 'thread-capacity';

/** `strictObject`：多寫一個欄位是打錯字，同其他幾列。 */
export const threadCapacityConfigSchema = z.strictObject({
  /** 行程裡最多同時有幾條 thread（含建構中的）；不寫就不限。正整數。 */
  maxThreads: z.number().int().positive().optional(),
});

/** 驗過的設定。 */
export type ThreadCapacityConfig = z.infer<typeof threadCapacityConfigSchema>;

/** 只講設定的那一顆，見檔頭。 */
export const threadCapacityPlugin: NexusPlugin<ThreadCapacityConfig> = {
  name: THREAD_CAPACITY_PLUGIN_NAME,
  Config: threadCapacityConfigSchema,
  apply: (_registry: PluginRegistry, _config: ThreadCapacityConfig): void => {
    // 空的：組裝期沒有消費者。
  },
};

export default threadCapacityPlugin;
