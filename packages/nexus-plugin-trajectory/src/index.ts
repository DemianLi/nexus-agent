/**
 * `@nexus/plugin-trajectory`——把會話日誌折成**逐輪軌跡**，經 #1026 的投影通道送到 web 的觀測分頁
 * （[#1027](https://github.com/DemianLi/nexus-agent/issues/1027)，地圖 [#1015](https://github.com/DemianLi/nexus-agent/issues/1015)）。
 *
 * 它註冊兩個投影單元，**什麼都不寫進日誌、不碰模型、不進圖**：
 *
 * - `trajectory`：每一輪的模型呼叫、重試、用量、工具、決策點，見 {@link ./trajectory.ts}。
 * - `request-snapshots`：每次模型呼叫實際送出的系統提示詞與請求設定，見 {@link ./snapshots.ts}。
 *
 * ## 與 dsh 的偏離
 *
 * dsh 的 `ui-trajectory` 是**客戶端分頁的投影**：瀏覽器依需要向 host 要某一頁軌跡。我們的通道（#1026）是
 * **伺服器端的整份取代 frame**，所以 view 要有上限（最近 8 輪完整、更早只留摘要），不是分頁。原因：通道的 `projection`
 * frame 沒有「要哪一頁」的往返，而重做它不在這張卡的範圍。通道本身的偏離登記在 `.docs/session-projections-design.md`。
 *
 * ## 範圍
 *
 * 兩個單元都宣告 `children: true`（[#1070](https://github.com/DemianLi/nexus-agent/issues/1070)）：root 與**每個子代理自己的日誌**各折一份，
 * 同一個 `apply`、同樣的上限。子代理那份在 web 的 `subagentProjections[runId]`；root 軌跡上派它的那顆工具帶 `subagent` 連結
 * （`runId`、`childId`、`mode`），兩邊靠 `runId` 接起來。**兩個單元要一起展開**：子代理的呼叫上記的 `system`／`header` 是它自己
 * 日誌的 `seq`，快照得跟著它折。
 *
 * 前景子代理的日誌沒有 `turn/start`（從第一次模型呼叫就開始），軌跡從那次呼叫開一輪 `kind: 'run'`，沒有 `end`；背景的有輪，
 * 照一般的輪折。見 {@link ./trajectory.ts} 的 `startRun`。
 *
 * @module
 */

import type { NexusPlugin, PluginEntry, PluginRegistry } from '@nexus/core';
import { requestSnapshotsUnit } from './snapshots.js';
import { trajectoryUnit } from './trajectory.js';

export {
  applyRequestSnapshots,
  initialRequestSnapshots,
  requestSnapshotsUnit,
} from './snapshots.js';
export type { RequestSnapshotsState } from './snapshots.js';
export {
  applyTrajectory,
  initialTrajectory,
  trajectoryUnit,
  viewTrajectory,
} from './trajectory.js';
export type { TrajectoryState } from './trajectory.js';

/** 軌跡插件。沒有設定。 */
export const trajectoryPlugin: NexusPlugin = {
  name: 'trajectory',
  apply(registry: PluginRegistry): void {
    registry.projections.register(trajectoryUnit);
    registry.projections.register(requestSnapshotsUnit);
  },
};

export default trajectoryPlugin;

/**
 * 建一個條目。
 *
 * @returns 可以放進組裝點清單的條目。
 */
export function createTrajectoryPlugin(): PluginEntry {
  return { plugin: trajectoryPlugin };
}
