/**
 * 搜尋結果筆數上限的**設定條目**（[#735](https://github.com/DemianLi/nexus-agent/issues/735)）：`grep` 命中超過
 * `grepMaxMatches`、`glob`／`ls` 超過 `globMaxResults` 時，行內留前段，完整結果存進工具結果暫存目錄。
 * id 與兩格的名字、預設值 250／100 都照 dsh `tool-fs-search`（`packages/fs/tool-fs-search/src/index.ts:73-100`、
 * `grep.ts:29`、`glob.ts:25`，`477b4f4`）。功能本體在 `@nexus/core` 的 `search-overflow.ts`。
 *
 * **消費點在組裝期**（`agent-factory.ts`，跑在 `loadPlugins` 之後），同 `recursion-limit` 那一列：`apply` 把驗過的值
 * 提供成 {@link SEARCH_RESULT_LIMITS_SERVICE}，組裝點去讀服務。
 *
 * ## 這一列關得掉，關掉就是基座原樣
 *
 * 沒有這一列、或標成 `disabled: true`，服務就不在，組裝點不掛筆數上限：三顆工具回到基座原樣（超過 80,000 字元由工具本體
 * 自己截掉，原文不留）。跟 `recursion-limit` 相反——那一列關掉會落回內建值、看起來像關掉了護欄其實沒有，所以擋；這一列
 * 關掉真的不一樣，所以放行，同 `spill-policy`。dsh 那側關掉 `tool-fs-search` 是連工具都沒有，那一格我們表達不出來
 * （工具是基座的，見 `search-overflow.ts` 檔頭）。
 *
 * ## 沒抄的欄位
 *
 * - `sampleOverCapGlobResults`：dsh 是必填，base 出廠給 `false`（留按順序的前段）。這裡只做 `false` 那一種，不開這一格——
 *   開了卻只認一個值，等於寫一個改不動的開關。
 * - `grepMaxLineBytes`、`searchMetaMaxBytes`、`rawOutputMaxBytes`、`graceMs`、`stderrMaxBytes`、`timeoutMs`：管的是 dsh
 *   自己的 ripgrep 子行程與輸出，基座的工具沒有對應的東西，不在 #735 的範圍。
 *
 * @module
 */

import { z } from 'zod';

import { GLOB_MAX_RESULTS, GREP_MAX_MATCHES } from '@nexus/core';
import type { NexusPlugin, PluginRegistry, SearchResultLimits } from '@nexus/core';

/** 這一列在訊息裡叫什麼。 */
export const TOOL_FS_SEARCH_PLUGIN_NAME = 'tool-fs-search';

/** 驗過的上限，由 `#settings/tool-fs-search` 提供。 */
export const SEARCH_RESULT_LIMITS_SERVICE = 'searchResultLimits';

/**
 * 兩格。`strictObject`：多寫一個欄位是打錯字，不是擴充點。正整數，同 dsh 的 `assertPositiveInteger`
 * （`index.ts:106-110`）：0 或負數會讓截取的算術安靜地出錯。
 */
export const toolFsSearchConfigSchema = z.strictObject({
  grepMaxMatches: z.number().int().positive().default(GREP_MAX_MATCHES),
  globMaxResults: z.number().int().positive().default(GLOB_MAX_RESULTS),
});

/** 驗過的設定。 */
export type ToolFsSearchConfig = z.infer<typeof toolFsSearchConfigSchema>;

declare module '@nexus/core' {
  interface NexusServices {
    /**
     * 搜尋結果的筆數上限，由 `#settings/tool-fs-search` 提供（#735）。**沒人提供就是不掛**，見
     * `settings/tool-fs-search.ts` 檔頭。
     */
    searchResultLimits: SearchResultLimits;
  }
}

/** 只講設定的那一顆：把值提供成服務，見檔頭。 */
export const toolFsSearchPlugin: NexusPlugin<ToolFsSearchConfig> = {
  name: TOOL_FS_SEARCH_PLUGIN_NAME,
  Config: toolFsSearchConfigSchema,
  apply: (registry: PluginRegistry, config: ToolFsSearchConfig): void => {
    registry.services.provide(SEARCH_RESULT_LIMITS_SERVICE, {
      grepMaxMatches: config.grepMaxMatches,
      globMaxResults: config.globMaxResults,
    });
  },
};

export default toolFsSearchPlugin;
