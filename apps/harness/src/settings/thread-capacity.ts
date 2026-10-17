/**
 * serve 行程裡 thread 數上限與閒置逐出的**設定條目**（[#1476](https://github.com/DemianLi/nexus-agent/issues/1476)，
 * 「底座保險絲」逐級降載的第 2 級；背景是 [#1464](https://github.com/DemianLi/nexus-agent/issues/1464)：
 * 每條 thread 常駐約 2 MB heap、讀歷史也有。第 1 級 [#1484](https://github.com/DemianLi/nexus-agent/issues/1484) 讓閒置夠久的 thread 被撤掉，
 * 同一列多一格 `idleEvictAfterMs`）。上限的檢查本體在 `../wire-handler.ts` 的 `threadFor`，逐出在同檔的 `evictThread`。
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
 * 1. 數量從權威紀錄現算，不另存一份計數——數 `threads.size + closing.size`（`closing` 是正在撤的）。
 * 2. 在建立任何資源之前拒絕——`createAgent` 之前，也不 `set`。
 * 3. 拒絕不留下任何紀錄——`threads` 上沒有這一條。
 * 4. 還在收尾的照樣佔名額——建構中的 promise 佔名額，建失敗刪掉才釋放；**撤中的 thread（#1484）也佔名額**，收完才還。
 * 5. 錯誤訊息寫出上限，也寫出下一步——沒設閒置逐出時是「重啟 serve 才會釋放」，設了就說閒置多久會自動釋放。
 * 6. 不排隊、不搶占、不自動終止最舊的（決策紀錄明確否決）。逐出只看閒置，不因為容量滿了去收別人。
 *
 * dsh 按 owner（Agent 物件）分桶；我們數的是 thread 本身，所以全行程一桶。
 *
 * ## 閒置逐出（`idleEvictAfterMs`，#1484）
 *
 * **預設關**——不寫就不逐出，行為與沒有這一格時一樣（demian 拍板，同 `maxThreads` 的理由：Linux 的單條 thread 記憶體還沒量，
 * 給數字沒有依據）。管理者設一個毫秒數 T：一條 thread **所有閒置條件同時成立**連續滿 T 才被撤掉，中途任何一條不成立就歸零。
 * 閒置條件、撤的順序與取捨見 `../wire-handler.ts` 的 `WireHandlerOptions.idleEvictMs`。
 *
 * **撤掉＝等價於重啟 serve 的那一半**：磁碟上的日誌是真相，之後有人再開這條 thread 就走今天重啟之後的路徑重組。所以有三個代價要先知道：
 * 被撤的 thread 之後重組會拿**當下**的設定（不是它上一次組裝時的）；行程記憶體裡的續行授權、上傳收據、`present` 交付表都隨之消失；
 * 下行要重連（web 的重連路本來就有）。
 *
 * **只有開了落盤（`session-persistence`）才生效**：沒有落盤的日誌只在記憶體裡，撤掉就沒了。沒落盤卻設了這一格，啟動時印一行
 * 說「忽略」，不靜靜吞掉。
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
  /**
   * 一條 thread 閒置多久（毫秒）之後被撤出行程記憶體；不寫就不逐出。正整數。只有開了落盤才生效，見檔頭。
   * 撤掉後再開這條 thread 會照重啟後的路徑重組，所以**不要設得比一個人離開座位的時間短**。
   */
  idleEvictAfterMs: z.number().int().positive().optional(),
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
