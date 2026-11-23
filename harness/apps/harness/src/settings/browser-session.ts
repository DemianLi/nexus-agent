/**
 * 瀏覽器 cookie 有效期的**設定條目**（[#457](https://github.com/DemianLi/nexus-agent/issues/457)／
 * [#529](https://github.com/DemianLi/nexus-agent/issues/529)）。
 *
 * 形狀、載體與「關不掉」的理由**逐條同**
 * [`./thread-title.ts`](./thread-title.ts) 的檔頭，不在這裡重述一次。這一顆自己的兩件事：
 *
 * 1. **dsh 那側是 plugin 設定 `cookieMaxAgeDays`，預設同樣是 30。** 所以這一列補上的是
 *    `browser-auth.ts` 檔頭原本登記的那條偏離（「有效期寫死 30 天，不能設定」）——**那條偏離
 *    到此為止**，它的檔頭跟著改掉了。
 * 2. **消費者在 server 起動期**：`BrowserAuth` 的建構子，比任何一條 thread 都早，所以跟標題上限
 *    走同一條路（起動期解一次、往下傳一份）。
 *
 * @module
 */

import { z } from 'zod';

import type { NexusPlugin, PluginRegistry } from '@nexus/core';

/** 這一列在訊息裡叫什麼。 */
export const BROWSER_SESSION_PLUGIN_NAME = 'browser-session';

/** cookie 的絕對有效期（天），照 dsh 的 `cookieMaxAgeDays`。 */
export const DEFAULT_BROWSER_SESSION_MAX_AGE_DAYS = 30;

/**
 * 有效期。
 *
 * **正整數，上界留給消費端**：換算成毫秒之後會不會超出安全的時間戳範圍，`BrowserAuth` 的
 * 建構子自己驗（它本來就驗，而那一道跟「今天是哪一天」有關，schema 表達不出來）。
 */
export const browserSessionConfigSchema = z.strictObject({
  /** 見 {@link DEFAULT_BROWSER_SESSION_MAX_AGE_DAYS}。 */
  maxAgeDays: z.number().int().positive().default(DEFAULT_BROWSER_SESSION_MAX_AGE_DAYS),
});

/** 驗過的設定。 */
export type BrowserSessionConfig = z.infer<typeof browserSessionConfigSchema>;

/** 只講設定的那一顆，見 `./thread-title.ts` 的檔頭。 */
export const browserSessionPlugin: NexusPlugin<BrowserSessionConfig> = {
  name: BROWSER_SESSION_PLUGIN_NAME,
  Config: browserSessionConfigSchema,
  apply: (_registry: PluginRegistry, _config: BrowserSessionConfig): void => {
    // 空的：組裝期沒有消費者。
  },
};

export default browserSessionPlugin;
