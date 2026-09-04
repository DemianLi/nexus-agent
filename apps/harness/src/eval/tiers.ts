/**
 * 走完整基準任務量過的模型 —— 開發計劃第 5 節 Phase 5，
 * [#31](https://github.com/DemianLi/nexus-agent/issues/31) 三項收斂裡的模型定案那一項。
 *
 * ## 這個檔案原本是兩道尺寸階梯，2026-09-05 收掉了（[#167](https://github.com/DemianLi/nexus-agent/issues/167)）
 *
 * 收的理由有兩層，而**順序不能倒過來** —— 先是問題結案，才輪到裝置壞掉。
 *
 * **第一層：那個問題已經有答案了。** 「工具呼叫的品質會不會隨模型變小而崩」這條線是
 * [#83](https://github.com/DemianLi/nexus-agent/pull/83) → [#84](https://github.com/DemianLi/nexus-agent/pull/84)
 * → [#86](https://github.com/DemianLi/nexus-agent/pull/86) → [#87](https://github.com/DemianLi/nexus-agent/pull/87)，
 * 三輪（n=6、n=12、七題全跑 n=6）得到同一個結果：20B–550B 這五階的參數正確性落在
 * `0.88`–`0.98`，而判準**沒有**飽和（全距下探到 `0.33`）—— **尺寸沒有在那個量程上動**。
 * 開發計劃第 5 節在 2026-08-28 就把這條線收掉並宣告 Phase 5 完成。**那是一個有效力的
 * 否定結論，不是「量不出來」。** 所以這裡收掉的是**一個已結案的問題留下來的裝置**。
 *
 * **第二層：端點把裝置拆了，而且補不回來。** 2026-09-04 重盤（方法見下）：
 * `openai/gpt-oss-120b` 下架（`410`，EOL `2026-09-03T08:00:00Z`）、
 * `nvidia/nemotron-3-nano-30b-a3b` 不在型錄裡了。`GPT_OSS_LADDER` 只剩一階，
 * `NEMOTRON_3_LADDER` 的底板沒了，而**這把 key 上湊不出第三道**：可用的九個裡沒有任何兩個
 * 同家族（`google/diffusiongemma-` 與 `google/gemma-4-` 是兩家、`nvidia/nemotron-3-` 與
 * `nvidia/nemotron-3.5-` 也是）。
 *
 * **唯一的例外查過了，而它是死的。** `meta/llama-3.2-` 的 `11b` + `90b` 本來接得住全部三條
 * 斷言（同前綴、總量 11 → 90 遞增、兩個 id 都沒有 `-aNb` 後綴、`11 < 30` 也補得上底板）。
 * 兩輪各三次探測 —— 2026-09-04 與 2026-09-05（UTC `2026-09-04T16:57Z`）—— **90b 六次全部
 * 90 秒逾時**，同一輪的 11b 三次全過（0.9–3.3 秒）。它還在型錄上，只是打不到。
 * 這就是 [#57](https://github.com/DemianLi/nexus-agent/issues/57) 那個失敗模式。
 *
 * ## 要重建的話，驗收條件是這四條
 *
 * 前三條原本是 `tiers.test.ts` 裡的斷言，跟著資料一起刪了 —— **留著空陣列跑那三個
 * `for` 迴圈，是三條永遠綠的測試**。翻過來寫，它們就是重建的驗收條件：
 *
 * 1. **每道階梯至少兩階。** 只有一階就沒有同家族對照，量到的衰減分不出是尺寸還是
 *    這一家的訓練配方。真的只有一個 id 可跑時，那是 {@link SCORER_CONTROL} 那條路。
 * 2. **同一道階梯上每個 id 都以同一個家族前綴開頭。** 這是「只有尺寸在變」的機械判準；
 *    往階梯裡塞一個別家的 id，那個前提當場毀掉。
 * 3. **至少有一階在 30B 以下（總量）。** #83 定不了案的原因就是底板太高；崩塌點在
 *    20B 底下，而這把 key 上 30B 以下叫得動又支援工具的模型從來只有一兩個。
 * 4. **參數量兩欄都只准抄自 id。** 總量抄 `-NNb`，每 token 活化抄 NVIDIA 的 `-aNb` 後綴，
 *    **後綴沒有就是 `undefined`，不猜**（端點的 `GET /models` 只給 `id` / `object` /
 *    `created` / `owned_by` 四個鍵）。憑記憶補一個數字，報表的 x 軸就沒有任何東西守得住。
 *
 * 重建**不是**「讓 `eval:compare` 變綠」——它需要一個新的待答問題，加上一個湊得出兩道
 * 合法階梯的端點。後者現在錨在 [#85](https://github.com/DemianLi/nexus-agent/issues/85)
 * 的 OpenRouter 決定上，那是 demian 的。
 *
 * ## 盤點：這把 key 上叫得動哪些模型
 *
 * **這一節是 `live-model.ts` 那句下架訊息指過來的地方。** 做法：拿 `GET /models` 的
 * **全部** id，逐一送一個帶 `tools` 的請求（`max_tokens: 16384`、`temperature: 1`、
 * 90 秒逾時、循序、間隔 300ms），把結果分成「叫不動 / 不支援工具 / 逾時 / 可用」四類。
 *
 * | | 2026-08-28 | 2026-08-29 | 2026-09-04 |
 * | --- | --- | --- | --- |
 * | `GET /models` 列出 | 84 | 83 | **81** |
 * | 叫得動（非 `404`） | 29 | 28 | **26** |
 * | 可用（回得出 `tool_calls`） | 14 | 16 | **9** |
 *
 * 四件從這三輪學到、下次照做的事：
 *
 * - **清單是型錄，不是權限。** 叫不動的一律回 `404 "Not found for account"`，
 *   而下架是 `410` —— 端點把這兩件事分成兩個碼（見 `live-model.ts` 的 `modelGoneMessage`）。
 * - **光看 `/models` 或看名字都會踩空**，一定要真的送一個帶 `tools` 的請求。
 * - **一次探測會誤判**，所以每個失敗都要重探三次。2026-09-04 那輪裡兩個首輪失敗的
 *   （`llama-11b` 的 `500`、`lightning-30b` 的逾時）補探 3/3 全過，而四個逾時的重探仍然全逾時。
 * - **`max_tokens` 要送 `LIVE_MAX_OUTPUT_TOKENS`（16384）而不是 512。** `createLiveModel`
 *   恆定送出那個數字，輸出上限比它小的模型每一次呼叫都會失敗，而 512 的入場探測看不出來。
 *
 * **這份集合綁在帳號上，也綁在時間上** —— 同一把 key 三輪就掉了 5 個可用的，所以報告裡的
 * 每個數字都要帶盤點日期。完整結果見
 * [`.docs/model-inventory.md`](../../../../.docs/model-inventory.md)。
 */

