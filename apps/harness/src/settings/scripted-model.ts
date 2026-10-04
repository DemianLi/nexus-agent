/**
 * **腳本模型提供者**（[#670](https://github.com/DemianLi/nexus-agent/issues/670)）：把一份固定的回合腳本當成
 * 一個可以被 `agent-default-model` 選到的提供者。出貨的 `cordis.yml` 不放這一列，測試與部署方用 patch `insert`：
 *
 * ```yaml
 * - id: my-script
 *   name: '#settings/scripted-model'
 *   config:
 *     turns:
 *       - { content: '好。' }
 * - id: agent-default-model
 *   config: { provider: my-script }
 * ```
 *
 * 腳本是資料：`content`、可選的 `toolCalls`（`name`／`args`／`id`）、`usage`、`error`、`tokenDelayMs`，欄位照 `ScriptedChatModel`。
 * 沒有用到 `shared` 這種非資料的選項，要用的測試留在手搭的組裝上。
 *
 * 形狀照 dsh 的 `cli-mock-llm`（`packages/test-support/loader-smoke/tests/fixtures/cli-mock-llm.ts:19`）：一顆
 * in-process 的假提供者，不是 HTTP 假端點。載體的偏離（起動期讀、不在 `apply` 裡註冊）見 `model-provider.ts`。
 *
 * @module
 */

import { z } from 'zod';

import type { PluginRegistry } from '@nexus/core';

import type { ModelProviderPlugin } from '../model-provider.js';
import { ScriptedChatModel } from '../scripted-model.js';

/** 這一列在訊息裡叫什麼。 */
export const SCRIPTED_MODEL_PLUGIN_NAME = 'scripted-model';

const toolCallSchema = z.strictObject({
  name: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  id: z.string().min(1).optional(),
});

const turnSchema = z.strictObject({
  content: z.string(),
  toolCalls: z.array(toolCallSchema).optional(),
  usage: z.strictObject({ inputTokens: z.number(), outputTokens: z.number() }).optional(),
  error: z.string().optional(),
  tokenDelayMs: z.number().int().nonnegative().optional(),
});

/** 一格。腳本不能空：空腳本的第一次呼叫就耗盡，載入期擋掉比跑到才錯好讀。 */
export const scriptedModelConfigSchema = z.strictObject({
  turns: z.array(turnSchema).min(1),
});

export type ScriptedModelConfig = z.infer<typeof scriptedModelConfigSchema>;

/** 只講設定的那一顆，外加建模型的函式，見檔頭。 */
export const scriptedModelPlugin: ModelProviderPlugin<ScriptedModelConfig> = {
  name: SCRIPTED_MODEL_PLUGIN_NAME,
  Config: scriptedModelConfigSchema,
  apply: (_registry: PluginRegistry, _config: ScriptedModelConfig): void => {
    // 空的，見檔頭：組裝期沒有消費者。
  },
  createModel: (config) => new ScriptedChatModel({ turns: config.turns }),
};

export default scriptedModelPlugin;
