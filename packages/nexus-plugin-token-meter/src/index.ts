/**
 * `@nexus/plugin-token-meter`——把會話日誌折成**逐輪、逐會話的用量**，經 #1026 的投影通道送到 web 的觀測分頁
 * （[#1028](https://github.com/DemianLi/nexus-agent/issues/1028)，地圖 [#1015](https://github.com/DemianLi/nexus-agent/issues/1015)）。
 *
 * 它註冊一個投影單元，**什麼都不寫進日誌、不碰模型、不進圖**，也**不另造總帳**：root 的 token 總帳（`tokenUsage`）與會話統計
 * （`sessionStats`）照舊，這個單元在它們之上補逐輪與子代理，並由測試釘住兩邊對得上。折疊與口徑見 {@link ./fold.ts}，線上的形狀與每個欄位的口徑見
 * `@nexus/wire` 的 `token-meter.ts`。
 *
 * ## 形狀（#1421：第二顆搬上 Cordis 樹的插件）
 *
 * 函式插件，具名匯出 `name`／`inject`／`Config`／`manifest`／`apply`，**沒有 default**（Loader 的 `unwrapExports` 有 default
 * 就取 default，具名的 `inject`／`Config` 會被丟掉；一致性套件的 `export-form` 格擋這個）。相依只有 `@nexus/sdk`、
 * `@nexus/projections`（服務定義，與 `@nexus/core` 的 `ProjectionUnit`／`SessionEvent`／`isLogicalTurnStart` 的單向轉出）
 * 與 `@nexus/wire`（線上的形狀）：**沒有一行 import `@nexus/core`**（決議 §3-4 第 17 條；#1420 的 lint 規則擋它）。
 *
 * - 要的服務經 `inject` 宣告（`projections`，`^1.0.0`），在 `apply` 裡經 token 取。
 * - 登記單元是 effect：這一列卸載時登記處自己撤掉。
 * - 單元本體是純函式的折疊（{@link ./fold.ts}），不碰 `ctx`：樹上這一列卸了之後，開著的對話手上的舊單元照樣能折
 *   （決議 §3-2 第 6 條，插件更新只給新對話）。
 * - **沒有設定**：`Config` 是空的 `strictObject`。過去這一列寫了 `config` 只會在啟動時被當成「寫了沒作用」警告；現在寫了
 *   未知欄位會讓這一列在 `config` 那一步掉了（登記的偏離，理由同 `echo`：未知欄位讓載入失敗）。
 *
 * 舊的 `NexusPlugin` 外殼（`createTokenMeterPlugin`）不在這裡：它是測試夾具，住在 `apps/harness` 的
 * `token-meter.fixture.ts`，包同一個 {@link tokenMeterUnit}，讓單元只有一個出處。
 *
 * ## 與 dsh 的偏離
 *
 * dsh 的 `token-meter` 是讀日誌的純折疊（`packages/llm/token-meter/src/turn-usage.ts`），畫在每一輪的尾巴。差別：
 *
 * - **載體**：我們走 #1026 的 `projection` frame（整份取代），所以 view 有上限（最近 20 輪、依工具名／模型有名額）。
 * - **子代理**：單元宣告 `children: true`（#1073），root 與每個子代理各折一份，同 dsh 的投影格子按 session 分。
 * - **等待時間**：從收尾的 `turn/end` 起算，不是卡上寫的 `interrupt/raised`（理由見 `fold.ts` 檔頭）。
 * - **形狀**：dsh 的 `token-meter` 是一個有 `Config` 的 `Service`，在建構子裡登記三個單元（usage、pressure、breakdown）；
 *   這裡是一個單元、沒有設定。這不另外登記偏離：「`inject` 加上 `register`」這個寫法是一樣的。
 *
 * @module
 */

import type { Context } from '@nexus/cordis';
import { projectionsToken } from '@nexus/projections';
import { defineManifest, injectOf, need, service } from '@nexus/sdk';
import { z } from 'zod';

import { tokenMeterUnit } from './fold.js';

export { applyTokenMeter, initialTokenMeter, tokenMeterUnit, viewTokenMeter } from './fold.js';
export type { TokenMeterState } from './fold.js';

/** 插件在樹上的列用的名字（`ctx.fiber.runtime.name`，錯誤訊息、log 與相容層清單用）。 */
export const name = 'token-meter';

/** 要的服務：`projections`，契約 `^1.0.0`。範圍在這裡宣告，經 `Service.resolveIntercept` 合併，提供者的 `check` 讀得到。 */
export const inject = injectOf(need(projectionsToken, '^1.0.0'));

/**
 * 這個插件的設定：沒有。`strictObject` 不是隨手選的：manifest 的 `config` 必須是 `strictObject`，未知欄位讓載入失敗是
 * 登記過的偏離，理由見 `@nexus/core` 的 `plugin.ts` 檔頭。
 */
export const Config = z.strictObject({});

export const manifest = defineManifest({
  id: 'token-meter',
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
 * 掛上：把用量投影單元登記進行程級的投影登記處。
 *
 * @param ctx - 這一列的 Cordis context。
 */
export function apply(ctx: Context): void {
  service(ctx, projectionsToken).register(tokenMeterUnit);
}
