/**
 * 伺服器送來的資料形狀不對（[#1555](https://github.com/DemianLi/nexus-agent/issues/1555) N0758）：下行的一顆 frame、歷史頁裡的一筆事件，
 * 缺了折疊器要讀的欄位、或欄位型別不對。**終止類**的錯：重連換來的還是同一份資料（歷史裡的壞事件每次都抓到同一顆），
 * 所以收到它的一側該停止自動重連、等人按立刻重連（web 那一半在 #1601）。
 *
 * ## 偏離（依 AGENTS.md 登記）
 *
 * dsh 對同一類事沒有專屬的錯誤類別：`assertSessionWireEvent` 拋一般的 `Error`（`packages/api/session-controller/src/client/session-wire-event.ts:14-46`，
 * `687f282e`），**反過來把「載體斷了」標成專屬類別** `RemoteStreamCarrierError`（`packages/api/gateway/src/client/stream-client.ts:15`），
 * 只有它會自動續接，其餘一律終止串流（`session-controller/README.md:54`）。理由 1（基座表達不出來）：我們的 web 現在把下行的**任何**錯誤
 * 都當成載體斷線去退避重連（`apps/web/src/hooks/use-conversation.ts` 的 `lose` 路徑），沒有可以分辨的載體類別；與其先替所有載體錯誤補一個類別，
 * 不如把終止類標出來，其餘維持原樣。分類的語意相同（協定錯誤終止、只有載體斷線續接），標的那一邊相反。
 *
 * @module
 */

/**
 * 伺服器送來的資料形狀不對。呼叫端讀 {@link WireProtocolError.field} 分支與顯示，**不要解析 `message`**。
 */
export class WireProtocolError extends Error {
  /**
   * @param field - 哪個欄位不對，用點與方括號寫成路徑：`seq`、`params.namespace`、`events[3].method`。整份資料解不開時是 `data`。
   * @param message - 這個 `Error` 自己的訊息。
   * @param options - 底層的錯（例如 `JSON.parse` 拋的）。
   */
  constructor(
    readonly field: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WireProtocolError';
  }
}
