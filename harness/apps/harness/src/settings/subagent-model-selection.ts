/**
 * 子代理逐次選模型的**設定條目**（[#875](https://github.com/DemianLi/nexus-agent/issues/875)，卡
 * [#709](https://github.com/DemianLi/nexus-agent/issues/709)）：開不開，以及模型可以從哪些裡面挑。
 *
 * 欄位名與預設照 dsh `subagent-model-selection`（`packages/subagent/tool-subagent/src/model-selection-settings.ts:38-39`，
 * `477b4f4`）：`enabled` 預設 `false`、`allowedModels` 預設空；零設定時行為與今天相同。
 *
 * **偏離登記：`allowedModels` 是型錄 id 的清單，不是 `{provider, model}`。** dsh 的路由是一對，因為它有多個供應商；我們只有
 * 一個 OpenAI 相容端點與一把 key，型錄條目（`model-catalog.ts`）也沒有 provider 欄位，所以路由就是型錄 id。表達不出來，
 * 退到最接近的那一種。
 *
 * **這一顆不裝功能，只講設定**，`apply` 是空的，同 `background-subagents`。消費點在起動期：`runServe` 解一次、對著
 * `live-model` 的型錄驗，然後**每個新會話取樣一次寫進日誌**（`subagent/model-selection-policy`），之後只讀日誌那份。
 * 跨列的檢查（`allowedModels` 都在型錄裡）寫在 `model-selection-policy.ts`，因為兩列是各自的 schema。
 *
 * @module
 */

import { z } from 'zod';

import type { NexusPlugin, PluginRegistry } from '@nexus/core';

/** 這一列在訊息裡叫什麼。 */
export const SUBAGENT_MODEL_SELECTION_PLUGIN_NAME = 'subagent-model-selection';

/**
 * 一格。`strictObject`：多寫一個欄位是打錯字，不是擴充點。**開著卻沒有可挑的、或清單有重複，是載入期失敗**，照 dsh
 * 取樣時驗設定（`model-selection-settings.ts:53-55`）：一份開著卻挑不出任何東西的政策，只會讓模型每次被拒絕。
 */
export const subagentModelSelectionConfigSchema = z
  .strictObject({
    enabled: z.boolean().default(false),
    allowedModels: z.array(z.string().min(1)).default([]),
  })
  .superRefine((config, ctx) => {
    if (!config.enabled) return;
    if (config.allowedModels.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['allowedModels'],
        message: 'enabled 開著，allowedModels 不能是空的：沒有可挑的模型',
      });
    }
    const seen = new Set<string>();
    for (const [at, id] of config.allowedModels.entries()) {
      if (seen.has(id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['allowedModels', at],
          message: `allowedModels 有重複的模型 "${id}"`,
        });
      }
      seen.add(id);
    }
  });

/** 驗過的設定。 */
export type SubagentModelSelectionConfig = z.infer<typeof subagentModelSelectionConfigSchema>;

/** 只講設定的那一顆，見檔頭。 */
export const subagentModelSelectionPlugin: NexusPlugin<SubagentModelSelectionConfig> = {
  name: SUBAGENT_MODEL_SELECTION_PLUGIN_NAME,
  Config: subagentModelSelectionConfigSchema,
  apply: (_registry: PluginRegistry, _config: SubagentModelSelectionConfig): void => {
    // 空的，見檔頭：組裝期沒有消費者。
  },
};

export default subagentModelSelectionPlugin;
