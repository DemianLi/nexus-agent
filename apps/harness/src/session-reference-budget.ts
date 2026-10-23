/**
 * 引用別的會話時，每條來源最多留幾個位元組（[#1573](https://github.com/DemianLi/nexus-agent/issues/1573) N0862）。
 *
 * 照 dsh `SessionReferenceResolver.referenceBudget`（`packages/context/session-reference/src/index.ts`，`1517a4db`／`687f282e`
 * `:378-394`、`22ddee37` `:372-387`；README `:53`，`687f282e`）：
 *
 * 1. 設了 `maxReferenceBytes` 就用它，**原樣蓋過**自動預算。
 * 2. 否則 `max(65536, floor(contextWindow × 4 × referenceContextFraction))`。窗口以 token 計，「每 token 4 位元組」是估算的大小，
 *    不是換算（dsh 原註解）。
 * 3. 取不到窗口，用 64 KiB。
 *
 * 這是純函式：**窗口由呼叫端取**（`wire-handler.ts` 組在 `new ThreadPump` 那一處，問這條 thread 的選擇控制器下一步走哪一顆，
 * 再查型錄），這裡不碰日誌、不碰型錄。
 *
 * ## 取不到窗口的兩種情形
 *
 * - **沒有選擇控制器**（腳本模型、沒帶 `--live`）：沒有型錄可查。對到 dsh 沒有 LLM 服務／沒有 adapter 的那一格（README `:53`：
 *   「A missing route, LLM service, adapter, or capacity uses 64 KiB」），不是偏離。
 * - **路由的模型不在型錄裡**：`modelId` 必須在 `models` 裡、`model.select` 也只收型錄有的（`settings/live-model.ts`），所以只有續接的會話
 *   選過、後來被從型錄拿掉的那一顆走得到。**這一格的 64 KiB 沒有人看得到**：同一步的 `wrapModelCall` 換模型時 `instanceFor(route)` 會在
 *   打供應商之前拋（`model-selection-host.ts:116` 的 `instanceFor`→`:124` 的 `createLiveModel`→`live-model.ts:1700` 呼叫、
 *   `model-catalog.ts:192` 定義的 `requireModelEntry`），這一輪失敗，快照沒有送出去。
 *   dsh 這一格不同（出貨的 `llm-deepseek` 用連線層的 `defaultContextWindow`，`model-info.ts:66-68`），但因為走不到，不登記偏離；
 *   `session-reference-budget-wiring.test.ts` 的最後一條釘住「型錄沒有那顆 → 這一輪在打供應商之前失敗、供應商一個請求都沒收到」。
 * - dsh README 同一句還寫「其他 model metadata 查詢錯誤與取消會讓準備失敗」。我們的型錄是同步的純查表（`findModelEntry`），
 *   沒有錯誤路徑，所以這一格不適用；取消照舊走 `prepareSessionReferences` 的 `signal`。
 *
 * @module
 */

import { DEFAULT_MAX_REFERENCE_BYTES } from './session-reference.js';

/** dsh 的「每 token 約幾個位元組」（`index.ts:393`：`contextWindow * 4 * fraction`）。 */
export const REFERENCE_BYTES_PER_TOKEN = 4;

/**
 * pump 手上的引用政策（`ThreadPump` 的建構參數）：一則訊息最多引用幾條，與這一批要用的每條來源位元組預算。
 *
 * **預算是函式，不是數字**：值跟著模型走，使用者在兩次引用之間換模型，下一次就要用新那顆的窗口。
 */
export interface SessionReferencePolicy {
  /** 一則訊息最多引用幾條不同的會話（`maxReferences`）。 */
  readonly maxReferences: number;
  /** 每條來源最多幾個位元組；每一批領走時叫一次，見 `ThreadPump.#deliverSteps`。 */
  readonly budgetBytes: () => number;
}

/** 預算要用到的三樣：設定列的兩格，與這一步會走的模型的窗口。 */
export interface ReferenceBudgetInput {
  /** `maxReferenceBytes`：給了就用它。 */
  readonly maxReferenceBytes?: number;
  /** `referenceContextFraction`：0 到 1。 */
  readonly referenceContextFraction: number;
  /** 這一步會走的模型的窗口（token）；取不到就是 `undefined`，見檔頭。 */
  readonly contextWindow: number | undefined;
}

/**
 * 每條來源序列化後最多幾個位元組。
 *
 * @param input - 見 {@link ReferenceBudgetInput}。
 * @returns 位元組數，至少 {@link DEFAULT_MAX_REFERENCE_BYTES}（除非 `maxReferenceBytes` 明講更小）。
 */
export function referenceBudgetBytes(input: ReferenceBudgetInput): number {
  if (input.maxReferenceBytes !== undefined) return input.maxReferenceBytes;
  const { contextWindow } = input;
  if (contextWindow === undefined) return DEFAULT_MAX_REFERENCE_BYTES;
  return Math.max(
    DEFAULT_MAX_REFERENCE_BYTES,
    Math.floor(contextWindow * REFERENCE_BYTES_PER_TOKEN * input.referenceContextFraction),
  );
}
