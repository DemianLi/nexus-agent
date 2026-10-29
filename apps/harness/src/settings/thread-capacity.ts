/**
 * serve 行程裡 thread 數上限與閒置逐出的**設定條目**（[#1476](https://github.com/DemianLi/nexus-agent/issues/1476)，
 * 「底座保險絲」逐級降載的第 2 級；背景是 [#1464](https://github.com/DemianLi/nexus-agent/issues/1464)：
 * 每條 thread 常駐約 1.2 MB heap（#1983，Linux）、讀歷史也有。第 1 級 [#1484](https://github.com/DemianLi/nexus-agent/issues/1484) 讓閒置夠久的 thread 被撤掉，
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
 * ## 出廠打開（[#1619](https://github.com/DemianLi/nexus-agent/issues/1619)，demian 2026-10-18 拍板，推翻 #1476 Q2、#1484 Q3）
 *
 * 兩格出廠都有值，寫在 schema 的 `.default()`，`cordis.yml` 那一列照抄同一組讓人看得到（`plugin-config.test.ts` 釘兩邊相等）：
 *
 * - **`maxThreads` 500**，正整數，沒有「不限」。**偏離：理由 2（產品需求超出 dsh）**——dsh 沒有會話數上限，所以也沒有可照抄的數字。
 *   推法：dsh 記憶體 bench 最小的機型是 4 GB（`docs/defensive-patterns/general.zh.md:184`，`687f282e`）；**假設**留一半給主機上的
 *   其他人（假設，不是量的），serve 約有 2 GB。thread 開到撐不住時先用完的是 V8 heap：死點約等於 heap 上限 ÷ 每條約 1.2 MB
 *   （#1983，Linux、發版包、短 thread、不掛 MCP、逐出關掉），2 GB 的容器死在 800–826 條，500 對它留約四成餘裕，只對短 thread 成立。
 *   **這是後盾，不是記憶體保證**：長對話每輪還要再加幾 MB，thread 數上限擋得住「很多」、擋不住「很長」，後者歸 #1490、#1493。
 *   定得寬，因為讀歷史也佔名額，定太低正常使用就會被擋；逐出打開之後名額會自己回來。
 *   「沒有不限、最小 1」照 dsh 各入口的上限（`jobs-local` 的 `maxConcurrentJobsPerOwner`、`terminal-controller` 的 `maxTerminals`、
 *   `subagent` 的 `maxActiveSubagents`，都是 `min(1)` 加有限的預設）。
 * - **`idleEvictAfterMs` 7 200 000（2 小時）**，非負整數，**`0` 表示不逐出**。照 dsh 終端的 `unattendedTimeoutMs`
 *   （`packages/api/terminal-controller/src/index.ts:90`：`min(0)`、`default(7_200_000)`；`0` 不回收在 `retention.ts:101`，`687f282e`），不算偏離。
 *   時間是從沒有人看著開始算的（閒置條件含「沒有下行訂閱者」），所以 2 小時是使用者關掉頁籤之後的 2 小時。
 *
 * 兩格的上界都是 `Number.MAX_SAFE_INTEGER`，同 dsh 那幾格。
 *
 * ## 閒置逐出的語意（#1484）
 *
 * 一條 thread **所有閒置條件同時成立**連續滿 T 才被撤掉，中途任何一條不成立就歸零。
 * 閒置條件、撤的順序與取捨見 `../wire-handler.ts` 的 `WireHandlerOptions.idleEvictMs`。
 *
 * **撤掉＝等價於重啟 serve 的那一半**：磁碟上的日誌是真相，之後有人再開這條 thread 就走今天重啟之後的路徑重組。所以有三個代價要先知道：
 * 被撤的 thread 之後重組會拿**當下**的設定（不是它上一次組裝時的）；行程記憶體裡的續行授權、上傳收據、`present` 交付表都隨之消失；
 * 下行要重連（web 的重連路本來就有）。要在整段對話裡釘住組裝它的那一版，設 `idleEvictAfterMs: 0`。
 *
 * **只有開了落盤（`session-persistence`）才生效**：沒有落盤的日誌只在記憶體裡，撤掉就沒了。啟動日誌一律印一行講逐出是哪一種狀態
 * （閒置 T 毫秒後撤出、設成 0 不逐出、沒有落盤不逐出），管理者從日誌就分得出出廠值和自己改過的值。
 *
 * ## 這一列關不掉
 *
 * 兩格都有 schema 預設之後，`startupSetting` 把關掉的列當成沒有那一列、值回到 schema 的預設，也就是**上限與逐出都還在**——
 * `disabled: true` 讀起來卻像把保險絲拆了。所以它在 `PROTECTED_ENTRY_NAMES` 上，寫 `disabled: true` 在啟動當場拋錯，同 `downlink`
 * 那一列（#1504）的前例；dsh 那幾個入口的上限也都沒有關閉開關。**要放寬，把數值調大；要關逐出，設 `0`**。
 *
 * 預設放在 schema 而不是只寫在 `cordis.yml`，是因為 patch 的 `config` 是**整份替換**：只寫一格（例如照舊文件的 `maxThreads: 200`）的
 * 部署，另一格要由 schema 補上，不能升級之後靜靜消失。
 *
 * @module
 */

import { z } from 'zod';

import type { NexusPlugin, PluginRegistry } from '@nexus/core';

/** 這一列在訊息裡叫什麼。 */
export const THREAD_CAPACITY_PLUGIN_NAME = 'thread-capacity';

/** 出廠的 thread 數上限，推法見檔頭（理由 2）。 */
export const DEFAULT_MAX_THREADS = 500;

/** 出廠的閒置逐出時間：2 小時，照 dsh 終端的 `unattendedTimeoutMs`。 */
export const DEFAULT_IDLE_EVICT_AFTER_MS = 7_200_000;

/** `strictObject`：多寫一個欄位是打錯字，同其他幾列。 */
export const threadCapacityConfigSchema = z.strictObject({
  /** 行程裡最多同時有幾條 thread（含建構中的）。正整數，沒有「不限」：要放寬就調大。 */
  maxThreads: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_THREADS),
  /**
   * 一條 thread 閒置多久（毫秒）之後被撤出行程記憶體；`0` 是不逐出。非負整數。只有開了落盤才生效，見檔頭。
   * 撤掉後再開這條 thread 會照重啟後的路徑重組，所以**不要設得比一個人離開座位的時間短**。
   */
  idleEvictAfterMs: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .default(DEFAULT_IDLE_EVICT_AFTER_MS),
  /**
   * 會話日誌額度（#2115，`../session-log-budget.ts`）：同時開著與正在讀的會話日誌合計最多幾 MiB，超過的在讀之前拒收。
   * **不寫就照記憶體上限自動算**（出廠）；寫正整數就固定成那個數；`0` 是不限（回到不看大小的讀法，大日誌可能把整個行程撐死）。
   * serve 與 CLI 都讀這一格（這一列其餘的格只有 serve 用）。自動算的值見 serve 啟動輸出那一行 `會話日誌額度：…`。
   */
  sessionLogBudgetMiB: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
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
