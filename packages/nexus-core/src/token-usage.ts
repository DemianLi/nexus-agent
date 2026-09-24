/**
 * 會話的 token 總帳：一份會話日誌裡每一顆 `model/usage` 加起來。純折疊，不回寫任何東西。
 * 見 [#574](https://github.com/DemianLi/nexus-agent/issues/574)。
 *
 * 照 dsh 的 `tokenUsage` 投影單元（`packages/llm/token-meter/src/usage-projection.ts`，SHA `477b4f4`）：同樣是
 * `init`／`apply`／`view` 三件、狀態是純 JSON、不相干的事件回同一個參照，值是**整份日誌**的加總——畫面是分頁載入
 * 的、會被摘要改寫，從畫面上加會算錯。
 *
 * ## 跟 dsh 對不上的幾格
 *
 * - **只有兩個桶：輸入、輸出。** dsh 分四桶（未快取輸入、輸出、快取讀、快取寫）。#574 定案第一版不分快取；而且我們的
 *   `inputTokens` **含快取讀取**（LangChain 的語義，見 `model-usage.ts`），dsh 的 `uncachedInputTokens` 不含。兩邊的
 *   「輸入 + 輸出」都是整筆帳，桶的切法不同。
 * - **沒有重試的替換槽。** dsh 的一步可能落好幾次 `assistant/attempt`，同一個 `(turn, step)` 後到的取代先到的，
 *   `llm/retry-started` 再把槽關掉讓重試那次另外加。我們的 `model/usage` 由 `wrapModelCall` 在**成功回來之後**記一顆
 *   （`model-usage.ts`），SDK 自己的重試在它底下、看不見，所以一次呼叫恰好一顆，沒有東西要取代。
 * - **失敗與中止的呼叫不進帳。** dsh 的 `assistant/attempt` 串流裡報了用量就算；我們的記錄器在回應拋錯時根本沒走到
 *   記帳那行。燒掉但沒回來的那幾次，總帳看不到。
 *
 * ## 數字是逐份日誌的
 *
 * subagent 的模型呼叫記進它自己那份（`model-usage.ts` 的 `forCall`），所以 **root 那份的總帳不含子代理**——#574
 * 定案要的正是這個，同 dsh：子代理是另一個會話，`tokenUsage` 只折自己那份。生摘要的那次呼叫不經過
 * `wrapModelCall`，任何一份都沒有它的帳。
 *
 * @module
 */

import type { SessionEvent } from './session-log.js';

/** 整份日誌的總帳。沒有任何一顆 `model/usage` 之前兩格都是 0。 */
export interface TokenUsageTotals {
  /** 每一次呼叫供應商報的 prompt token 數加總，含快取讀取的部分。 */
  readonly inputTokens: number;
  /** 每一次回應的 token 數加總。 */
  readonly outputTokens: number;
}

/**
 * 總帳的單元。形狀照 dsh 的 `ProjectionDefinition`，見檔頭。狀態就是值本身：沒有替換槽要記。
 *
 * `apply` 對不相干的事件回**同一個參照**——dsh 那側拿 `Object.is` 閘住變更流，照抄。
 */
export const tokenUsageUnit = {
  key: 'tokenUsage',
  stateVersion: 1,
  init: (): TokenUsageTotals => ({ inputTokens: 0, outputTokens: 0 }),
  apply: (state: TokenUsageTotals, event: SessionEvent): TokenUsageTotals => {
    if (event.type !== 'model/usage') return state;
    const { inputTokens, outputTokens } = event.data;
    // 兩格都是 0 的那顆不改任何數字，回同一個參照。
    if (inputTokens === 0 && outputTokens === 0) return state;
    return {
      inputTokens: state.inputTokens + inputTokens,
      outputTokens: state.outputTokens + outputTokens,
    };
  },
  view: (state: TokenUsageTotals): TokenUsageTotals => state,
};

/**
 * 把一份日誌從頭折到尾。
 *
 * @param events - 一份日誌的事件，照 `seq` 排。
 * @returns 那一份的總帳。**只有這一份**——subagent 的在它們自己那份，見檔頭。
 */
export function deriveTokenUsage(events: Iterable<SessionEvent>): TokenUsageTotals {
  let state = tokenUsageUnit.init();
  for (const event of events) state = tokenUsageUnit.apply(state, event);
  return tokenUsageUnit.view(state);
}
