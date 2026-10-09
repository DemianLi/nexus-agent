/**
 * 會話的 token 總帳：一份會話日誌裡每一顆 `model/usage` 加起來。純折疊，不回寫任何東西。
 * 見 [#574](https://github.com/DemianLi/nexus-agent/issues/574)。
 *
 * 照 dsh 的 `tokenUsage` 投影單元（`packages/llm/token-meter/src/usage-projection.ts`，SHA `477b4f4`）：同樣是
 * `init`／`apply`／`view` 三件、狀態是純 JSON、不相干的事件回同一個參照，值是**整份日誌**的加總——畫面是分頁載入
 * 的、會被摘要改寫，從畫面上加會算錯。
 *
 * ## 四桶（[#724](https://github.com/DemianLi/nexus-agent/issues/724)）
 *
 * 照 dsh 的 `usage-projection.ts:21-25`：未快取輸入、輸出、快取讀、快取寫，**互不重疊**；{@link TokenUsageTotals.inputTokens} 就是未快取那一桶，
 * 完整的輸入由讀的人三桶相加（dsh 的 `StatsPills` 也是自己加）。`model/usage` 的 `inputTokens` 從格式 36 起就是未快取的那一格
 * （見 `model-usage.ts` 的 `ModelUsage`），所以這裡直接加。**2026-10-09 起 `inputTokens` 的語義換成 dsh 的**（#724 收尾，web 已改讀
 * 四桶）：以前它是三桶相加的完整 prompt，現在是未快取；要完整 prompt 的人自己把三桶相加。
 *
 * - **快取兩桶缺席是「沒記」，不是 0**：只要日誌上有一顆報了那一桶，總帳才帶那一格（那一顆報的是 0 也算有報）。舊日誌與供應商不報
 *   快取細節的呼叫沒有它——算命中率的人要把「沒記」與「0」分開，**混著的會話分母裡有不知道快取多少的呼叫**，命中率只是下限。
 * - **舊日誌不必逐版分辨**：35 以前沒有快取兩格，`inputTokens` 本來就是整個 prompt，當未快取、快取當沒記，數字跟以前一樣。
 *
 * ## 跟 dsh 對不上的幾格
 *
 * - **沒有重試的替換槽。** dsh 的一步可能落好幾次 `assistant/attempt`，同一個 `(turn, step)` 後到的取代先到的，
 *   `llm/retry-started` 再把槽關掉讓重試那次另外加。我們的 `model/usage` 由 `wrapModelCall` 記一顆
 *   （`model-usage.ts`），SDK 自己的重試在它底下、看不見，所以一次呼叫**至多**一顆，沒有東西要取代。
 *   串流中段整次重打（#520）排在記錄器外面，每次嘗試各是一次呼叫、各有自己的 `model/usage`，所以失敗那次的用量照樣在帳上。
 *   **代價**：重試掉的中間幾次（它們也可能在串流裡報過用量）不在帳上，只有最後那一次算數。
 * - **失敗與中止的呼叫也進帳**（[#1022](https://github.com/DemianLi/nexus-agent/issues/1022)）：供應商在串流裡報過用量、
 *   之後斷線或被使用者停止的那次呼叫，記成一顆帶 `outcome` 的 `model/usage`，這一道加總照加（那些 token 真的花掉了），
 *   不必認得 `outcome`。**沒報就沒有那一顆**（不是 0），所以漏的仍有一類：OpenAI 相容的串流把用量放在最後一則片段，
 *   中途斷線的多半拿不到——那種呼叫靠 `model/end.outcome` 看得出來「燒了、但不知道多少」。
 *
 * ## 數字是逐份日誌的
 *
 * subagent 的模型呼叫記進它自己那份（`model-usage.ts` 的 `forCall`），所以 **root 那份的總帳不含子代理**——#574
 * 定案要的正是這個，同 dsh：子代理是另一個會話，`tokenUsage` 只折自己那份。
 *
 * **生摘要的那次不在任何一份的 `model/usage` 裡**，同 dsh（它記在 `compaction/summary.usage`、不進 `tokenUsage`）：基座在自己的
 * `wrapModelCall` 裡直接 `request.model.invoke` 生摘要（`summarization.ts` 的 `withQuietSummaryCall` 那段說明），
 * 不經過 `handler`，而記帳只記 `handler` 回來的那一顆。它的用量在 `compaction/summary.usage`（#1022，選填），這一道加總
 * 不含它——要算它的人（#1028）明寫口徑另加。實測在 `apps/harness/src/context-pressure.test.ts` 的
 * 「會話總帳不含生摘要的那一次」。**生標題那一次也不記**：dsh 的標題套件（`session-title*`）沒有任何用量欄位，我們同。
 *
 * @module
 */

import type { SessionEvent } from './session-log.js';

/** 整份日誌的總帳。沒有任何一顆 `model/usage` 之前數字格都是 0，快取兩格缺席。 */
export interface TokenUsageTotals {
  /** 未快取的輸入 token 加總（每顆 `model/usage` 的 `inputTokens`），照 dsh；完整 prompt 是它加上快取兩桶。 */
  readonly inputTokens: number;
  /** 每一次回應的 token 數加總。 */
  readonly outputTokens: number;
  /** 快取讀的加總。**缺席＝日誌上沒有任何一顆報過**，不是 0。 */
  readonly cacheReadTokens?: number;
  /** 快取寫的加總。缺席＝沒記。 */
  readonly cacheWriteTokens?: number;
}

/**
 * 總帳的單元。形狀照 dsh 的 `ProjectionDefinition`，見檔頭。狀態就是值本身：沒有替換槽要記。
 *
 * `apply` 對不相干的事件回**同一個參照**——dsh 那側拿 `Object.is` 閘住變更流，照抄。
 */
export const tokenUsageUnit = {
  key: 'tokenUsage',
  // 2：分四桶（#724）。3：`inputTokens` 的語義換成未快取（#724 收尾）、拿掉並行的 `uncachedInputTokens`。
  stateVersion: 3,
  init: (): TokenUsageTotals => ({ inputTokens: 0, outputTokens: 0 }),
  apply: (state: TokenUsageTotals, event: SessionEvent): TokenUsageTotals => {
    if (event.type !== 'model/usage') return state;
    const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = event.data;
    // 四格都沒東西可加、也沒有快取欄位要記下「有報過」的那顆，不改任何數字，回同一個參照。
    if (
      inputTokens === 0 &&
      outputTokens === 0 &&
      cacheReadTokens === undefined &&
      cacheWriteTokens === undefined
    ) {
      return state;
    }
    return {
      inputTokens: state.inputTokens + inputTokens,
      outputTokens: state.outputTokens + outputTokens,
      ...(cacheReadTokens === undefined && state.cacheReadTokens === undefined
        ? {}
        : { cacheReadTokens: (state.cacheReadTokens ?? 0) + (cacheReadTokens ?? 0) }),
      ...(cacheWriteTokens === undefined && state.cacheWriteTokens === undefined
        ? {}
        : { cacheWriteTokens: (state.cacheWriteTokens ?? 0) + (cacheWriteTokens ?? 0) }),
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
