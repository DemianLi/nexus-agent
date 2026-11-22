/**
 * 宿主頁工具的**設定條目**：免核准名單與逾時（[#2374](https://github.com/DemianLi/nexus-agent/issues/2374)，設計 `.docs/host-page-tools-2374-design-2026-11-03.md` Q5）。
 *
 * 形狀與載體同 [`./thread-title.ts`](./thread-title.ts) 的檔頭。這一顆自己的三件事：
 *
 * 1. **兩個鍵**：`approval.exempt` 是宿主頁宣告時的工具名（不帶 `page__`），列了的不先問人、其餘都問，出廠是空的；名單由營運者給，
 *    宿主頁自己在宣告裡怎麼寫都不算（宿主頁是另一個系統的程式碼，serve 驗不了它）。`timeoutMs` 是宿主頁幾毫秒沒回就交回逾時，出廠 30 秒。
 * 2. **消費者在 server 起動期**：`serve-run.ts` 用 `startupSetting` 讀，嵌入版的 thread 組裝時交給 `createNexusAgent`：名單進 `embedApprovalGate`，逾時進宿主頁工具的插槽。改了要重啟。
 * 3. **關得掉、不在保護名單上、不是必掛**：關掉或寫壞掉了，都是讀成 schema 預設（空名單、30 秒），每支都問，是收緊不是放寬。
 *
 * @module
 */

import { z } from 'zod';

import type { NexusPlugin, PluginRegistry } from '@nexus/core';
import { HOST_TOOL_NAME_PATTERN } from '@nexus/wire';

import { HOST_TOOL_TIMEOUT_MS } from '../host-tools.js';

/** 這一列在訊息裡叫什麼。 */
export const HOST_TOOLS_PLUGIN_NAME = 'host-tools';

/** `strictObject`：多寫一個欄位是打錯字，同其他幾列。 */
export const hostToolsConfigSchema = z.strictObject({
  approval: z
    .strictObject({
      /** 不先問人的宿主頁工具名，宣告時的名字。 */
      exempt: z.array(z.string().regex(HOST_TOOL_NAME_PATTERN)).default([]),
    })
    .default({ exempt: [] }),
  /** 宿主頁幾毫秒沒回就當失敗，這一輪接著跑。 */
  timeoutMs: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(HOST_TOOL_TIMEOUT_MS),
});

/** 驗過的設定。 */
export type HostToolsConfig = z.infer<typeof hostToolsConfigSchema>;

/** 只講設定的那一顆，見 `./thread-title.ts` 的檔頭。 */
export const hostToolsPlugin: NexusPlugin<HostToolsConfig> = {
  name: HOST_TOOLS_PLUGIN_NAME,
  Config: hostToolsConfigSchema,
  apply: (_registry: PluginRegistry, _config: HostToolsConfig): void => {
    // 空的：組裝期沒有消費者。
  },
};

export default hostToolsPlugin;