import type { ModelUnderTest } from './model-under-test.js';

/**
 * 一個**真的跑過完整基準任務**的模型。
 *
 * 「跑過基準任務」與「探測回得出 `tool_calls`」是兩件事，而它們差得很遠：探測是一句話
 * 一個工具，基準任務是七題各跑多輪、要評四個指標。`survey.ts` 的 `SURVEY_MODELS` 是
 * 前者的清單（候選），這裡是後者（量過的）。**預設模型只准從這裡挑**，見
 * `live-model.test.ts` 的「預設的那個 id 必須是我們真的量過的模型」。
 *
 * **沒有尺寸欄位，而那是設計。** 這份清單跨了四個家族，照參數量排出來的任何一條線都
 * 讀不成尺寸效應 —— 那正是階梯把自己跟這種清單分開的理由，而階梯已經收掉了
 * （見檔頭）。把欄位拿掉，「這不是在比尺寸」就從一句話變成型別上的事實，
 * 規矩與 {@link ModelUnderTest} 檔頭記的 `SurveyModel` 那一條相同。
 */
export interface MeasuredModel extends ModelUnderTest {
  /** 最後一次走完整基準任務量它的日期，`YYYY-MM-DD`。報表要印它，因為端點會變。 */
  readonly measuredOn: string;
  /** 那一次量到什麼。一行，完整數字在 `.docs/model-inventory.md`。 */
  readonly note: string;
}

