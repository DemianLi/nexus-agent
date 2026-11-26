/**
 * 引用別的會話時，每條來源最多留幾個位元組（[#1573](https://github.com/DemianLi/nexus-agent/issues/1573) N0862）。
 *
 * 預算怎麼算：
 *
 * 1. 設了 `maxReferenceBytes` 就用它，**原樣蓋過**自動預算。
 * 2. 否則 `max(65536, floor(contextWindow × 4 × referenceContextFraction))`。窗口以 token 計，「每 token 4 位元組」是估算的大小，
 *    不是換算。
 * 3. 取不到窗口，用 64 KiB。
 *
 * 這是純函式：**窗口由呼叫端取**（`wire-handler.ts` 組在 `new ThreadPump` 那一處，問這條 thread 的選擇控制器下一步走哪一顆，
 * 再查型錄），這裡不碰日誌、不碰型錄。
 *
 * ## 取不到窗口的兩種情形
 *
 * - **沒有選擇控制器**（腳本模型、沒帶 `--live`）：沒有型錄可查，用 64 KiB。
 * - **路由的模型不在型錄裡**：走不到。控制器的下一步路由跳過型錄沒有的模型，退回部署預設，窗口是部署預設那顆的。
 * - 型錄是同步的純查表（`findModelEntry`），沒有錯誤路徑；取消走 `prepareSessionReferences` 的 `signal`。
 *
 * @module
 */

import { DEFAULT_MAX_REFERENCE_BYTES } from './session-reference.js';

/** 「每 token 約幾個位元組」（`contextWindow * 4 * fraction` 的那個 4）。 */
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
