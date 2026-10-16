/**
 * 下行被協定層拒絕：開串流的 HTTP 請求回了 **200**，body 卻是 error 封包 `{ type: 'error', error, message }`
 * 而不是 SSE（thread 數到上限的 `thread_at_capacity`、`channels` 不合法的 `invalid_argument`……）。
 * 這是「server 講理由拒絕」，不是載體層出事——載體層（非 2xx）仍是一般的 `Error`
 * （[#1481](https://github.com/DemianLi/nexus-agent/issues/1481)）。
 *
 * 命令路徑早就把碼結構化往上帶（`{ kind: 'rejected', code, message }`）；開串流是拋出的，所以用錯誤類別帶，
 * 呼叫端讀 {@link WireRejectedError.code} 分支，**不要解析 `message`**。
 *
 * ## 偏離（依 AGENTS.md 登記）
 *
 * dsh 沒有「HTTP 上開串流、被協定層以 200 拒絕」這條路：它的 SDK client 是 JSON-RPC over stdio，串流就是
 * 通知，沒有「開」這個動作可以被拒（`packages/sdk/client/src/client.ts`）；它的 Connection 層則把失敗放進結果
 * 值（`ConnectionRpcFailure`：`code`、`message`、`details`，`packages/client/connection/src/rpc.ts:19`），不拋。
 * 形狀照最近的會拋的那個：`JsonRpcResponseError`（`packages/sdk/protocol/src/transport.ts:18`）——建構子參數
 * 屬性保留線上的碼、設 `name`。兩處不同：
 *
 * - `message` 不是線上的原文，而是 `下行被拒：<body 原文>`：這條訊息今天就長這樣，web 直接顯示、既有測試也按字串
 *   斷言，所以逐字維持；線上的 `message` 另放在 {@link WireRejectedError.serverMessage}。
 * - `code` 是字串（我們的協定碼），不是 JSON-RPC 的數字。
 *
 * @module
 */

/**
 * 下行被協定層拒絕。`message` 維持舊格式（`下行被拒：<body>`／`全域下行被拒：<body>`），只看字串的舊呼叫端不受影響。
 */
export class WireRejectedError extends Error {
  /**
   * @param code - server 的 `error` 欄位（例如 `thread_at_capacity`）；型別是 `string` 而不是 `WireErrorCode`，
   *   因為新 server 可能送這一版 client 還不認得的碼。
   * @param serverMessage - server 的 `message` 欄位原文；server 沒給就是一句固定的說明。
   * @param message - 這個 `Error` 自己的訊息（含前綴與 body 原文）。
   */
  constructor(
    readonly code: string,
    readonly serverMessage: string,
    message: string,
  ) {
    super(message);
    this.name = 'WireRejectedError';
  }
}
