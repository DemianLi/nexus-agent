/**
 * 這條對話累計燒了多少上線的形狀（[#574](https://github.com/DemianLi/nexus-agent/issues/574)）：token 總帳與會話統計。
 *
 * 照 dsh 的兩個投影：`tokenUsage`（`packages/llm/token-meter/src/usage-projection.ts`）與 `sessionStats`
 * （`packages/session/session-stats/src/projection.ts`），SHA `477b4f4`。兩個都是**讀整份 root 日誌折出來的**、
 * 值是整個投影、後到的取代先到的。dsh 的 `StatsPills` 讀的是它們，不是畫面：畫面分頁載入、會被摘要改寫，從畫面上
 * 加會算錯（它自己的註解，`packages/client/ui-chat/src/client/chat/StatsPills.tsx:41-52`）。
 *
 * | `data.name` | `payload` | 折自 root 日誌的 |
 * | --- | --- | --- |
 * | {@link TOKEN_USAGE} | {@link WireTokenUsage} | 每一顆 `model/usage` |
 * | {@link SESSION_STATS} | {@link WireSessionStats} | 輪、模型呼叫、工具呼叫的起訖 |
 *
 * 折疊本身在 `@nexus/core`（`token-usage.ts`、`session-stats.ts`），規則與跟 dsh 對不上的幾格寫在那兩個檔頭。
 *
 * ## 什麼時候送
 *
 * - **即時**：pump 在 root 日誌每寫一顆就套進折疊，**值變了才送**（dsh 的 `Object.is` 閘門，比的是值不是狀態）。
 * - **歷史**：每一頁各帶一顆「到這一頁結尾為止」的值，同用量表。
 * - **兩邊同一條判準：值還是初值（全部 0）就不送**。一條還沒叫過模型的 thread 即時收不到這兩種，歷史也不送，
 *   折疊器那一格維持 `null`——重新整理之後不會比即時多出一個「0 token」。
 *
 * ## 總量由讀的那一側加
 *
 * 只送輸入、輸出兩格，不送總量：dsh 的 `StatsPills` 也是自己把各桶加起來（`:241-242`）。我們的 `inputTokens` 含快取
 * 讀取，所以兩格相加就是整筆帳。
 *
 * ## 與 dsh 的偏離
 *
 * 1. **載體是 `custom` frame，不是投影註冊表與連線快照。** 我們沒有 `session-projection` 那一層；用量表、待辦清單
 *    已經用這個載體，這裡照抄：即時由 pump 合成、歷史每頁帶一顆，web 那側的「連線快照」就是最後一頁歷史。
 * 2. **初值在 server 端就不送，dsh 送、由畫面擋。** dsh 的快照帶每一個已登記的投影，還沒計費時就是一組 0
 *    （`packages/session/session-projection/src/index.ts:338`）；`StatsPills` 自己擋：token 要大於 0 才算有
 *    （`:330`），沒有步也沒有 token 就整顆不畫（`:347`）。我們沒有連線快照，即時只在變的時候送，歷史若照送 0，
 *    重新整理就會比即時多一顆——所以兩邊都不送。**web 把 `null` 當成 dsh 的「全是 0」處理**，畫面結果相同。
 *
 * @module
 */

/** `custom` 事件的 `data.name`：root 日誌的 token 總帳現在是這樣。同 dsh 的投影名。 */
export const TOKEN_USAGE = 'tokenUsage';

/** `custom` 事件的 `data.name`：root 日誌的會話統計現在是這樣。同 dsh 的投影名。 */
export const SESSION_STATS = 'sessionStats';

/** {@link TOKEN_USAGE} 的 `payload`，也是 `ConversationState.tokenUsage`。 */
export interface WireTokenUsage {
  /** root 每一次模型呼叫的 prompt token 數加總，**含快取讀取**。 */
  readonly inputTokens: number;
  /** root 每一次回應的 token 數加總。 */
  readonly outputTokens: number;
}

/** {@link SESSION_STATS} 的 `payload`，也是 `ConversationState.sessionStats`。 */
export interface WireSessionStats {
  /** 至少叫過一次模型的輪。核准之後接著跑的那一段併回前一輪。 */
  readonly turns: number;
  /** 結束了的 root 模型呼叫——完成、失敗、中止都算。 */
  readonly steps: number;
  /** 模型呼叫的牆鐘總和，ms。 */
  readonly llmMs: number;
  /** 工具呼叫的牆鐘總和，ms。核准的等待不算。 */
  readonly toolMs: number;
}
