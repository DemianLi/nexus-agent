/**
 * 「這一輪正在等著重打」上線的形狀（[#520](https://github.com/DemianLi/nexus-agent/issues/520)）：兩顆 `custom` frame。
 * 生產者是 harness 的 `ThreadPump`，在 `@nexus/core` 的 `stream-retry.ts` 通知「排定了重試」與「等完了、要重打」的當下送。
 *
 * ## 要解的事
 *
 * 串流中段出錯、整次重打時，退避期間畫面上沒有任何東西說「在重試」。`message-discard` 擦掉斷尾的那則之後，使用者看到的是
 * 一片空白，直到新的一則開始吐字。這兩顆 frame 讓畫面能在輪尾畫「N 秒後重試」。
 *
 * ## 與 dsh 的關係
 *
 * dsh 的載體是日誌事件 `llm/retry`／`llm/retry-started`（`packages/llm/llm-retry/src/types.ts:9-12`），客戶端折成
 * `model-retry` 節點（`ui-chat/src/client/conversation-nodes/retry.ts:24-48`），在 step 或 turn 關閉時算取消（`:34-37`）。
 * 我們的日誌上也有這兩顆（`delayMs` 只有串流重打有），但**即時下行不從日誌長**：擦除與倒數要和字片段同一條佇列上的順序
 * （`stream-retry.ts` 檔頭），日誌是 pump 另一條路徑。所以這裡是兩顆明講的 frame，欄位取 dsh 事件的子集。
 *
 * ## 折疊
 *
 * {@link WireLlmRetry} 住在 `ConversationState.retry`：`llm-retry` 到就整份換掉（`retryId` 不同也直接換），`since` 取 frame 的
 * 時刻。清成 `null` 的時機：`llm-retry-started`（`retryId` 對得上才清）、下一則 root `message-start`、這一輪收尾（含退避中
 * 按停止）、新一輪開始——後三條是保險，frame 掉了也不會卡一行「N 秒後重試」。**不進歷史**：重新整理之後這一格是 `null`。
 *
 * @module
 */

/** `custom` 事件的 `data.name`：排定了一次重試，正在等。 */
export const LLM_RETRY = 'llm-retry';

/** `custom` 事件的 `data.name`：等完了，下一次嘗試就要開始。 */
export const LLM_RETRY_STARTED = 'llm-retry-started';

/** {@link LLM_RETRY} 的 `payload`。 */
export interface LlmRetryPayload {
  /** 一次模型呼叫的所有重試共用一個。 */
  readonly retryId: string;
  /** 第幾次重試，從 1 起算。 */
  readonly retry: number;
  readonly maxRetries: number;
  /** 這一次要等多久（毫秒）。倒數終點是 frame 的時刻加上它。 */
  readonly delayMs: number;
  /** 失敗的種類，原樣給：`TIMEOUT`、`TRANSPORT`、`RATE_LIMIT`、`SERVER`……中文詞由畫面對。 */
  readonly code: string;
}

/** {@link LLM_RETRY_STARTED} 的 `payload`。 */
export interface LlmRetryStartedPayload {
  readonly retryId: string;
  readonly retry: number;
}

/** 折進 `ConversationState.retry` 的值：{@link LlmRetryPayload} 加上收到的時刻（frame 沒有時刻就不帶）。 */
export interface WireLlmRetry extends LlmRetryPayload {
  /** 排定的時刻（毫秒時間戳）。倒數終點是 `since + delayMs`；沒有就退回「收到的時刻」。 */
  readonly since?: number;
}

// 名字→酬載表（#685）上屬於這個檔的格子，見 `custom-frame.ts`。
declare module './custom-frame.js' {
  interface CustomFramePayloads {
    [LLM_RETRY]: LlmRetryPayload;
    [LLM_RETRY_STARTED]: LlmRetryStartedPayload;
  }
}

/** 一個值是不是合格的 {@link LlmRetryPayload}（執行期驗，下行的東西不全信）。 */
export function toWireLlmRetry(
  payload: object,
  since: number | undefined,
): WireLlmRetry | undefined {
  const { retryId, retry, maxRetries, delayMs, code } = payload as Record<string, unknown>;
  if (
    typeof retryId !== 'string' ||
    retryId === '' ||
    typeof retry !== 'number' ||
    !Number.isFinite(retry) ||
    typeof maxRetries !== 'number' ||
    !Number.isFinite(maxRetries) ||
    typeof delayMs !== 'number' ||
    !Number.isFinite(delayMs) ||
    delayMs < 0 ||
    typeof code !== 'string'
  ) {
    return undefined;
  }
  return { retryId, retry, maxRetries, delayMs, code, ...(since === undefined ? {} : { since }) };
}
