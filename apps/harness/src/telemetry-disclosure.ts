/**
 * 遙測披露——**跟 [`tracing.ts`](./tracing.ts) 是兩件事，刻意分開**。
 *
 * tracing 是 `@langchain/core` 讀環境變數被動生效的，我們一行都沒接；遙測後端是我們
 * 自己掛的。兩者的開關、出境目標、留存策略都不一樣，所以披露分開講——這是
 * [#89](https://github.com/DemianLi/nexus-agent/issues/89) 坑清單自己那條
 * 「不要把 tracing 與遙測併成一個開關」。
 *
 * **`tracing.ts` 那句「追蹤：關閉——不會有 trace 送出去」沒有說反話。** 它的射程本來
 * 就只有 LangSmith 那一道 seam（它自己的模組 JSDoc 與行內註解都寫著），掛了遙測之後
 * 那句話仍然是真的。真正的缺口是**遙測完全沒有自己的一行**：後端把整份會話事件送出去，
 * 畫面上一個字都沒有。這個模組補的是那一行。
 *
 * 規矩照 dsh 的共享披露（`docs/subsystems/session-telemetry.zh.md`）：
 *
 * - **只有一個後端都沒掛的時候才渲染「未配置」。** 掛了就必須說出它的策略——
 *   `sharing` 在可掛載的形上是必填的，就是為了不讓「掛了但沒說」跟「沒掛」長得一樣。
 * - **只陳述策略，不承諾投遞。** 東西會不會真的到、到了留多久，歸上報 SDK 與收端，
 *   不歸這裡。
 * - **關著的時候也印，而且是肯定句**，不留白——留白與「關著」在畫面上分不出來。
 */

import type { SessionTelemetrySharingStatus } from '@nexus/core';

/**
 * 把當前的共享策略寫成要印出去的幾行。
 *
 * @param sharing - 掛著的服務說的策略；**`undefined` 代表一個後端都沒掛**。
 * @returns 要逐行印出去的字串。
 */
export function formatTelemetryDisclosure(
  sharing: SessionTelemetrySharingStatus | undefined,
): readonly string[] {
  if (sharing === undefined) {
    return ['遙測：未配置——沒有掛任何後端，會話事件不會離開這個 process。'];
  }
  switch (sharing) {
    case 'disabled':
      return [
        '遙測：已掛後端，但策略是關閉——不會有會話事件送出去。',
        '遙測：  這只是當前的策略，換一份 plugin 清單就會換。',
      ];
    case 'feedback-only':
      return [
        '遙測：開啟（只在你送出回饋時）——那一刻之前的會話事件會被一起送出去。',
        '遙測：  送什麼由脫敏規則決定；這裡不保證送得到、也不管送到之後留多久。',
      ];
    case 'full':
      return [
        '遙測：開啟——每一筆會話事件都會送出去（turn 邊界、中斷、失敗）。',
        '遙測：  這一版不記訊息內容，但事件的 data 是原文；送什麼由脫敏規則決定。',
        '遙測：  這裡不保證送得到、也不管送到之後留多久。',
      ];
  }
}