/**
 * 判準對照 —— **它的分數只回答一件事：這組評分器在真實執行下量不量得出 `1.00` 以下。**
 *
 * 它是這把 key 上總量最小、叫得動、又支援工具的模型（11B），所以它探的是判準的下界。
 * 2026-08-29 那輪選型調查（294 次執行）裡它與同家族的 90B 兩個都跑了七題各三次：
 *
 * | | 參數正確性（七題） | 參數正確性（難題） | 評到分 |
 * | --- | --- | --- | --- |
 * | `llama-11b` | 0.33 | 0.53 | 14/21 |
 * | `llama-90b` | **0.53** | **0.67** | 14/21 |
 *
 * **兩個都離 `1.00` 很遠，而且同家族的兩個尺寸之間也分得出高下。** 判準夠利，就停在這裡 ——
 * 兩階都有三分之一的執行沒評到分，拿半數資料缺席的一對去談尺寸效應是另一回事。
 * 那個 90B 現在六次探測全逾時（見檔頭），所以這一對也重跑不了了。
 */
export const SCORER_CONTROL: MeasuredModel = {
  label: 'llama-11b',
  modelId: 'meta/llama-3.2-11b-vision-instruct',
  measuredOn: '2026-08-29',
  note: '判準對照：難題參數 0.53，14/21 評到分（端點拒收平行呼叫）。',
};

/**
 * 量過的模型，依 model id 的字典序。
 *
 * **順序刻意不帶意義。** 階梯還在的時候順序是尺寸，收掉之後任何其他排法都會被讀成排名，
 * 所以排字典序 —— 規矩與 `SURVEY_MODELS` 相同，而且 `tiers.test.ts` 有一條擋著。
 *
 * 前四個是 2026-09-04 為 [#165](https://github.com/DemianLi/nexus-agent/issues/165) 跑的
 * 決選（四個候選 × 七題 × 3 次取樣 = 84 次執行，零 `throttled`、零 `rejected`）。
 * **那一輪的品質沒有打平** —— 難題上的參數正確性是 `0.98` 對 `0.92`–`0.93` —— 所以
 * `LIVE_MODEL_ID` 是選出來的，不是「回得出 `tool_calls` 就用」。
 */
export const MEASURED_MODELS: readonly MeasuredModel[] = [
  {
    label: 'gemma-4-31b',
    modelId: 'google/gemma-4-31b-it',
    measuredOn: '2026-09-04',
    note: '難題參數 0.93、多叫 0.57、7639 token、17.5 秒，21/21 評到分。',
  },
  SCORER_CONTROL,
  {
    label: 'super',
    modelId: 'nvidia/nemotron-3-super-120b-a12b',
    measuredOn: '2026-09-04',
    note: '難題參數 0.98、多叫 0.29、10661 token、8.0 秒，21/21。現在的 LIVE_MODEL_ID。',
  },
  {
    label: 'lightning-30b',
    modelId: 'nvidia/nemotron-3.5-lightning-30b-a3b',
    measuredOn: '2026-09-04',
    note: '難題參數 0.93、多叫 1.33、13530 token、38.4 秒，21/21。',
  },
  {
    label: 'oss-20b',
    modelId: 'openai/gpt-oss-20b',
    measuredOn: '2026-09-04',
    note: '難題參數 0.92、多叫 0.45、7076 token（最省）、17.1 秒，20/21（1 次 budget）。',
  },
];
