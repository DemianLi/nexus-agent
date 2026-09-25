/**
 * 一段工具結果文字放上線的位元組上限的**設定條目**（[#538](https://github.com/DemianLi/nexus-agent/issues/538)／
 * [#457](https://github.com/DemianLi/nexus-agent/issues/457)）。
 *
 * **這一顆不裝功能，只講設定**，`apply` 是空的，同 `thread-title`／`browser-session`／
 * `deliverable-files` 那三列。
 *
 * ## 層：起動期解一次，往下傳
 *
 * 消費點有兩個，都跑在請求期：`ThreadPump.#noteVerdict`（即時那條）與 `historyFrames`
 * （重播那條）。**兩個都拿不到註冊表**——`ThreadPump` 自己 `new SessionRegistry`，另一邊是
 * 匯出的純函式。但層級不是障礙：兩條的產品入口都在 `createWireHandler` 的閉包裡
 * （`wire-handler.ts` 的 `new ThreadPump(...)` 與唯一那次 `historyPage(...)`），而那個閉包
 * 一台伺服器跑一次。所以值在起動期解一次、往下傳一份，同 `deliverable-files`。
 *
 * **散文上要小心一件事**：這不是「起動期的值」，是**起動期解出來、穿進一個 per-thread 物件**
 * 的值。`ThreadPump` 一條 thread 一顆，拿到的是同一份設定。
 *
 * ## 與 dsh 的關係：讓它可設定**沒有偏離**，寫死才有
 *
 * dsh 那側這個值本來就是一列條目的一格：
 *
 * ```yaml
 * - id: spill-policy
 *   name: '@deepseek-ai/dsh-spill-policy'
 *   config:
 *     maxInlineBytes: 50000
 * ```
 *
 * （`packages/bundle/base/cordis.patch.yml:393-396`，`ddefc45`，**數字一模一樣**——我們的
 * 50000 就是照它抄的。）所以這一刀是**把一條既存的偏離收掉**，不是新開一條。
 *
 * **欄位名沒照 dsh 的 `maxInlineBytes`**，因為那個名字描述的是 dsh 的二分（inline 還是進
 * spill 檔），而我們沒有 spill 能力——超過就是截斷，沒有「另一半去哪裡」這回事。叫
 * `maxBytes` 跟 `deliverable-files` 那一列一致，也跟這裡實際發生的事一致。**截在哪一層**
 * 那條偏離仍然登記在 `tool-result-text.ts` 的檔頭上，這一列不重開它。
 *
 * ## 這一列關不掉
 *
 * `disabled: true` 在載入期當場拋。理由同起動期那幾列：關掉它不會讓工具結果不再被截，
 * `startupSetting` 把關掉的那一列當成沒有那一列，值回到 schema 的預設，行為一個位元組都不變。
 *
 * ## 80 倍那條比例只保證到預設值為止
 *
 * `@nexus/wire` 的 `HISTORY_PAGE_MAX_BYTES = 8_000_000` 是 `80 × (50000 ＋ 50000)`——一張卡是結果文字加
 * 給專屬卡的 `meta`，兩者的上限都是這一格（[#617](https://github.com/DemianLi/nexus-agent/issues/617)）——而 wire 不能往上
 * import harness，所以那個關係一直由 `apps/harness` 的一條測試逐字釘著。**這一列讓那個關係
 * 只在 schema 預設下成立**：部署在 patch 裡改掉 {@link DEFAULT_TOOL_TEXT_MAX_BYTES}
 * 之後，80 倍不再成立，而且沒有任何東西會紅。
 *
 * 那是 #538 三選一裡**明著選的第三條**（2026-09-23 拍板），不是漏掉的：另外兩條分別要把協定
 * 常數變成設定、或讓 wire 反過來收 harness 注入的值，兩條都在動協定層的形狀。dsh 那側沒有
 * 先例可抄——它的歷史分頁按**則數**算（`packages/api/session-controller/src/history.ts:38` 的
 * `DEFAULT_MAX_MESSAGES = 50`），組頁路徑上一個位元組預算都沒有，所以那兩個值在 dsh 沒有
 * 共同單位可以做比例。唯一偏向性的證據是 dsh 的 house style：**每個 cap 對自己負責**，沒有
 * 任何一處參照另一個 cap。
 *
 * **可設定之後仍然守得住的**（#538 的驗收下限）：`serve-history.test.ts` 那條產品路徑的
 * warn——「超標的一頁走過 route 會 warn」——照樣證明得了。**但它的前提確實是預設值**：那個
 * seed 造 170 則滿版結果，`170 × 50000` 才撐得破 8 MB，部署把上限調小之後同一個 seed 就不再
 * 超標。所以那條測試旁邊多了一條**顯性的前提斷言**：預設值哪天小到讓 seed 不再超標，它會
 * 當場紅，而不是靜靜變成一條什麼都沒測的綠燈。
 *
 * @module
 */

import { z } from 'zod';

import type { NexusPlugin, PluginRegistry } from '@nexus/core';

/** 這一列在訊息裡叫什麼。 */
export const TOOL_TEXT_PLUGIN_NAME = 'tool-text';

/**
 * 一段結果文字放上線的上限（UTF-8 位元組）。
 *
 * 照 dsh base bundle `spill-policy` 的 `maxInlineBytes`。超過時取頭尾各半，中間換成一行通知，
 * **含通知在內**不超過這個數。
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
