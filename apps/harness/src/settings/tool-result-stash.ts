/**
 * 過大的工具結果暫存到主機的**設定條目**（[#734](https://github.com/DemianLi/nexus-agent/issues/734)）：暫存的根目錄與
 * 保留天數，兩格名字照 dsh `spill-local` 的 `root`、`cleanupPeriodDays`（`packages/spill/spill-local/src/index.ts:66-69`，
 * `477b4f4`）。
 *
 * **這一顆不裝功能，只講設定**，`apply` 是空的，同 `tool-text`／`deliverable-files` 那幾列。消費點在起動期：
 * `runCli`／`runServe` 解一次，往下傳給組裝點（`agent-factory.ts` 的 `toolResultStash`），並在啟動時清一次保留期
 * （`tool-result-stash.ts` 的 `cleanupToolResultStash`）。
 *
 * ## 這一列關不掉
 *
 * `disabled: true` 在載入期當場拋。理由同起動期那幾列：關掉它不會讓工具結果不再暫存，`startupSetting` 把關掉的那一列
 * 當成沒有那一列，值回到 schema 的預設，行為一個位元組都不變。
 *
 * @module
 */

import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { z } from 'zod';

import type { NexusPlugin, PluginRegistry } from '@nexus/core';

import { resolveHarnessHome } from '../harness-home.js';

/** 這一列在訊息裡叫什麼。 */
export const TOOL_RESULT_STASH_PLUGIN_NAME = 'tool-result-stash';

/** 沒設保留天數時的預設，照 dsh `spill-local` 的 `cleanupPeriodDays`。 */
export const DEFAULT_TOOL_RESULT_STASH_RETENTION_DAYS = 30;

/** 預設根在 harness home 底下的名字。 */
export const TOOL_RESULT_STASH_DIR_NAME = 'tool-results';

/**
 * 一格。`strictObject`：多寫一個欄位是打錯字，不是擴充點。
 */
export const toolResultStashConfigSchema = z.strictObject({
  /**
   * 暫存的根目錄；絕對路徑或 `~` 開頭。缺席就是 harness home 底下的 `tool-results`。
   *
   * **偏離 dsh 的「沒設就用每行程一個的私有暫存目錄」**：基座的路徑是虛擬的，續接時要照同一個路徑讀回同一個檔，所以根要
   * 跨行程重開保持固定；預設放 harness home 而不是系統暫存區，因為那裡會被定期清掉。登記在 `tool-result-stash.ts` 的檔頭。
   */
  root: z.string().min(1).optional(),
  /** 保留天數；`0` 表示不清。啟動時清一次，別人改得動的根不清。 */
  cleanupPeriodDays: z.number().int().min(0).default(DEFAULT_TOOL_RESULT_STASH_RETENTION_DAYS),
});

/** 驗過的設定。 */
export type ToolResultStashConfig = z.infer<typeof toolResultStashConfigSchema>;

/**
 * 把設定解成暫存的根目錄（絕對路徑）。
 *
 * @param config - 驗過的設定。
 * @param env - 讀 harness home 用的環境，同 `resolveHarnessHome`。
 * @returns 設定的 `root`（`~` 展開）；缺席就是 `<harness home>/tool-results`。
 * @throws {Error} `root` 不是絕對路徑：相對路徑會跟著行程的工作目錄漂，續接時就對不上同一個位置。
 */
export function resolveToolResultStashRoot(
  config: ToolResultStashConfig,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (config.root === undefined) {
    return join(resolveHarnessHome(env), TOOL_RESULT_STASH_DIR_NAME);
  }
  const expanded =
    config.root === '~'
      ? homedir()
      : config.root.startsWith('~/')
        ? join(homedir(), config.root.slice(2))
        : config.root;
  if (!isAbsolute(expanded)) {
    throw new Error(
      `tool-result-stash 的 root "${config.root}" 不是絕對路徑：` +
        '相對路徑會跟著行程的工作目錄漂，續接時就對不上同一個位置。',
    );
  }
  return resolve(expanded);
}

/** 只講設定的那一顆，見檔頭。 */
export const toolResultStashPlugin: NexusPlugin<ToolResultStashConfig> = {
  name: TOOL_RESULT_STASH_PLUGIN_NAME,
  Config: toolResultStashConfigSchema,
  apply: (_registry: PluginRegistry, _config: ToolResultStashConfig): void => {
    // 空的，見檔頭：組裝期沒有消費者。
  },
};

export default toolResultStashPlugin;
