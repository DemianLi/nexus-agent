/**
 * 交付檔那三個上限的**設定條目**（[#457](https://github.com/DemianLi/nexus-agent/issues/457)／
 * [#529](https://github.com/DemianLi/nexus-agent/issues/529)）。
 *
 * **這一顆不裝功能，只講設定**，同目錄那幾列一樣。值的消費者是
 * [`deliverable-files.ts`](../deliverable-files.ts) 的兩個讀檔函式，而**叫它們的是
 * `createWireHandler` 閉包裡的兩條路由**（`wire-handler.ts` 的 `handleDeliverableFile`、
 * `handleDeliverableDownload`）。
 *
 * ## 它在起動期，不在請求期
 *
 * [#529](https://github.com/DemianLi/nexus-agent/issues/529) 的 triage 把這三個值放在「請求期，
 * `ThreadAgent` 才構得到」那一格。**量到的不是那樣**：那兩條路由住在 `createWireHandler(options)`
 * 的閉包裡，而 `createWireHandler` 在 `serve.ts` 被呼叫**一個 server 一次、早於任何 agent 組裝**
 * ——`threadId` 是它們的參數，不是閉包捕獲的東西。所以這一層**沒有註冊表**，跟
 * [`thread-title`](./thread-title.ts) 完全同層（那一列的消費點就在隔壁幾行）。
 *
 * **就算構得到也不該從那裡拿。** 這三個是 **server 的性質，不是一條 thread 的性質**；走
 * `ThreadAgent` 會讓「每條 thread 的交付上限可以不同」變成一個可表達的狀態，而那個狀態沒有意義。
 *
 * ## 與 dsh 的偏離
 *
 * 1. **擁有者是 package-internal specifier（`#settings/deliverable-files`），不是套件名。** 同
 *    {@link ./thread-title.ts | thread-title} 登記過的那一條，四列共用，成因一樣：`apps/harness`
 *    解不到自己。
 * 2. **`apply` 是空的、也不註冊服務**，同起動期那幾列：這一層沒有註冊表可以讀服務，值由
 *    {@link ./startup.ts | startupSetting} 在起動期解一次、往下傳一份。
 *
 * **形狀與數值本身沒有偏離**：dsh 的 `@deepseek-ai/dsh-api-workspace-files` 就是**一顆 plugin 三格**
 * （`packages/api/workspace-files/src/index.ts:185-189`，`ddefc45`），三個預設值逐字相同——
 * `maxBytes` 2 MiB、`maxFileBytes` 32 MiB、`maxLines` 5000。欄位名照它。
 *
 * ## `maxLines` 是雙用的，那是 dsh 的形狀
 *
 * 它同時是「沒給 `limit` 時用的預設」與「給了就不准超過的上限」。dsh 一樣：`index.ts:371` 取預設、
 * `:372` 擋超標，**兩處讀同一個 `this.config.maxLines`**。
 *
 * **這一格因此有一條特別的驗收**：兩個消費點必須一起吃到設定值。只接其中一處的話兩個方向都會壞
 * ——設定高於寫死的上限，不帶 `limit` 的請求全部 400；設定低於寫死的預設，一樣。所以驗收要用
 * **不帶 `limit` 查詢參數**的請求去打，一條每次都明著傳 `limit` 的測試會從這個缺陷底下綠著走過去。
 *
 * ## 這一列關不掉
 *
 * `disabled: true` 在載入期當場拋（`plugin-config.ts` 的 `PROTECTED_ENTRY_NAMES`）。理由同
 * `thread-title`：關掉它不會讓交付檔不再有上限——`startupSetting` 會把關掉的那一列當成沒有那一列，
 * 於是三個值回到 schema 的預設，**行為一個位元組都不變**，只會讓部署以為自己關掉了什麼。
 *
 * @module
 */

import { z } from 'zod';

import type { NexusPlugin, PluginRegistry } from '@nexus/core';

/** 這一列在訊息裡叫什麼。 */
export const DELIVERABLE_FILES_PLUGIN_NAME = 'deliverable-files';

/**
 * 一頁文字的位元組上限，照 dsh 的 `maxBytes`（2 MiB）。
 *
 * **超標是拒絕，不是切短**——dsh 的理由逐字：「a silently cut page reads as the whole page」。
 */
export const DEFAULT_DELIVERABLE_MAX_PAGE_BYTES = 2 * 1024 * 1024;

/** 整檔讀取的上限，照 dsh 的 `maxFileBytes`（32 MiB）。下載與預覽都吃它（見消費者檔頭偏離 1）。 */
export const DEFAULT_DELIVERABLE_MAX_FILE_BYTES = 32 * 1024 * 1024;

/** 一頁的預設與最大行數，照 dsh 的 `maxLines`（5000）。要更多是拒絕，不是給到上限為止。 */
export const DEFAULT_DELIVERABLE_MAX_LINES = 5000;

/**
 * 三格。`strictObject`：多寫一個欄位是打錯字，不是擴充點。
 *
 * **`.int().positive()` 是照 dsh 的 `z.number().step(1).min(1)`**。`maxFileBytes` 那格 dsh 另外壓了
 * `max(Number.MAX_SAFE_INTEGER - 1)`，我們用 `.safe()` 表達同一件事——它是拿來跟檔案大小比的，
 * 不安全的整數比出來的答案本身就沒有意義。
 */
export const deliverableFilesConfigSchema = z.strictObject({
  /** 見 {@link DEFAULT_DELIVERABLE_MAX_PAGE_BYTES}。 */
  maxBytes: z.number().int().positive().default(DEFAULT_DELIVERABLE_MAX_PAGE_BYTES),
  /** 見 {@link DEFAULT_DELIVERABLE_MAX_FILE_BYTES}。 */
  maxFileBytes: z.number().int().positive().safe().default(DEFAULT_DELIVERABLE_MAX_FILE_BYTES),
  /** 見 {@link DEFAULT_DELIVERABLE_MAX_LINES}。**雙用**，見檔頭。 */
  maxLines: z.number().int().positive().default(DEFAULT_DELIVERABLE_MAX_LINES),
});

/** 驗過的三個上限。消費者收的就是這個型別，不是三個散的數字。 */
export type DeliverableFilesConfig = z.infer<typeof deliverableFilesConfigSchema>;

/** 只講設定的那一顆，見檔頭。 */
export const deliverableFilesPlugin: NexusPlugin<DeliverableFilesConfig> = {
  name: DELIVERABLE_FILES_PLUGIN_NAME,
  Config: deliverableFilesConfigSchema,
  apply: (_registry: PluginRegistry, _config: DeliverableFilesConfig): void => {
    // 空的，見檔頭偏離 2：這一層沒有註冊表。
  },
};

export default deliverableFilesPlugin;
