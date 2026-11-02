/**
 * 「這顆錯是模型呼叫拋出來的」的記號（[#1437](https://github.com/DemianLi/nexus-agent/issues/1437)）。
 *
 * 失敗分類器要認幾種**只看結構、不看訊息**的連線與串流中段錯誤（undici 的 `UND_ERR_*`、`ECONNRESET`、SDK 在串流中段拋的沒有
 * `status` 的 `APIError`）。這些形狀在**工具 middleware 拋的錯**裡也會出現——MCP 伺服器連不上就是一顆 cause 帶
 * `ECONNREFUSED` 的工具失敗，它不該被記成模型的 `TRANSPORT`、網頁也不該說「連線失敗」。
 *
 * 所以分類器只在錯誤鏈上**有這個記號**時才套那幾條：記號由「一定是模型呼叫拋的」那幾處打——**我們這串 `wrapModelCall` 的最內層**
 * （{@link ./turn-cancel.ts | turnCancelModelSignal}，所有圖裡的模型呼叫都經過）與 `AsyncCaller` 的 `onFailedAttempt`（不在圖裡的呼叫：標題、
 * 摘要器、eval）。用 `WeakSet` 而不是往錯誤上塞欄位：那顆錯可能是別人家的、可能被凍結，記號不該改它的形狀。
 *
 * ## 為什麼標在最內層，不是 `emptyResponse` 那一層（#1778）
 *
 * `emptyResponse` 在 plugin 的 `wrapModelCall`（`plugins.rest`、`plugins.last`、子代理自帶的 `spec.middleware`）**外面**，它的 `catch` 收到的
 * 是內側每一層丟出來的錯——插件自己拋的錯也在內。#1763 之後記號在剝包裝時保留，於是插件 `wrapModelCall` 拋的、cause 帶 `ECONNREFUSED`
 * 的錯也被標成模型呼叫、記成 `TRANSPORT`，跟上面「工具 middleware 的連不上不是模型的 `TRANSPORT`」同一條矛盾。
 * 最內層只有 handler 直接呼叫模型（以及基座 deepagents 自帶、排在我們這串更後面的幾顆，它們不是插件、不做網路 I/O）：插件的錯一律在它外面，
 * 看不到、標不到。標記不另開一格 middleware：`turnCancelModelSignal` 本來就是最內層，多一格會讓每一份 middleware 順序的斷言都跟著動。
 */

const modelCallFailures = new WeakSet<object>();

/**
 * 記下這顆錯是模型呼叫拋出來的。非物件（字串之類）記不住，略過。
 *
 * @param error - 模型呼叫拋出來的東西。
 */
export function markModelCallFailure(error: unknown): void {
  if (typeof error === 'object' && error !== null) modelCallFailures.add(error);
}

/**
 * 這顆錯是不是被 {@link markModelCallFailure} 記過。
 *
 * @param error - 要問的錯誤（錯誤鏈上的一環）。
 * @returns 記過就是真。
 */
export function isModelCallFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null && modelCallFailures.has(error);
}
