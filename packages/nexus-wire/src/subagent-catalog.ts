/**
 * 「這一顆委派呼叫派出的子代理是哪一份會話」上線的形狀（[#1023](https://github.com/DemianLi/nexus-agent/issues/1023)）。
 *
 * 來源是 root 日誌上的 `subagent/catalog`（`@nexus/core` 的 `subagent-catalog.ts`，照 dsh 的同名事件），一顆就送一顆：
 * 載體是協定的 `custom` 事件，`data.name` 是 {@link SUBAGENT_CATALOG}，`payload` 是 {@link SubagentCatalogPayload}。折疊器把
 * 它掛到 `callId` 那張工具卡上（`ToolEntry.subagentSession`），前景與背景同一種。
 *
 * - **即時**：root 記下一顆就送一顆。前景落在子代理第一次寫日誌的那一刻（卡已經開了、還在跑），背景落在派出那一顆收尾之前。
 * - **歷史**：逐顆轉，位置就是日誌上的位置——永遠在配對的 `tool/call` 之後、同一輪之內（一輪不拆兩頁），所以卡一定已經在。
 *   31 以前的日誌沒有這一顆：那張卡沒有這一格，畫面照「沒記」表態，不推論成沒有子代理。
 *
 * **對 dsh 的偏離**：dsh 的目錄走 Session projection（`subagentCatalog` 投影的整份清單）；我們沒有投影通道，每條 thread 各自一條
 * 下行，所以跟 `title`、`todos` 一樣由 pump 合成 `custom` 事件。多一格 `callId` 的理由見 core 那一側。
 *
 * @module
 */

/** `custom` 事件的 `data.name`：一顆委派呼叫派出了一份子會話。 */
export const SUBAGENT_CATALOG = 'subagent/catalog';

/** {@link SUBAGENT_CATALOG} 的 `payload`，與日誌上那一顆同形。 */
export interface SubagentCatalogPayload {
  /** 子會話的 id（`<root>/<runId>`），就是子日誌 header 的 `id`。 */
  readonly childId: string;
  /** 派它的那一顆呼叫：卡的 `callId`。 */
  readonly callId: string;
  /** 前景跑完就結束（`one-shot`），背景的收得到後續的話（`continuable`）。 */
  readonly mode: 'one-shot' | 'continuable';
}

// 名字→酬載表（#685）上屬於這個檔的格子，見 `custom-frame.ts`。
declare module './custom-frame.js' {
  interface CustomFramePayloads {
    [SUBAGENT_CATALOG]: SubagentCatalogPayload;
  }
}
