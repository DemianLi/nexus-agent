/**
 * `@nexus/plugin-token-meter`——把會話日誌折成**逐輪、逐會話的用量**，經 #1026 的投影通道送到 web 的觀測分頁
 * （[#1028](https://github.com/DemianLi/nexus-agent/issues/1028)，地圖 [#1015](https://github.com/DemianLi/nexus-agent/issues/1015)）。
 *
 * 它註冊一個投影單元，**什麼都不寫進日誌、不碰模型、不進圖**，也**不另造總帳**：root 的 token 總帳（`tokenUsage`）與會話統計
 * （`sessionStats`）照舊，這個單元在它們之上補逐輪與子代理，並由測試釘住兩邊對得上。折疊與口徑見 {@link ./fold.ts}，線上的形狀與每個欄位的口徑見
 * `@nexus/wire` 的 `token-meter.ts`。
 *
 * ## 與 dsh 的偏離
 *
 * dsh 的 `token-meter` 是讀日誌的純折疊（`packages/llm/token-meter/src/turn-usage.ts`），畫在每一輪的尾巴。差別：
 *
 * - **載體**：我們走 #1026 的 `projection` frame（整份取代），所以 view 有上限（最近 20 輪、依工具名／模型有名額）。
 * - **子代理**：單元宣告 `children: true`（#1073），root 與每個子代理各折一份，同 dsh 的投影格子按 session 分。
 * - **等待時間**：從收尾的 `turn/end` 起算，不是卡上寫的 `interrupt/raised`（理由見 `fold.ts` 檔頭）。
 *
 * @module
 */

import type { NexusPlugin, PluginEntry, PluginRegistry } from '@nexus/core';
import { tokenMeterUnit } from './fold.js';

export { applyTokenMeter, initialTokenMeter, tokenMeterUnit, viewTokenMeter } from './fold.js';
export type { TokenMeterState } from './fold.js';

/** 用量插件。沒有設定。 */
export const tokenMeterPlugin: NexusPlugin = {
  name: 'token-meter',
  apply(registry: PluginRegistry): void {
    registry.projections.register(tokenMeterUnit);
  },
};

export default tokenMeterPlugin;

/**
 * 建一個條目。
 *
 * @returns 可以放進組裝點清單的條目。
 */
export function createTokenMeterPlugin(): PluginEntry {
  return { plugin: tokenMeterPlugin };
}
