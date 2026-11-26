/**
 * 已刪除存放區的設定條目（[#2957](https://github.com/DemianLi/nexus-agent/issues/2957)）：存放區路徑與寬限天數。
 *
 * **這一顆不裝功能，只講設定**，`apply` 是空的：值由 `startupSetting` 在起動期讀出來，`serve-run.ts` 交給 `ThreadDeletions`。
 * **改了要重啟**。改路徑不會自動搬；啟動時若預設路徑底下還有檔，會印一行警告（見 `thread-deletion.ts` 的 `checkStoreMoved`）。
 *
 * - `path`：不寫就是 harness home 底下的 `sessions-deleted/`。寫了必須是絕對路徑，相對路徑在啟動時就拒絕。
 * - `graceDays`：寬限天數，預設 30，正整數。
 *
 * @module
 */

import { isAbsolute } from 'node:path';

import { z } from 'zod';

import type { NexusPlugin, PluginRegistry } from '@nexus/core';

/** 這一列在訊息裡叫什麼。 */
export const THREAD_DELETION_STORE_PLUGIN_NAME = 'thread-deletion-store';

/** 寬限天數的出廠值（與 `thread-deletion.ts` 的 `DEFAULT_GRACE_DAYS` 同一個數，這裡照抄讓 schema 自足）。 */
export const DEFAULT_THREAD_DELETION_GRACE_DAYS = 30;

/** `strictObject`：多寫一個欄位是打錯字。 */
export const threadDeletionStoreConfigSchema = z.strictObject({
  /** 存放區的絕對路徑；省略就是 harness home 底下的 `sessions-deleted/`。 */
  path: z
    .string()
    .min(1)
    .refine((value) => isAbsolute(value), { message: '存放區路徑要是絕對路徑' })
    .optional(),
  /** 寬限天數：過了之後只是不能復原，檔案留著。 */
  graceDays: z.number().int().min(1).max(3650).default(DEFAULT_THREAD_DELETION_GRACE_DAYS),
});

/** 驗過的設定。 */
export type ThreadDeletionStoreConfig = z.infer<typeof threadDeletionStoreConfigSchema>;

/** 只講設定的那一顆，見檔頭。 */
export const threadDeletionStorePlugin: NexusPlugin<ThreadDeletionStoreConfig> = {
  name: THREAD_DELETION_STORE_PLUGIN_NAME,
  Config: threadDeletionStoreConfigSchema,
  apply: (_registry: PluginRegistry, _config: ThreadDeletionStoreConfig): void => {
    // 空的：組裝期沒有消費者，serve 啟動時讀它。
  },
};

export default threadDeletionStorePlugin;
