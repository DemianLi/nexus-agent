/**
 * 工具結果的 `meta` 與壓縮摘要全文放上線的位元組上限的**設定條目**（[#538](https://github.com/DemianLi/nexus-agent/issues/538)／
 * [#457](https://github.com/DemianLi/nexus-agent/issues/457)）。
 *
 * **這一顆不裝功能，只講設定**，`apply` 是空的，同 `thread-title`／`browser-session`／
 * `deliverable-files` 那三列。
 *
 * ## 這一格管什麼（[#736](https://github.com/DemianLi/nexus-agent/issues/736) 之後）
 *
 * - **工具結果的 `meta`**：搜尋與改檔的上限就是 `maxBytes`，讀檔是它的兩倍（`tool-result-text.ts` 的 `capToolResultMeta`）。
 * - **壓縮標記的摘要全文**（[#896](https://github.com/DemianLi/nexus-agent/issues/896)）：`compactionData` 用 `capToolText`
 *   截到 `maxBytes`，超過取頭尾、中間一句說明。
 *
 * **工具結果文字不再歸它管。** 這一格原本是結果文字放上線的上限，那是「沒有外溢、日誌保全文」時登記的偏離；外溢層
 * （[#719](https://github.com/DemianLi/nexus-agent/issues/719)）落地後日誌記的就是換過的預覽，#736 照 dsh 拿掉了傳輸上的截斷。
 * 文字的上限現在在模型面，由 `spill-policy` 那一列與讀檔自己的上限決定，見 `tool-result-text.ts` 的檔頭。
 *
 * **名字沒跟著改**：`tool-text` 與 `maxBytes` 已經寫在部署自己的 `cordis.patch.yml` 裡，改名會讓那些 patch 在載入期失敗；
 * 它管的仍是「一段會被截斷放上線的文字或結構」這一類。
 *
 * ## 層：起動期解一次，往下傳
 *
 * 消費點有兩個，都跑在請求期：`ThreadPump`（即時那條，`#noteVerdict` 的 meta 與壓縮摘要）與 `historyFrames`
 * （重播那條）。**兩個都拿不到註冊表**——`ThreadPump` 自己 `new SessionRegistry`，另一邊是
 * 匯出的純函式。但層級不是障礙：兩條的產品入口都在 `createWireHandler` 的閉包裡
 * （`wire-handler.ts` 的 `new ThreadPump(...)` 與唯一那次 `historyPage(...)`），而那個閉包
 * 一台伺服器跑一次。所以值在起動期解一次、往下傳一份，同 `deliverable-files`。
 *
 * **散文上要小心一件事**：這不是「起動期的值」，是**起動期解出來、穿進一個 per-thread 物件**
 * 的值。`ThreadPump` 一條 thread 一顆，拿到的是同一份設定。
 *
 * ## 與 dsh 的關係
 *
 * 50000 當初抄的是 dsh base bundle `spill-policy` 的 `maxInlineBytes: 50000`（`ddefc45`）。dsh 在 `477b4f4` 已改成
 * `maxInlineTokens: 12500`（`packages/bundle/base/cordis.patch.yml:407-410`，對 `c1b47e4`），而那一格對應的是我們
 * `spill-policy` 那一列，不是這一列。
 *
 * 這一列今天管的兩件事，dsh 都**不在傳輸上截**：搜尋的 `meta` 由搜尋工具在生產端自己限（`dsh-tool-fs-search` 的
 * `searchMetaMaxBytes`，預設 65536，`packages/fs/tool-fs-search/src/search-core.ts:65`），讀檔與 diff 的 `meta` 沒有上限。
 * 我們截在放上線那一刻，那條偏離登記在 `tool-result-text.ts` 的 `capToolResultMeta` 上，#736 不動它。
 *
 * ## 這一列關不掉
 *
 * `disabled: true` 在載入期當場拋。理由同起動期那幾列：關掉它不會讓 meta 與摘要不再被截，
 * `startupSetting` 把關掉的那一列當成沒有那一列，值回到 schema 的預設，行為一個位元組都不變。
 *
 * ## 一頁歷史的那條比例只保證到預設值為止
 *
 * `@nexus/wire` 的 `HISTORY_PAGE_MAX_BYTES = 8_000_000` 是照每張工具卡的最壞值算的：一張卡是結果文字加給專屬卡的
 * `meta`。`meta` 的上限是這一格（搜尋、diff，[#617](https://github.com/DemianLi/nexus-agent/issues/617)）或它的兩倍
 * （讀檔，[#630](https://github.com/DemianLi/nexus-agent/issues/630)）；文字的上限自 #736 起由生產者決定，最壞值怎麼算
 * 寫在 `HISTORY_PAGE_MAX_BYTES` 的說明上。wire 不能往上 import harness，所以那個關係由 `apps/harness` 的一條
 * 測試逐字釘著。**這一列讓那個關係只在 schema 預設下成立**：部署在 patch 裡改掉
 * {@link DEFAULT_TOOL_TEXT_MAX_BYTES} 之後，一頁能裝幾張卡跟著變，而且沒有任何東西會紅。
 *
 * 那是 #538 三選一裡**明著選的第三條**（2026-09-23 拍板），不是漏掉的：另外兩條分別要把協定
 * 常數變成設定、或讓 wire 反過來收 harness 注入的值，兩條都在動協定層的形狀。dsh 那側沒有
 * 先例可抄——它的歷史分頁按**則數**算（`packages/api/session-controller/src/history.ts:38` 的
 * `DEFAULT_MAX_MESSAGES = 50`），組頁路徑上一個位元組預算都沒有，所以那兩個值在 dsh 沒有
 * 共同單位可以做比例。唯一偏向性的證據是 dsh 的 house style：**每個 cap 對自己負責**，沒有
 * 任何一處參照另一個 cap。
 *
 * **可設定之後仍然守得住的**（#538 的驗收下限）：`serve-history.test.ts` 那條產品路徑的
 * warn——「超標的一頁走過 route 會 warn」——照樣證明得了。它的 seed 造 170 則各 50000 位元組的結果，文字自 #736
 * 起原樣上線，所以那個 seed 撐不撐得破 8 MB 跟這一格無關；那條測試旁邊有一條**顯性的前提斷言**，seed 哪天
 * 小到不再超標，它會當場紅，而不是靜靜變成一條什麼都沒測的綠燈。
 *
 * @module
 */

