/**
 * 工具結果外溢層的**設定條目**（[#719](https://github.com/DemianLi/nexus-agent/issues/719)）：一則結果最多佔多少估算 token，
 * 超過就把全文存到主機、只留預覽。欄位名照 dsh `spill-policy` 的 `maxInlineTokens`（`packages/spill/spill-policy/src/index.ts:34`，
 * `477b4f4`）；出貨值 12500 也是 dsh base 的（`packages/bundle/base/cordis.patch.yml:409`）。
 *
 * **這一顆不裝功能，只講設定**，`apply` 是空的，同 `tool-text`／`tool-result-stash` 那幾列。消費點在起動期：
 * `runCli`／`runServe` 解一次，往下傳給組裝點（`agent-factory.ts` 的 `spillPolicy`），由 fold 掛上
 * （`@nexus/core` 的 `spill-policy.ts`）。
 *
 * ## 這一列關得掉，而且「關」有兩種寫法
 *
 * 照 dsh：**省略 `maxInlineTokens` 就停用**（dsh `:57`）。所以 `disabled: true`（`startupSetting` 把關掉的列當成沒有那一列，
 * 值回到 schema 的預設，也就是省略）與「把那一格刪掉」是同一個結果。停用之後超過 80,000 字元的結果仍由基座換成預覽——
 * 那一條關不掉（見 `spill-policy.ts` 檔頭偏離 4）。
 *
 * @module
 */

import { z } from 'zod';

import type { NexusPlugin, PluginRegistry } from '@nexus/core';

/** 這一列在訊息裡叫什麼。 */
export const SPILL_POLICY_PLUGIN_NAME = 'spill-policy';

/**
 * 一格。`strictObject`：多寫一個欄位是打錯字，不是擴充點。
 *
 * **沒有預設值，省略就是停用**，同 dsh。出貨的 12500 寫在 `cordis.yml` 那一列上，所以 `--dump-config` 印得出實際生效的值。
 *
 * **下限 256 是量出來的**：通知本身（`Omitted N bytes. Full formatted result stored at: <路徑>. <取回提示>`）約 50 token，
 * 頭尾各要留得下一點原文才有預覽的意義；低於它通知會比預算還大，外溢層就照 dsh 保留原結果，等於寫了一個永遠不生效的數字。
 */
export const spillPolicyConfigSchema = z.strictObject({
  maxInlineTokens: z.number().int().min(256).optional(),
});

/** 驗過的設定。 */
export type SpillPolicyConfig = z.infer<typeof spillPolicyConfigSchema>;

/** 只講設定的那一顆，見檔頭。 */
export const spillPolicyPlugin: NexusPlugin<SpillPolicyConfig> = {
  name: SPILL_POLICY_PLUGIN_NAME,
  Config: spillPolicyConfigSchema,
  apply: (_registry: PluginRegistry, _config: SpillPolicyConfig): void => {
    // 空的，見檔頭：組裝期沒有消費者。
  },
};

export default spillPolicyPlugin;
