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
  /**
   * 那次呼叫生效的門檻，並聯，**至少一道**。部署改過就是改過的值——**不要在 web 寫死**。
   *
   * `tokens` 那道到了就摘要。`messages` 那道**到了不一定摘要**：保留量是 token 算的（#1374），訊息本身還沒超過保留量時
   * 尾巴蓋住整串、切不出東西，原樣送出。所以只看則數的比例會在不會摘要時顯示到頂（2026-10-14 發版模擬：70／60 則、約 33k token）。
   * 那道到了摘不摘得到，看 {@link messagesCompactable}。
   */
  readonly thresholds: readonly WireSummaryThreshold[];
  /**
   * `messages` 那道門檻到了的話，摘不摘得到東西（[#1443](https://github.com/DemianLi/nexus-agent/issues/1443)）：就是摘要器那一步
   * 實際的保留決定。**不看則數到了沒**——還沒到門檻時也可能是 `true`，`false` 只代表「到了也摘不到」。量的串跟
   * {@link messageCount} 不一定相同：摘要了的那一步量摘要前的串（所以是 `true`），則數是摘要後的；比例照則數算，不受影響。
   *
   * 沒有 `messages` 門檻時沒有這一格。**這一格出現以前的會話日誌也沒有**：重放舊日誌拿到的 `measure` 不帶它，
   * 讀的人照沒有這一格以前的算法，不當成 `false`。
   */
  readonly messagesCompactable?: boolean;
  /**
   * 這份請求的組成（[#1571](https://github.com/DemianLi/nexus-agent/issues/1571) N1193）：系統提示、工具定義、對話訊息各約多少 token，
   * 三格都是非負整數（沒有系統提示或工具時是 `0`）。`systemTokens`、`toolsTokens` 是送出那份請求的純估算；`messageTokens` 是
   * `max(0, approxTokens − systemTokens − toolsTokens)`，所以三格相加等於 {@link approxTokens}——除非前兩格加起來就比
   * `approxTokens` 大，那時 `messageTokens` 是 `0`、三格相加會比 `approxTokens` 大。
   *
   * **缺席＝沒量**：這一格出現以前的會話日誌沒有它，重放舊日誌拿到的 `measure` 不帶它，畫面不畫那三行，不當成 `0`。
   * 偏離 dsh 的理由見 `@nexus/core` 的 `estimateRequestParts`。
   */
  readonly breakdown?: WireContextBreakdown;
}

/** {@link WireContextMeasure.breakdown} 的三格。 */
export interface WireContextBreakdown {
  readonly systemTokens: number;
  readonly toolsTokens: number;
  readonly messageTokens: number;
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

// 名字→酬載表（#685）上屬於這個檔的格子，見 `custom-frame.ts`。
declare module './custom-frame.js' {
  interface CustomFramePayloads {
    [MODEL_USAGE]: ModelUsagePayload;
    [CONTEXT_MEASURE]: WireContextMeasure;
  }
}