import { z } from 'zod';

import type { NexusPlugin, PluginRegistry } from '@nexus/core';

/** 這一列在訊息裡叫什麼。 */
export const TOOL_TEXT_PLUGIN_NAME = 'tool-text';

/**
 * 這一列 `maxBytes` 的預設（UTF-8 位元組）：搜尋與改檔 `meta` 的上限、讀檔 `meta` 上限的一半、壓縮摘要全文的上限。
 *
 * 數字是當初照 dsh `spill-policy` 的 `maxInlineBytes: 50000` 抄的（見檔頭「與 dsh 的關係」）。摘要超過時取頭尾各半，
 * 中間換成一行通知，**含通知在內**不超過這個數。
 */
export const DEFAULT_TOOL_TEXT_MAX_BYTES = 50_000;

/**
 * 一格。`strictObject`：多寫一個欄位是打錯字，不是擴充點。
 *
 * **下限 128 是量出來的，不是挑一個看起來安全的數**（2026-09-23，對一段 5000 位元組的原文）：
 *
 * | `maxBytes` | 結果 |
 * | --- | --- |
 * | 128 | 128 位元組，通知完整，**而且頭尾還留得下原文** |
 * | 64 | 64 位元組，通知完整，但一個原文字元都留不住 |
 * | 40 | 通知**自己**被截斷（`沒有送出來` 那幾個字不見了） |
 *
 * 所以 128 是「還講得出發生什麼事、而且還看得到一點原文」的量級。低於它不會壞掉——
 * `capToolText` 的 `budget <= 0` 那條分支本來就在——但會安靜地變成「整段只剩一句殘缺的
 * 說明」，那不是任何人設定這一格時想要的東西。
 */
export const toolTextConfigSchema = z.strictObject({
  /** 見 {@link DEFAULT_TOOL_TEXT_MAX_BYTES}。 */
  maxBytes: z.number().int().min(128).default(DEFAULT_TOOL_TEXT_MAX_BYTES),
});

/** 驗過的設定。 */
export type ToolTextConfig = z.infer<typeof toolTextConfigSchema>;

/** 只講設定的那一顆，見檔頭。 */
export const toolTextPlugin: NexusPlugin<ToolTextConfig> = {
  name: TOOL_TEXT_PLUGIN_NAME,
  Config: toolTextConfigSchema,
  apply: (_registry: PluginRegistry, _config: ToolTextConfig): void => {
    // 空的，見檔頭：組裝期沒有消費者。
  },
};

export default toolTextPlugin;
