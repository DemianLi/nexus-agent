/**
 * 交付事件上線的形狀（[#441](https://github.com/DemianLi/nexus-agent/issues/441)）。
 *
 * 載體是協定的 `custom` 事件：`method: 'custom'`，`data: { name, payload }`（`@langchain/protocol`
 * 的 `CustomEvent`）。`name` 是 {@link DELIVERABLES_PRESENTED}，`payload` 是 {@link DeliverablesPresentedPayload}。
 * 即時由 pump 從 root 那一份日誌的 `deliverables/presented` 合成，重新整理由歷史路由從同一顆事件合成，
 * 兩條路產出同一種 frame。**只有 root 那一份**：子代理宣告的交付留在子代理的日誌裡，兩條路都不送。
 *
 * 這裡只放形狀——`@nexus/wire` 不相依 `@nexus/core`，所以 `PresentedFile` 在這裡另寫一份，兩份的
 * 欄位要一樣（core 那份是 `SessionEventMap['deliverables/presented']`）。
 *
 * @module
 */

/** `custom` 事件的 `data.name`：一次成功的 `present` 宣告交付了這幾個檔案。 */
export const DELIVERABLES_PRESENTED = 'deliverables/presented';

/** 一個宣告交付的檔案，模型給的原樣。 */
export interface WirePresentedFile {
  /** 相對路徑以工作區根為準。前端不解析它。 */
  readonly path: string;
  /** 給使用者的一句說明。沒給就沒有這個 key。 */
  readonly description?: string;
}

/**
 * `custom` 事件 `data.payload` 的形狀。
 *
 * **沒有輪的編號**：這一顆屬於它在串流裡落在的那一輪（即時與歷史的順序一樣），見 core 的
 * `SessionEventMap['deliverables/presented']`。
 */
export interface DeliverablesPresentedPayload {
  /** 那次 `present` 呼叫的 `tool_call_id`，對得上同一輪那張 `present` 工具卡。 */
  readonly callId: string;
  /** 通過檢查的檔案，順序照模型給的。 */
  readonly files: readonly WirePresentedFile[];
}
