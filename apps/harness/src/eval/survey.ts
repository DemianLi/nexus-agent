/**
 * 選型調查的候選清單 —— [#85](https://github.com/DemianLi/nexus-agent/issues/85)。
 *
 * ## 這是第三種形狀，不是第三道階梯
 *
 * `tiers.ts` 有兩個概念：**階梯**（同家族、只有尺寸在變）與**判準對照**（證明評分器
 * 量得出 `1.00` 以下）。這一份都不是。它問的是選型：**這把 key 上叫得動的模型，同一份
 * 題目下表現如何**。十六個候選來自八家廠商，中間混著訓練配方、資料、對齊方式 ——
 * 那條線讀不成尺寸效應。
 *
 * 所以它用的是 {@link ModelUnderTest} 而**沒有參數量那兩欄**。這是設計不是偷懶：欄位
 * 不存在，「不是在比尺寸」就從報告裡的一句話變成型別上的事實。想照尺寸排序的人編不過，
 * 而且 `tiers.ts` 的家族斷言一格都不必鬆（#85 明著要求不要鬆它們）。
 *
 * ## 排序是 id 的字典序
 *
 * 刻意的。任何其他順序都會被讀成排名或尺寸 —— 而這份清單兩者都不是。報表照這個順序印。
 *
 * ## 六個 id 同時出現在 `tiers.ts` 裡
 *
 * 那是對的，而且 label **必須**一字不差（`survey.test.ts` 有斷言擋著）：同一個模型在
 * 兩張表上叫不同名字的話，跨報表對照就得靠人腦記憶。重複的是 id 不是資料 —— 尺寸比較
 * 問的是尺寸，這裡問的是選型，同一個模型在兩個問題下各出現一次是正常的。
 *
 * ## 這份清單有保鮮期
 *
 * 來源是 2026-08-29 的盤點（見 {@link SURVEY_INVENTORY_DATE}）：`GET /models` 列 83 個，
 * 逐一送一個帶 `tools` 的請求，回得出 `finish_reason: tool_calls` 的有這 16 個。
 * **前一天同一把 key 量到的是 14 個，而且成員不同** —— 集合綁在帳號上，也綁在時間上。
 * 完整結果與四類分法見 [`.docs/model-inventory.md`](../../../../.docs/model-inventory.md)。
 *
 * **入場判準是一句話一個工具，那證不了它跑得完基準任務。** 這句話 2026-08-29 那一輪
 * 294 次執行印證了：16 個過關的候選裡，**只有 8 個拿得到近乎完整的資料**，3 個資料缺
 * 三分之一，3 個完全沒有（`minimax-m3` 1/21、`kimi-k3` 2/21、`diffgemma-26b` 0/21）。
 *
 * **兩個沒有留在那一輪裡**：`ds-flash` 與 `nano-omni` 在冒煙時（一條難題各跑一次）都撞滿
 * 300 秒的單次上限、一次都沒跑完，繼續跑等於用 3.5 小時換 42 個 `budget`。它們**留在這份
 * 清單裡**是刻意的 —— 清單記的是「盤點時叫得動」，不是「跑得完」；要重跑那一輪的話用
 * `--models` 排除，理由寫在報告裡而不是從清單裡刪掉。
 *
 * 完整結果見 [#85 的報告](https://github.com/DemianLi/nexus-agent/issues/85#issuecomment-5459133975)。
 */

import type { ModelUnderTest } from './model-under-test.js';

/**
 * 選型調查的一個候選。
 *
 * 就是 {@link ModelUnderTest}，**沒有多也沒有少**。取一個名字是為了讓匯入的地方讀得出
 * 意圖，不是為了將來偷偷加欄位 —— 真要加尺寸，先回去讀這個檔的檔頭。
 */
export type SurveyModel = ModelUnderTest;

/** 這份清單是哪一天盤點出來的。報表印它，因為集合會變。 */
export const SURVEY_INVENTORY_DATE = '2026-08-29';

/**
 * 十六個候選，依 model id 的字典序。
 *
 * 行內註解裡的毫秒是**盤點那一次探測**的往返時間（一句話、一個工具、512 token 上限）。
 * 它不是效能數據，只有一個用途：**快的那幾個是限流風險最高的**（#85 第 4 條）。
 */
export const SURVEY_MODELS: readonly SurveyModel[] = [
  { label: 'ds-flash', modelId: 'deepseek-ai/deepseek-v4-flash-0731' }, // 21397ms
  { label: 'ds-pro', modelId: 'deepseek-ai/deepseek-v4-pro-0813' }, //     6405ms
  // 盤點 620ms 過關，完整 agent 迴圈下兩輪各 21 次、0/42 評到分（`500`）。見 .docs/model-inventory.md
  { label: 'diffgemma-26b', modelId: 'google/diffusiongemma-26b-a4b-it' }, // 620ms
  { label: 'gemma-4-31b', modelId: 'google/gemma-4-31b-it' }, //          1404ms
  { label: 'llama-11b', modelId: 'meta/llama-3.2-11b-vision-instruct' }, // 916ms
  { label: 'llama-90b', modelId: 'meta/llama-3.2-90b-vision-instruct' }, // 11053ms
  { label: 'muse-30b', modelId: 'meta/muse-glimmer-30b' }, //             26143ms
  { label: 'minimax-m3', modelId: 'minimaxai/minimax-m3' }, //             1415ms
  { label: 'kimi-k3', modelId: 'moonshotai/kimi-k3' }, //                 18849ms
  { label: 'nano', modelId: 'nvidia/nemotron-3-nano-30b-a3b' }, //         1949ms
  { label: 'nano-omni', modelId: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning' }, // 1250ms
  { label: 'super', modelId: 'nvidia/nemotron-3-super-120b-a12b' }, //     1104ms
  { label: 'ultra', modelId: 'nvidia/nemotron-3-ultra-550b-a55b' }, //     1767ms
  { label: 'oss-120b', modelId: 'openai/gpt-oss-120b' }, //                 779ms
  { label: 'oss-20b', modelId: 'openai/gpt-oss-20b' }, //                   516ms
  { label: 'laguna-xs', modelId: 'poolside/laguna-xs-2.1' }, //            6155ms
];
