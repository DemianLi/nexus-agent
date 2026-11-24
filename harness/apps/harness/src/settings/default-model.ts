/**
 * **選模型提供者的那一列**（[#670](https://github.com/DemianLi/nexus-agent/issues/670)）：沒帶 `--live` 時用哪個提供者。
 *
 * 照 dsh `agent-default-model`（`packages/bundle/base/cordis.patch.yml:82-86`，`477b4f4`）。**偏離登記：只有 `provider`，
 * 沒有 `model`。** dsh 的一個供應商底下有多顆模型，所以選擇是 `{provider, model}`；我們的提供者是一整顆模型
 * （腳本提供者沒有「型號」可選，live 的型號歸 `live-model` 那一列），表達不出來，退到最接近的：一個欄位。
 *
 * **這一顆不裝功能，只講設定**，`apply` 是空的，同 `live-model`。消費者是 `model-provider.ts` 的
 * `resolveDefaultModel`，在起動期（建模型之前，註冊表還不存在）讀。完整理由與 `--live` 的關係見那個檔的檔頭。
 *
 * ## 這一列關不掉
 *
 * `disabled: true` 在載入期當場拋：`startupSetting` 把關掉的列當成沒有那一列，值回到預設 `cli-script`，看起來像
 * 關掉了什麼，實際上什麼都沒變。要換提供者是改這一列的 `provider`，不是關它。
 *
 * @module
 */

import { z } from 'zod';

import type { NexusPlugin, PluginRegistry } from '@nexus/core';

/** 這一列在訊息裡叫什麼。 */
export const DEFAULT_MODEL_PLUGIN_NAME = 'default-model';

/** 一格。`provider` 是提供者那一列的 `id`；出貨值 `cli-script` 是 `cordis.yml` 上的腳本提供者那一列。 */
export const defaultModelConfigSchema = z.strictObject({
  provider: z.string().min(1).default('cli-script'),
});

export type DefaultModelConfig = z.infer<typeof defaultModelConfigSchema>;

/** 只講設定的那一顆，見檔頭。 */
export const defaultModelPlugin: NexusPlugin<DefaultModelConfig> = {
  name: DEFAULT_MODEL_PLUGIN_NAME,
  Config: defaultModelConfigSchema,
  apply: (_registry: PluginRegistry, _config: DefaultModelConfig): void => {
    // 空的，見檔頭：組裝期沒有消費者。
  },
};

export default defaultModelPlugin;
