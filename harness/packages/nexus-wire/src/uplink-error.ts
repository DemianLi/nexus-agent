/**
 * 上行被載體層擋下：命令的 HTTP POST 回了非 2xx（反向代理的 502／504、驗證擋下的 401、server 掛了的 5xx……）。
 * 這是「線上出了事」，不是命令自己的結果——命令被收下之後的拒絕走 `UplinkResult` 的 `rejected`，不經這裡
 * （[#1355](https://github.com/DemianLi/nexus-agent/issues/1355)）。
 *
 * 呼叫端要分辨「不確定這一句有沒有送到」（502、504：請求可能已經到了 server、回應斷在半路）與「確定沒送出去」
 * （其他狀態碼）時，讀 {@link UplinkTransportError.status}，不要去解析 `message`。
 *
 * ## 偏離（依 AGENTS.md 登記）
 *
 * dsh 沒有 HTTP 上行：它的 SDK client 是 JSON-RPC over stdio，沒有 HTTP 狀態碼可抄（`packages/sdk/client/src/client.ts`
 * 只有 `TransportClosedError`、`RequestTimeoutError`、`SdkProtocolError`，都不帶狀態碼）。形狀照最近的
 * `JsonRpcResponseError`（`packages/sdk/protocol/src/transport.ts:18`）：建構子參數屬性保留載體層的欄位（那邊是
 * `code`／`data`，這裡是 `status`／`body`）、設 `name`、`message` 是一句人話。基座（`fetch`）表達不出的是「帶狀態碼的
 * 失敗」——`fetch` 對非 2xx 不拋，只給 `Response`，所以這個型別得自己定。
 *
 * @module
 */

/** 上行回了非 2xx。`message` 維持舊格式 `上行被載體層擋下：<status> <body>`，只看字串的舊呼叫端不受影響。 */
export class UplinkTransportError extends Error {
  /**
   * @param status - HTTP 狀態碼。
   * @param body - 回應本文（文字）；可能是空字串，也可能是反向代理的 HTML 頁。
   */
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`上行被載體層擋下：${String(status)} ${body}`);
    this.name = 'UplinkTransportError';
  }
}
