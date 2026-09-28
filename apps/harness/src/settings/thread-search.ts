/**
 * 會話內容搜尋的**設定條目**（[#631](https://github.com/DemianLi/nexus-agent/issues/631)）。行為見 `../thread-search.ts`。
 *
 * 照 dsh 的 `session-query-sqlite` 那一列（`packages/session-query/session-query-sqlite/src/index.ts:92-119`，`477b4f4`）的
 * `openAt`，**出廠寫 `never`**，同 dsh `base` 與 `web-app` 兩個 bundle（`packages/bundle/base/cordis.patch.yml:141-153`、
 * `packages/bundle/web-app/cordis.patch.yml:22-30`）：要不要多背一份索引是部署自己的選擇，產品預設不背
 * （`.agents/notes/archived/architecture/2026-08-13-session-content-search-opt-in.zh.md:10`）。demian 2026-09-26 拍板照做。
 *
 * **這一顆不裝功能，只講設定**，`apply` 是空的，同 `thread-title-llm` 那一列：值由 `startupSetting` 在起動期讀出來，
 * 交給 `serve.ts` 建的那一份搜尋。理由與偏離見 `thread-title.ts` 的檔頭。
 *
 * ## 三個值，同 dsh
 *
 * - `startup`：serve 起動時就載入 `node:sqlite`、開好索引（還不掃任何會話，第一次搜尋才對帳）。
 * - `first-search`：第一次搜尋才載入。
 * - `never`：搜尋一律回失敗、`node:sqlite` 一次都不載入——Node 22 載入它會在 stderr 印一行實驗功能的警告，
 *   出廠的啟動不該有那一行（dsh 用測試釘同一件事，`apps/cli/tests/lazy-search-startup.compat.spec.ts:123`）。
 *
 * **schema 預設是 `startup`，同 dsh**；關著是出廠那一列寫的，不是預設值。所以一份把 `config:` 整段拿掉的 patch 會把它打開。
 *
 * ## 這一列關得掉，而且關掉跟 `never` 不一樣
 *
 * `disabled: true` 是沒掛這一列：搜尋一律回失敗，連「沒有東西可搜」也是，同 dsh 沒掛 `sessionQuery` 的那條
 * （`packages/api/session-controller/src/list.ts:170-177`）。`never` 是掛了但不開：沒有東西可搜時照樣回空。所以它跟
 * `thread-title-llm` 一樣不在 `PROTECTED_ENTRY_NAMES` 上，掛沒掛由 `startupEntryMounted` 判。
 *
 * ## dsh 那一列其他的格我們沒有
 *
 * `path`（索引檔放哪）、`journalMode`、`defaultLimit`／`maxLimit`、`snippetChars`、`readWindowMax`、
 * `persistedReadConcurrency`、`preparedSessionCacheSize`。**索引只放在記憶體裡**（同 dsh 的 `path: ':memory:'`），
 * serve 重開之後第一次搜尋重建；線上的筆數與片段長度是協定常數（`@nexus/wire` 的 `THREAD_SEARCH_*`），同 dsh 的 host 那一層
 * 也寫死。其餘幾格調的是持久索引與分頁讀取，那兩樣我們沒有。
 *
 * @module
 */

import { z } from 'zod';

import type { NexusPlugin, PluginRegistry } from '@nexus/core';

/** 這一列在訊息裡叫什麼。 */
export const THREAD_SEARCH_PLUGIN_NAME = 'thread-search';

/** 什麼時候開索引，同 dsh 的 `SessionQuerySqliteOpenAt`。 */
export const THREAD_SEARCH_OPEN_AT = ['startup', 'first-search', 'never'] as const;

/** `strictObject`：多寫一個欄位是打錯字，同其他幾列。 */
export const threadSearchConfigSchema = z.strictObject({
  /** 見檔頭的「三個值」。 */
  openAt: z.enum(THREAD_SEARCH_OPEN_AT).default('startup'),
});

/** 驗過的設定。 */
export type ThreadSearchConfig = z.infer<typeof threadSearchConfigSchema>;

/** 只講設定的那一顆，見檔頭。 */
export const threadSearchPlugin: NexusPlugin<ThreadSearchConfig> = {
  name: THREAD_SEARCH_PLUGIN_NAME,
  Config: threadSearchConfigSchema,
  apply: (_registry: PluginRegistry, _config: ThreadSearchConfig): void => {
    // 空的：組裝期沒有消費者。
  },
};

export default threadSearchPlugin;
