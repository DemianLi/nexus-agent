/**
 * 背景續行子代理的**設定條目**（[#841](https://github.com/DemianLi/nexus-agent/issues/841)）：委派工具是一次性的還是
 * 背景續行的，以及每個主對話同時存活的背景子代理上限。
 *
 * 欄位名與值域照 dsh：`backgroundMode: 'one-shot' | 'continuable'` 是 `tool-subagent` 的 Config
 * （`packages/subagent/tool-subagent/src/index.ts:111`，schema 預設 `one-shot`，`477b4f4`），`maxActiveSubagents` 是
 * subagent 的並存上限（預設 8）。**出貨值 `continuable` 是 dsh base bundle 那一列打開的**
 * （`packages/bundle/base/cordis.patch.yml:369-374`），schema 預設不是——所以這裡同樣：schema 預設 `one-shot`，
 * 出貨的 `cordis.yml` 那一列寫 `continuable`。`--dump-config` 印得出實際生效的值；把這一列標成 `disabled: true`
 * 或整列拿掉，回到 schema 的預設，也就是今天的一次性。
 *
 * 偏離登記：dsh 把兩格分在兩個 plugin（`tool-subagent`、subagent）上，我們併成一列，因為我們的組裝點只有一個
 * （`BackgroundDelegation`）同時消費它們。
 *
 * **這一顆不裝功能，只講設定**，`apply` 是空的，同 `spill-policy`。消費點在起動期：`runServe` 解一次，往下傳給
 * 組裝點（`agent-factory.ts` 的 `backgroundSubagents`）。**`runCli` 不讀它**：REPL 一行一輪、一次性模式答完就退出，
 * 都沒有可以被叫醒的一輪，背景子代理的結果送不回來（見 `docs/operations.md`）。
 *
 * @module
 */

import { z } from 'zod';

import type { NexusPlugin, PluginRegistry } from '@nexus/core';

/** 這一列在訊息裡叫什麼。 */
export const BACKGROUND_SUBAGENTS_PLUGIN_NAME = 'background-subagents';

/** 每個主對話同時存活的背景子代理上限的預設值，照 dsh。 */
export const DEFAULT_MAX_ACTIVE_SUBAGENTS = 8;

/**
 * 一格。`strictObject`：多寫一個欄位是打錯字，不是擴充點。
 */
export const backgroundSubagentsConfigSchema = z.strictObject({
  backgroundMode: z.enum(['one-shot', 'continuable']).default('one-shot'),
  maxActiveSubagents: z.number().int().min(1).default(DEFAULT_MAX_ACTIVE_SUBAGENTS),
});

/** 驗過的設定。 */
export type BackgroundSubagentsConfig = z.infer<typeof backgroundSubagentsConfigSchema>;

/** 只講設定的那一顆，見檔頭。 */
export const backgroundSubagentsPlugin: NexusPlugin<BackgroundSubagentsConfig> = {
  name: BACKGROUND_SUBAGENTS_PLUGIN_NAME,
  Config: backgroundSubagentsConfigSchema,
  apply: (_registry: PluginRegistry, _config: BackgroundSubagentsConfig): void => {
    // 空的，見檔頭：組裝期沒有消費者。
  },
};

export default backgroundSubagentsPlugin;
