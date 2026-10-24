/**
 * **重放模型提供者**（[#1556](https://github.com/DemianLi/nexus-agent/issues/1556) C077）：把一份錄好的模型呼叫腳本當成一個可以被
 * `agent-default-model` 選到的提供者，形狀同 `scripted-model.ts`。不在出貨清單上；snapshot 場景用 patch `insert` 這一列、
 * 再把選擇列指過去（`snapshot/harness.ts`）。
 *
 * 腳本是資料：每一次呼叫要吐的那一則 `assistant/message`（日誌裡的 `LoggedMessage`），由 harness 從夾具讀出來（走日誌的正式讀方），
 * 不在這裡讀檔——`createModel` 是同步的。
 *
 * 照 dsh 的重放提供者（`packages/test-support/llm-replay/src/index.ts`，`687f282e`）：in-process，不是 HTTP 假端點。
 *
 * @module
 */

import { z } from 'zod';

import type { LoggedMessage, PluginRegistry } from '@nexus/core';

import { ReplayChatModel } from '../llm-replay.js';
import type { ModelProviderPlugin } from '../model-provider.js';

/** 這一列在訊息裡叫什麼。 */
export const REPLAY_MODEL_PLUGIN_NAME = 'replay-model';

const loggedMessageSchema = z.looseObject({
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
});

/** 一格。腳本不能空：空腳本的第一次呼叫就耗盡。 */
export const replayModelConfigSchema = z.strictObject({
  script: z.array(loggedMessageSchema).min(1),
});

export type ReplayModelConfig = z.infer<typeof replayModelConfigSchema>;

/** 只講設定的那一顆，外加建模型的函式。每條 thread 各建一顆，腳本從第一次呼叫開始吃。 */
export const replayModelPlugin: ModelProviderPlugin<ReplayModelConfig> = {
  name: REPLAY_MODEL_PLUGIN_NAME,
  Config: replayModelConfigSchema,
  apply: (_registry: PluginRegistry, _config: ReplayModelConfig): void => {
    // 空的：組裝期沒有消費者，同 `scripted-model.ts`。
  },
  createModel: (config) =>
    new ReplayChatModel({ script: config.script as unknown as readonly LoggedMessage[] }),
};

export default replayModelPlugin;
