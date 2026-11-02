import type { WireLlmRetry } from '@nexus/wire';

import { failureCodeText } from '@/lib/trajectory-view';

/**
 * 串流中段出錯、整次重打時輪尾那一行（[#520](https://github.com/DemianLi/nexus-agent/issues/520)）：「逾時，3 秒後重試（第 1／2 次）」。
 * 資料是 `ConversationState.retry`（wire 的 `llm-retry` frame 折出來的一格，沒有在重試就是 `null`）。載體照 dsh 的 `llm/retry`
 * （`conversation-nodes/retry.ts`、`MessageItem.tsx`），樣式是我們自己的。
 *
 * **倒數從這一台收到的時刻起算，不讀 frame 的 `since`**：`since` 是伺服器的時鐘，伺服器與瀏覽器不在同一台、時鐘差幾秒時，
 * 倒數會一開始就少幾秒或多幾秒；收到的時刻只差一趟網路。代價是退避中途重連時倒數重新數，而那一格會在下一則回覆開始時清掉，
 * 所以只是一兩秒的出入。過了終點不倒數成負數，改寫「正在重試」。
 *
 * @module
 */

/** 倒數走完（或 `delayMs` 是 0）之後的那一句：等完了、下一次嘗試馬上開始或已經在等回應。 */
export const RETRYING_NOW_TEXT = '正在重試';

/** 這一次等多久還剩幾毫秒；過了終點是 0，不會是負的。 */
export function retryRemainingMs(retry: WireLlmRetry, receivedAt: number, now: number): number {
  return Math.max(0, retry.delayMs - (now - receivedAt));
}

/**
 * 輪尾那一行的字：失敗的原因（沿用失敗輪標頭那張表，不認得的碼原樣顯示）、還剩幾秒（無條件進位，倒數不會在還有 0.3 秒時
 * 就寫成「0 秒」）、第幾次。
 */
export function retryNoticeText(retry: WireLlmRetry, remainingMs: number): string {
  const reason = failureCodeText(retry.code);
  const times = `第 ${retry.retry}／${retry.maxRetries} 次`;
  return remainingMs > 0
    ? `${reason}，${Math.ceil(remainingMs / 1000)} 秒後重試（${times}）`
    : `${reason}，${RETRYING_NOW_TEXT}（${times}）`;
}
