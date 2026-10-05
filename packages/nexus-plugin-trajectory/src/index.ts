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
 * **伺服器端的整份取代 frame**，沒有「要哪一頁」的往返，所以 view 有上限：**骨架全推、細節按需拉**
 * （[#1083](https://github.com/DemianLi/nexus-agent/issues/1083)）——
 *
 * - 推送的 view 是每輪一列摘要（`digests`），加上**最新一個實體輪**的逐呼叫結構（給進行中的輪即時更新用）。前景子代理的
 *   `run` 輪永不收尾，一律只出摘要。
 * - 其餘細節走單元的 `detail`（{@link ./trajectory.ts} 的 `trajectoryTurnDetail`），host 以 `GET /threads/:id/trajectory/turn`
 *   暴露。錨點（`seq`／`messageId`／`runId`）與「細節不進投影、從日誌重新折」照 dsh 的 `loadThrough(seq)`。
 *
 * **登記的偏離：** (1) dsh 拉的是事件頁、客戶端自己折；我們客戶端沒有折疊器，表達不出「客戶端折」，退到最接近的：同一個
 * `apply` 重放整份日誌，目標邏輯輪釘住不裁。(2) dsh 的投影連最新一輪的細節都不帶；我們多留一個實體輪，因為按需拉不是即時的。
 * 通道本身的偏離登記在 `.docs/session-projections-design.md`。
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
  trajectoryTurnDetail,
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
