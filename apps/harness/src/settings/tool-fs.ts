/**
 * 檔案工具組態的**設定條目**（[#1605](https://github.com/DemianLi/nexus-agent/issues/1605) N0355）：管理者可以個別關掉寫檔、改檔
 * 這兩顆工具（例如部署「只讀的知識助理」），也可以調讀檔的上限。id 與欄位名照 dsh `tool-fs` 的 Config
 * （`packages/fs/tool-fs/src/index.ts:20-98`，`687f282e`）：數值都要是正整數，否則載入時就拋（`assertPositiveInteger`，`:106-110`）。
 * 功能本體在 `@nexus/core`：開關換成基座的 `tools` 白名單（`fs-tools-options.ts`），行數上限在讀檔續讀（`read-continuation.ts`），
 * 其餘三個上限由 backend 建頁時讀（`contained-backend.ts`）。
 *
 * **消費點在組裝期**（`agent-factory.ts`，跑在 `loadPlugins` 之後），同 `tool-fs-search`：`apply` 把驗過的值提供成
 * {@link TOOL_FS_SERVICE}，組裝點去讀服務、交給 `foldRegistry`。
 *
 * ## 關掉的工具，模型根本看不到
 *
 * 不是「叫了再被擋」：白名單之外的基座工具不建，所以不在送給模型的工具清單裡（比 `read-only` 圍堵讓模型叫了再被拒，近 dsh 的「不註冊」）。
 * 「先讀後改」那句系統提示也跟著不出現（`observationGuidance` 看這一輪的工具清單）。
 * **圍堵（`read-only` 之類）仍是另一件事**：這一列管模型看得到什麼，圍堵管叫了會怎樣，兩者可以疊用。
 *
 * ## 與 dsh 的偏離
 *
 * 1. **不開 `read`（理由 1：基座表達不出來）。** dsh 的 `read: false` 是不註冊讀檔工具。基座的 `createFilesystemMiddleware` 要求 `tools`
 *    一定含 `read_file`，否則組裝時拋 `read_file must be included in tools; it is required by FilesystemMiddleware`
 *    （`deepagents@1.13.1`，`dist/langsmith-zm0ILQsV.js:2323-2328`）；而且基座把超大的工具結果逐出到 `/large_tool_results/` 時，回給模型的
 *    訊息就是叫它用 `read_file` 分段去讀（`:1574-1578`），我們的續讀提示（`Use offset=… to continue.`）也預設模型能再叫 `read_file`。
 *    退到「讀檔永遠註冊」：這一格**收了但只認 `true`**，寫 `false` 就載入失敗並指名原因（用載入失敗而不是 `strictObject` 拒收，是讓照 dsh 寫法
 *    寫的設定得到一句講得出原因的錯誤，不是「多一格」）。前例：`tool-fs-search.ts` 的 `sampleOverCapGlobResults` 也是「只認一個值就不開這一格」。
 *    2026-10-17 demian 拍板（#1605 Q2 (a)）。
 * 2. **`write: false` 連 `delete` 一起關（理由 1：基座表達不出來）。** dsh 沒有 `delete` 這顆工具；基座多一顆會改檔的工具，dsh 沒有可以
 *    對照的開關，歸到寫入面最接近。
 * 3. **沒抄 `readImage`**：#731 判定不註冊 `read_image`。
 *
 * ## 這一列關不掉（偏離 4，理由 1：基座表達不出來）
 *
 * 標成 `disabled: true` 在啟動時就拋（`plugin-config.ts` 的 `PROTECTED_ENTRY_NAMES`，訊息帶 `PROTECTED_ENTRY_REASONS` 裡這一列自己的理由）。
 * dsh 關掉 `tool-fs` 是連讀寫檔工具都不註冊（`packages/bundle/base/cordis.patch.yml:295`），方向相反；基座要求 `read_file` 一定在工具清單，
 * 我們做不到那一種，退到「關不掉」：沒有這一列、服務不在時，組裝點不傳任何組態，**所有工具都在、上限回到常數**——原本寫了 `write: false`
 * 的部署關掉這一列，反而把寫檔放回來，是最會誤導的關法。要關掉寫檔，寫 `write: false`。（組裝點讀不到服務時的「全開」只剩沒有載入設定列的組裝，
 * 例如測試與 eval。）
 *
 * @module
 */

import { z } from 'zod';

import { READ_LIMIT, READ_MAX_BYTES, READ_MAX_LINE_LENGTH } from '@nexus/core';
import type { FileToolsOptions, NexusPlugin, PluginRegistry } from '@nexus/core';

import { READ_STREAM_MIN_SIZE } from '../contained-backend.js';

/** 這一列在訊息裡叫什麼。 */
export const TOOL_FS_PLUGIN_NAME = 'tool-fs';

/** 驗過的組態，由 `#settings/tool-fs` 提供。 */
export const TOOL_FS_SERVICE = 'toolFs';

/** 正整數，同 dsh 的 `assertPositiveInteger`：0 或負數會讓分頁與截取的算術安靜地出錯。 */
const positiveInteger = (fallback: number) => z.number().int().positive().default(fallback);

/**
 * `strictObject`：多寫一個欄位是打錯字，不是擴充點。
 *
 * `read` 收進來但只認 `true`（偏離 1）：用 `literal(true)` 而不是 `refine`，所以匯出的規格（`--dump-config` 的 JSON Schema）講得出「只能是 true」，載入失敗的錯誤帶這句訊息。
 */
export const toolFsConfigSchema = z.strictObject({
  read: z
    .literal(true, {
      error:
        'read 不能關閉：基座的檔案 middleware 要求 read_file 一定在工具清單裡（read_file must be included in tools），' +
        '而且超大的工具結果與讀檔續讀都要靠模型再叫 read_file。要限制模型讀哪些檔，用 permissions',
    })
    .default(true),
  write: z.boolean().default(true),
  edit: z.boolean().default(true),
  readLimit: positiveInteger(READ_LIMIT),
  readMaxLineLength: positiveInteger(READ_MAX_LINE_LENGTH),
  readMaxBytes: positiveInteger(READ_MAX_BYTES),
  readStreamMinSize: positiveInteger(READ_STREAM_MIN_SIZE),
});

/** 驗過的設定。 */
export type ToolFsConfig = z.infer<typeof toolFsConfigSchema>;

declare module '@nexus/core' {
  interface NexusServices {
    /**
     * 檔案工具的組態，由 `#settings/tool-fs` 提供（#1605）。**沒人提供就是全開、用常數**，見 `settings/tool-fs.ts` 檔頭。
     */
    toolFs: FileToolsOptions;
  }
}

/** 只講設定的那一顆：把值提供成服務，見檔頭。 */
export const toolFsPlugin: NexusPlugin<ToolFsConfig> = {
  name: TOOL_FS_PLUGIN_NAME,
  Config: toolFsConfigSchema,
  apply: (registry: PluginRegistry, config: ToolFsConfig): void => {
    registry.services.provide(TOOL_FS_SERVICE, {
      write: config.write,
      edit: config.edit,
      readLimit: config.readLimit,
      readMaxLineLength: config.readMaxLineLength,
      readMaxBytes: config.readMaxBytes,
      readStreamMinSize: config.readStreamMinSize,
    });
  },
};

export default toolFsPlugin;
