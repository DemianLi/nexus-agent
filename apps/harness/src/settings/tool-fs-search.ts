/**
 * 搜尋結果筆數上限的**設定條目**（[#735](https://github.com/DemianLi/nexus-agent/issues/735)）：`grep` 命中超過
 * `grepMaxMatches`、`glob`／`ls` 超過 `globMaxResults` 時，行內留前段，完整結果存進工具結果暫存目錄；`grep` 每一行命中文字
 * 另外限在 `grepMaxLineBytes` 個位元組內（[#1605](https://github.com/DemianLi/nexus-agent/issues/1605)）。
 * id 與三格的名字、預設值 250／100／2000 都照 dsh `tool-fs-search`（`packages/fs/tool-fs-search/src/index.ts:73-100`、
 * `grep.ts:29`、`glob.ts:25`，`477b4f4`）。功能本體在 `@nexus/core` 的 `search-overflow.ts`。
 *
 * **消費點在組裝期**（`agent-factory.ts`，跑在 `loadPlugins` 之後），同 `recursion-limit` 那一列：`apply` 把驗過的值
 * 提供成 {@link SEARCH_RESULT_LIMITS_SERVICE}，組裝點去讀服務。
 *
 * ## 這一列關得掉，關掉就是基座原樣
 *
 * 沒有這一列、或標成 `disabled: true`，服務就不在，組裝點不掛筆數上限：三顆工具回到基座原樣（超過 80,000 字元由工具本體
 * 自己截掉，原文不留）。跟 `recursion-limit` 相反——那一列關掉會落回內建值、看起來像關掉了護欄其實沒有，所以擋；這一列
 * 關掉真的不一樣，所以放行，同 `spill-policy`。dsh 那側關掉 `tool-fs-search` 是連工具都沒有；基座的 `tools` 白名單表達得出
 * 「關掉單顆工具」（#1605 的 `tool-fs` 就用它關寫檔、改檔），但這一列管的是三顆**讀取面**工具的結果形狀，關掉這一列要不要順便
 * 把 `glob`／`grep` 從模型的工具清單拿掉是另一個決定（`ls`、`read_file` 也得跟著想），這一列不開這一格。
 *
 * ## 沒抄的欄位
 *
 * - `sampleOverCapGlobResults`：dsh 是必填，base 出廠給 `false`（留按順序的前段）。這裡只做 `false` 那一種，不開這一格——
 *   開了卻只認一個值，等於寫一個改不動的開關。
 * - `searchMetaMaxBytes`：管的是 dsh 自己的 `presentationMeta` 序列化大小，我們沒有對應的東西。
 * - `rawOutputMaxBytes`、`graceMs`、`stderrMaxBytes`、`timeoutMs`：[#1532](https://github.com/DemianLi/nexus-agent/issues/1532)
 *   之後有對應的東西了——`grep` 自己起 rg（`ripgrep-runner.ts`），這四個值照 dsh 的預設實作成常數
 *   （20,000,000 位元組、3 秒、64 KiB、30 秒），**未開成設定欄位**：#735 的設定列管的是筆數，要不要開這四格是另一個決定。
 *
 * ## `grepMaxLineBytes`（#1605）
 *
 * #735 當時列為「基座沒有對應」；#1532 自己起 rg 之後，每一行命中文字的截斷有地方做了。載體跟筆數上限同一對包裝
 * （`search-overflow.ts` 的 `capSearchResults`）：一行壓縮過的 JS 或 JSON 命中時，那一行在 UTF-8 邊界上切到上限，加
 * ` (line truncated)`，整行還在檔案裡可以 `read_file`。沒有這一列（或標成 `disabled: true`）就不切，同上一節。
 *
 * @module
 */

import { z } from 'zod';

import { GLOB_MAX_RESULTS, GREP_MAX_LINE_BYTES, GREP_MAX_MATCHES } from '@nexus/core';
import type { NexusPlugin, PluginRegistry, SearchResultLimits } from '@nexus/core';

/** 這一列在訊息裡叫什麼。 */
export const TOOL_FS_SEARCH_PLUGIN_NAME = 'tool-fs-search';

/** 驗過的上限，由 `#settings/tool-fs-search` 提供。 */
export const SEARCH_RESULT_LIMITS_SERVICE = 'searchResultLimits';

/**
 * 三格。`strictObject`：多寫一個欄位是打錯字，不是擴充點。正整數，同 dsh 的 `assertPositiveInteger`
 * （`index.ts:106-110`）：0 或負數會讓截取的算術安靜地出錯。
 */
export const toolFsSearchConfigSchema = z.strictObject({
  grepMaxMatches: z.number().int().positive().default(GREP_MAX_MATCHES),
  globMaxResults: z.number().int().positive().default(GLOB_MAX_RESULTS),
  grepMaxLineBytes: z.number().int().positive().default(GREP_MAX_LINE_BYTES),
});

/** 驗過的設定。 */
export type ToolFsSearchConfig = z.infer<typeof toolFsSearchConfigSchema>;

declare module '@nexus/core' {
  interface NexusServices {
    /**
     * 搜尋結果的筆數上限，由 `#settings/tool-fs-search` 提供（#735、#1605）。**沒人提供就是不掛**，見
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
      grepMaxLineBytes: config.grepMaxLineBytes,
    });
  },
};

export default toolFsSearchPlugin;
