/**
 * 嵌入方換票登入的**設定條目**（[#2370](https://github.com/DemianLi/nexus-agent/issues/2370)，地圖 #2365 第 4 點）。換票本體見 `../embed-login.ts`。
 *
 * **這一顆不裝功能，只講設定**，`apply` 是空的，同 `ops-endpoints`：值由 `startupSetting` 在起動期讀出來，交給 `serve.ts`。
 * **改了要重啟 serve**（分類 `startup-read`，`plugin-row-classes.ts`）。
 *
 * - **`embedders`**：能換票的嵌入方。一個嵌入方一把服務憑證，放在 `credentialFile`（預設 `<home>/embed-credential-<id>`，`0600`，沒有就建）。
 *   出廠是空的：沒有嵌入方就沒有換票的路由。
 * - **`ticketTtlSeconds`**：換到的登入票多久沒兌換就作廢。票只能用一次。
 *
 * @module
 */

import { isAbsolute } from 'node:path';

import { z } from 'zod';

import type { NexusPlugin, PluginRegistry } from '@nexus/core';

/** 這一列在訊息裡叫什麼。 */
export const EMBED_LOGIN_PLUGIN_NAME = 'embed-login';

/** 嵌入方 id：小寫英數與 `-`，會進檔名與稽核紀錄。 */
const EMBEDDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/u;

const embedderSchema = z.strictObject({
  /** 嵌入方的名字，寫進稽核紀錄與預設的憑證檔名。 */
  id: z.string().regex(EMBEDDER_ID_PATTERN, {
    message: 'id 只能是小寫英數與 -，開頭不能是 -，最長 32 字',
  }),
  /** 服務憑證檔的絕對路徑；缺席是 `<home>/embed-credential-<id>`。 */
  credentialFile: z
    .string()
    .min(1)
    .refine((path) => isAbsolute(path), { message: 'credentialFile 要是絕對路徑' })
    .optional(),
});

/** `strictObject`：多寫一個欄位是打錯字，同其他幾列。 */
export const embedLoginConfigSchema = z.strictObject({
  embedders: z
    .array(embedderSchema)
    .default([])
    .refine((list) => new Set(list.map((embedder) => embedder.id)).size === list.length, {
      message: 'embedders 的 id 不能重複',
    })
    .refine(
      (list) => {
        const files = list.flatMap((embedder) => embedder.credentialFile ?? []);
        return new Set(files).size === files.length;
      },
      { message: '兩個嵌入方不能共用同一個 credentialFile' },
    ),
  /** 登入票的有效期（秒）。 */
  ticketTtlSeconds: z.number().int().min(10).max(300).default(60),
});

/** 驗過的設定。 */
export type EmbedLoginConfig = z.infer<typeof embedLoginConfigSchema>;

/** 只講設定的那一顆，見檔頭。 */
export const embedLoginPlugin: NexusPlugin<EmbedLoginConfig> = {
  name: EMBED_LOGIN_PLUGIN_NAME,
  Config: embedLoginConfigSchema,
  apply: (_registry: PluginRegistry, _config: EmbedLoginConfig): void => {
    // 空的：組裝期沒有消費者。
  },
};

export default embedLoginPlugin;
