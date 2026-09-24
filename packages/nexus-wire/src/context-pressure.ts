/**
 * 用量表上線的形狀（[#528](https://github.com/DemianLi/nexus-agent/issues/528)）：這條對話現在多大、離自動摘要
 * 還有多遠。
 *
 * 照 dsh 的 `contextPressure` 投影（`packages/llm/token-meter/src/projection.ts`，`46a7f68`）：**只算 root**、
 * 可以從日誌重播、每一格各自是「最新那一筆」，不是同一個時刻的原子觀測。所以兩種 `custom` frame 各帶一格，
 * 折疊器各自更新自己那一格：
 *
 * | `data.name` | 來自 root 日誌的 | 更新 |
 * | --- | --- | --- |
 * | {@link MODEL_USAGE} | `model/usage` | `inputTokens` |
 * | {@link CONTEXT_MEASURE} | `context/measure` | `measure` |
 *
 * 歷史路由每一頁都帶「到這一頁結尾為止」最新的那兩顆，所以最後一輪在第一次模型呼叫之前就失敗，重新整理之後
 * 用量表也還在，同即時。
 *
 * ## 與 dsh 的偏離
 *
 * 1. **分母是摘要門檻，不是模型窗口**（#528 的 grilling Q2）：我們的摘要只能用絕對值門檻、跟窗口脫鉤，照抄
 *    窗口會讓環停在約 14% 時較早的訊息就被摘要掉。門檻有幾道就送幾道，web 取最近的那道算比例。
 * 2. **比例的分子是摘要判準拿來比的那個數**：錨在上一次供應商報的實數上、只估增量（`@nexus/core` 的
 *    `token-estimate.ts`，[#588](https://github.com/DemianLi/nexus-agent/issues/588)）。錨照 dsh；估算器與內容比例
 *    不照，理由見那個檔頭。供應商報的 `inputTokens` 另外顯示「目前多大」，兩個數除了行程剛起來的第一次，實測差
 *    在 10% 以內（#586）。
 *
 * **web 要畫的條件是 `measure` 在**，不是 `contextPressure` 不是 `null`：摘要關掉時沒有 `measure`，
 * 但 `model/usage` 照樣會來，那時只有 `inputTokens`。反過來，`model-usage` 條目被關掉時只有 `measure`。
 *
 * @module
 */

/** `custom` 事件的 `data.name`：root 的一次模型呼叫報回了用量。 */
export const MODEL_USAGE = 'model/usage';

/** `custom` 事件的 `data.name`：摘要器量了 root 的一次模型呼叫。 */
export const CONTEXT_MEASURE = 'context/measure';

/** {@link MODEL_USAGE} 的 `payload`。 */
export interface ModelUsagePayload {
  /** 供應商報的 prompt token 數，含快取讀取的部分。 */
  readonly inputTokens: number;
}

/** 一道摘要門檻：`tokens` 比 {@link WireContextMeasure.approxTokens}，`messages` 比 `messageCount`。 */
export interface WireSummaryThreshold {
  readonly type: 'messages' | 'tokens';
  /** 到了（`>=`）就摘要。正的有限數。 */
  readonly value: number;
}

/** {@link CONTEXT_MEASURE} 的 `payload`，也是 {@link WireContextPressure.measure}。 */
export interface WireContextMeasure {
  /** 估算的 token 數：錨在供應商上一次報的實數上、只估增量（#588）。就是門檻拿來比的那個數，**算比例用這個**。 */
  readonly approxTokens: number;
  /** 訊息則數。摘要之後會掉下來。 */
  readonly messageCount: number;
  /** 那次呼叫生效的門檻，並聯，任一成立就摘要，**至少一道**。部署改過就是改過的值——**不要在 web 寫死**。 */
  readonly thresholds: readonly WireSummaryThreshold[];
}

/**
 * `ConversationState.contextPressure`。兩格各自是最新那一筆，可能分別來自不同的呼叫。
 */
export interface WireContextPressure {
  /** 最新一次 root 呼叫供應商報的 prompt 大小。**只拿來顯示「目前多大」**，不拿來算比例。 */
  readonly inputTokens?: number;
  /** 最新一次 root 呼叫摘要器量到的。沒有它就不畫。 */
  readonly measure?: WireContextMeasure;
}
