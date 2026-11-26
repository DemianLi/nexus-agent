/**
 * 插件投影 frame 的合併視窗**設定條目**（[#1071](https://github.com/DemianLi/nexus-agent/issues/1071) 做出合併器，
 * 2026-10-05 的 #1015 決議把視窗做成設定項）。
 *
 * ## 視窗與旋鈕
 *
 * 旋鈕是自然數、最小 1、預設 100，欄位名叫 `flushMs`。
 *
 * 最小值 1：`0` 在合併器的建構子是「不合併」，留給測試，設定層不收。
 *
 * ## 起動期，不是組裝期
 *
 * 消費者是 `ThreadPump`（每條 thread 一顆），由 `createWireHandler` 建；值在 `serve-run.ts` 起動時用 `startupSetting` 解一次、
 * 往下傳一份。`apply` 是空的，同 `tool-text`。改值要重啟（熱重載不接，#46）。
 *
 * ## 這一列關不掉
 *
 * 理由同 `tool-text`：`startupSetting` 把關掉的那一列當成沒有那一列，視窗於是回到 schema 的預設 100——**合併還在**，
 * 關掉的只是「這台機器上它是多少」這句話，讀起來卻像把合併關了。見 `plugin-config.ts` 的 `PROTECTED_ENTRY_REASONS`。
 *
 * ## 調它的人要知道的
 *
 * 視窗只存在於輪中（root 輪外的變更當場送；輪結束與收線一定先送掉所有待送的），所以調大它只會讓**輪中**的投影更新變慢、
 * 下行 frame 變少，**不影響最終值**，歷史＝即時的承諾不變。它對所有插件投影單元共用（軌跡、用量、目標…）。
 *
 * @module
 */

import { z } from 'zod';

import type { NexusPlugin, PluginRegistry } from '@nexus/core';

import { PROJECTION_FLUSH_MS } from '../projection-coalescer.js';

/** 這一列在訊息裡叫什麼。 */
export const PROJECTION_FLUSH_PLUGIN_NAME = 'projection-flush';

/** 一格。`strictObject`：多寫一個欄位是打錯字，不是擴充點。預設值只有一份，在合併器那邊。 */
export const projectionFlushConfigSchema = z.strictObject({
  /** 合併視窗，毫秒。自然數、最小 1。 */
  flushMs: z.number().int().min(1).default(PROJECTION_FLUSH_MS),
});

/** 驗過的設定。 */
export type ProjectionFlushConfig = z.infer<typeof projectionFlushConfigSchema>;

/** 只講設定的那一顆，見檔頭。 */
export const projectionFlushPlugin: NexusPlugin<ProjectionFlushConfig> = {
  name: PROJECTION_FLUSH_PLUGIN_NAME,
  Config: projectionFlushConfigSchema,
  apply: (_registry: PluginRegistry, _config: ProjectionFlushConfig): void => {
    // 空的，見檔頭：組裝期沒有消費者。
  },
};

export default projectionFlushPlugin;
