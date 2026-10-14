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
 * ## 形狀（#1435：第三顆搬上 Cordis 樹的插件）
 *
 * 函式插件，具名匯出 `name`／`inject`／`Config`／`manifest`／`apply`，**沒有 default**（Loader 的 `unwrapExports` 有 default
 * 就取 default，具名的 `inject`／`Config` 會被丟掉；一致性套件的 `export-form` 格擋這個）。相依只有 `@nexus/sdk`、
 * `@nexus/projections`（服務定義，與 `ProjectionUnit`／`SessionEvent`／`isLogicalTurnStart`／`ProjectionDetailError` 的單向轉出）、
 * `@nexus/session`（日誌讀法的單向轉出）與 `@nexus/wire`（線上的形狀）：**沒有一行 import `@nexus/core`**（決議 §3-4 第 17 條；
 * #1420 的 lint 規則擋它）。
 *
 * - 要的服務經 `inject` 宣告（`projections`，`^1.0.0`），在 `apply` 裡經 token 取，登記兩個單元；登記就是 effect，這一列卸載時
 *   登記處自己撤掉。
 * - 兩個單元是純函式的折疊，不碰 `ctx`：樹上這一列卸了之後，開著的對話手上的舊單元照樣能折（決議 §3-2 第 6 條，插件更新只給新對話）。
 * - **沒有設定**：`Config` 是空的 `strictObject`。過去這一列寫了 `config` 只會在啟動時被當成「寫了沒作用」警告；現在寫了未知欄位
 *   會讓這一列在 `config` 那一步掉了（登記的偏離，理由同 `echo`：未知欄位讓載入失敗）。
 * - 唯一的 SDK lint 窄例外：{@link ./trajectory.ts} 的 `inPlaceSizes`（以歸屬表物件為鍵的 `WeakMap` 快取，理由寫在那一行）。
 *
 * 舊的 `NexusPlugin` 外殼（`createTrajectoryPlugin`）不在這裡：它是測試夾具，住在 `apps/harness` 的 `trajectory.fixture.ts`，
 * 包同一個 {@link trajectoryUnit} 與 {@link requestSnapshotsUnit}，讓單元只有一個出處。
 *
 * @module
 */

import type { Context } from '@nexus/cordis';
import { projectionsToken } from '@nexus/projections';
import { defineManifest, injectOf, need, service } from '@nexus/sdk';
import { z } from 'zod';

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

/** 插件在樹上的列用的名字（`ctx.fiber.runtime.name`，錯誤訊息、log 與相容層清單用）。 */
export const name = 'trajectory';

/** 要的服務：`projections`，契約 `^1.0.0`。範圍在這裡宣告，落進 Cordis 的 `Context.intercept`，提供者的 `check` 讀得到。 */
export const inject = injectOf(need(projectionsToken, '^1.0.0'));

/**
 * 這個插件的設定：沒有。`strictObject` 不是隨手選的：manifest 的 `config` 必須是 `strictObject`，未知欄位讓載入失敗是
 * 登記過的偏離，理由見 `@nexus/core` 的 `plugin.ts` 檔頭。
 */
export const Config = z.strictObject({});

export const manifest = defineManifest({
  id: 'trajectory',
  version: '0.1.0',
  owner: '平台團隊',
  provides: [],
  consumes: [{ token: projectionsToken.name, range: '^1.0.0' }],
  config: Config,
  // 換程式碼要重啟行程；沒有設定可改，所以 config 那一格只是照規範填（#1405、決議 §3-2 第 6 條）。
  reload: { code: 'restart', config: 'next-thread' },
  capabilities: [],
});

/**
 * 掛上：把軌跡與請求快照兩個投影單元登記進行程級的投影登記處。
 *
 * @param ctx - 這一列的 Cordis context。
 */
export function apply(ctx: Context): void {
  const projections = service(ctx, projectionsToken);
  projections.register(trajectoryUnit);
  projections.register(requestSnapshotsUnit);
}
