/**
 * 尺寸比較要跑的模型 —— 開發計劃第 5 節 Phase 5，
 * [#31](https://github.com/DemianLi/nexus-agent/issues/31) 三項收斂裡的模型定案那一項。
 *
 * ## 一道階梯不夠，所以現在是兩道加一個對照
 *
 * [#83](https://github.com/DemianLi/nexus-agent/pull/83) 只跑了 Nemotron-3 一家的三階
 * （30B / 120B / 550B），三個指標全部滿分。**分不出高下的原因是那道階梯的底板太高** ——
 * 最小的一階是 30B，而崩塌點在它底下。所以這裡補的是**底下那一段**，而補法不是往
 * `NEMOTRON_3_LADDER` 裡塞一個別家的 id：那樣會當場毀掉「只有尺寸在變」這個前提，
 * 而 [`tiers.test.ts`](./tiers.test.ts) 的家族斷言正是為了擋這件事才寫的。
 *
 * 補法是**再開一道同家族的階梯**：`openai/gpt-oss-20b` 與 `openai/gpt-oss-120b`。
 * 同廠商、同家族、同訓練配方，總量跨過 30B 這條線（20 → 120，約 6 倍一階）。
 * **「只有尺寸在變」在每一道階梯內部成立，跨階梯不成立** —— 兩道階梯之間的差異裡混著
 * 訓練配方，那條線不能讀成尺寸效應。
 *
 * ## 活化那一欄在新的階梯上沒有值，這不是漏填
 *
 * #83 立的規矩是參數量報兩欄（總量／每 token 活化），因為稀疏模型的計算量離總量很遠。
 * 那一欄的來源是 **id 後綴**：`nemotron-3-nano-30b-a3b` 的 `-a3b` 是 NVIDIA 自己標的。
 * **`openai/gpt-oss-20b` 的 id 裡沒有這個後綴，端點也給不出來**（`GET /models` 的紀錄只有
 * `id` / `object` / `created` / `owned_by` 四個鍵）。網路上查得到的數字不是這裡的資料來源 ——
 * 抄進來就變成一個沒有任何測試守得住的 x 軸。所以 {@link ModelTier.activeBillions} 是**選填**，
 * 而規則綁死在 id 上：**後綴有就必須填且相符，後綴沒有就必須是 `undefined`**。
 *
 * 直接後果，讀報表時要記著：**新的那道階梯只在總量那一欄排得出順序。** 而且在活化那一欄，
 * `nemotron-3-nano` 的 3B 仍然是我們量過最小的活化量 —— 新加的兩階誰也沒排到它底下，
 * 因為它們根本沒有座標。#83 那句「底板是 30B」因此是**總量那一欄的話**。
 *
 * ## 判準對照不是階梯的一部分
 *
 * {@link SCORER_CONTROL} 回答的是另一個問題：**這組評分器在真實執行下量不量得出 1.00
 * 以下的數字。** #83 的證據是盤點時用 curl 拿到的旁證（同一句提示，11B 把參數寫成亂碼），
 * 那不是走 `runBenchmarkCase` 與 `scoreCase` 量出來的。它**沒有同家族對照**
 * （`meta/llama-3.2-90b-vision-instruct` 在 2026-08-28 的三次探測全部 90 秒逾時，就是
 * [#57](https://github.com/DemianLi/nexus-agent/issues/57) 那個永遠不回來），所以**它的數字
 * 不准讀成尺寸效應** —— 它只證明判準鈍不鈍。
 *
 * **2026-08-29 的盤點裡那個 90B 回得出 `tool_calls`，11.1 秒。** 一次成功不會讓 #57 退休
 * （那個失敗模式本來就是斷續的），但「沒有同家族對照」這個理由現在**至少有一次是不成立的**。
 * 要把它變成真的對照，得先量到它在完整基準任務下也跑得完 —— 探測是一句話一個工具，
 * 那證明不了什麼。見 `survey.ts`。
 *
 * ## 盤點（2026-08-28，逐一送一個帶 `tools` 的請求，配 90 秒逾時）
 *
 * `GET /models` 列 **84** 個，這把 key 只叫得動 **29** 個（其餘一律
 * `404 "Not found for account"` —— **清單是型錄，不是權限**），其中真的回得出
 * `finish_reason: tool_calls` 的只有 **14** 個。**30B 以下叫得動又支援工具的，只有兩個**：
 * `openai/gpt-oss-20b` 與 `meta/llama-3.2-11b-vision-instruct`。所有其他候選 ——
 * `google/gemma-3-12b-it`、`google/gemma-3-4b-it`、`nv-mistralai/mistral-nemo-12b-instruct`、
 * `mistralai/codestral-22b-instruct-v0.1`、`nvidia/mistral-nemo-minitron-8b-8k-instruct`、
 * `microsoft/phi-3.5-moe-instruct`、`bigcode/starcoder2-15b`、`nvidia/cosmos-reason2-8b`、
 * `ibm/granite-3.0-8b-instruct`、`zyphra/zamba2-7b-instruct`、`mistralai/mistral-7b-instruct-v0.3`
 * —— 全部 404。**光看 `/models` 或看名字都會踩空。**
 *
 * ## 這份清單是綁在帳號上的，而且**同一把 key 上也會變**
 *
 * 換一把 key，叫得動的集合就不一樣，這兩道階梯可能整個不存在。要重新盤點就照上面那套做：
 * 拿 `GET /models` 的**全部** id，逐一送一個帶 `tools` 的請求，把結果分成
 * 「叫不動 / 不支援工具 / 逾時 / 可用」四類。
 *
 * **2026-08-29 用同一把 key 重跑一次，數字就變了**：型錄 84 → **83**，可用 14 → **16**，
 * 而且成員換過（`google/gemma-4-31b-it`、`meta/muse-glimmer-30b`、`minimaxai/minimax-m3`、
 * `moonshotai/kimi-k3` 等是新出現的；`google/gemma-3-12b-it` 之類則從型錄上消失）。
 * 完整結果見 [`.docs/model-inventory.md`](../../../../.docs/model-inventory.md)。
 * 所以「綁在帳號上」還不夠準 —— **它也綁在時間上**，報告裡的每個數字都要帶盤點日期。
 */

import type { ModelUnderTest } from './model-under-test.js';

/**
 * 一道階梯上的一階。
 *
 * 比 {@link ModelUnderTest} 多的就是尺寸那兩欄 —— 而那兩欄**只在階梯內部有意義**。
 * 選型調查（`survey.ts`）用的是沒有它們的那個上位型別。
 */
export interface ModelTier extends ModelUnderTest {
  /** 總參數量（十億）。抄自 id。 */
  readonly totalBillions: number;
  /**
   * 每 token 活化的參數量（十億）。**id 沒編碼就是 `undefined`，不猜。**
   *
   * 唯一的資料來源是 id 的 `-aNb` 後綴（NVIDIA 的命名慣例）。沒有後綴的模型，
   * 端點這側拿不到規格，填一個記來的數字會變成沒人守得住的 x 軸 —— 這與
   * `BenchmarkRun.usage` 區分「沒回報」與零是同一條規矩。
   */
  readonly activeBillions?: number;
}

/**
 * 一道階梯 —— 同一個家族的數個尺寸。
 *
 * **「只有尺寸在變」是階梯內部的性質。** 跨階梯比較的差異裡混著訓練配方，
 * 所以報表按階梯分段印，不併成一張表。
 */
export interface ModelLadder {
  /** 階梯的短名，報表分段用。 */
  readonly name: string;
  /** 這一家的 id 前綴。同一道階梯上每個 id 都要以它開頭 —— 那是「同家族」的機械判準。 */
  readonly idPrefix: string;
  /** 這道階梯回答什麼。印在報表分段的標題下。 */
  readonly note: string;
  /** 由小到大。順序有意義：報表照這個順序印，「隨尺寸衰減」才讀得出來。 */
  readonly tiers: readonly ModelTier[];
}

/**
 * Nemotron-3：#83 跑過的那道，三階全部滿分。
 *
 * 三階都是稀疏的，兩欄都單調（總量 30 → 120 → 550、活化 3 → 12 → 55，各約 4 倍一階），
 * 所以它在兩種讀法下都是階梯 —— 這是挑同一家族而不是湊三個廠商的理由。
 */
export const NEMOTRON_3_LADDER: ModelLadder = {
  name: 'nemotron-3',
  idPrefix: 'nvidia/nemotron-3-',
  note: '底板 30B。#83 三階全部滿分，崩塌點在這道階梯底下。',
  tiers: [
    {
      label: 'nano',
      modelId: 'nvidia/nemotron-3-nano-30b-a3b',
      totalBillions: 30,
      activeBillions: 3,
    },
    {
      label: 'super',
      modelId: 'nvidia/nemotron-3-super-120b-a12b',
      totalBillions: 120,
      activeBillions: 12,
    },
    {
      label: 'ultra',
      modelId: 'nvidia/nemotron-3-ultra-550b-a55b',
      totalBillions: 550,
      activeBillions: 55,
    },
  ],
};

/**
 * gpt-oss：這次補的那道，總量跨過 30B。
 *
 * **20B 那一階是重點，120B 那一階是它的對照。** 只跑 20B 的話，量到的任何衰減都分不出是
 * 尺寸還是這一家的訓練配方；120B 走同一個配方而且落在「已知不會崩」的尺寸區間
 * （Nemotron 的 120B 那階滿分），所以這一對把 30B 這條線夾在中間。
 *
 * 兩階的 id 都沒有 `-aNb` 後綴，所以活化那一欄是空的 —— 見檔頭。
 */
export const GPT_OSS_LADDER: ModelLadder = {
  name: 'gpt-oss',
  idPrefix: 'openai/gpt-oss-',
  note: '總量 20 → 120，把 30B 這條線夾在中間。活化那一欄 id 沒編碼，所以是空的。',
  tiers: [
    { label: 'oss-20b', modelId: 'openai/gpt-oss-20b', totalBillions: 20 },
    { label: 'oss-120b', modelId: 'openai/gpt-oss-120b', totalBillions: 120 },
  ],
};

/** 兩道階梯，由底板低的排到高的。 */
export const MODEL_LADDERS: readonly ModelLadder[] = [GPT_OSS_LADDER, NEMOTRON_3_LADDER];

/**
 * 判準對照 —— **不是階梯上的一階。**
 *
 * 它回答「這組評分器在真實執行下量不量得出 1.00 以下的數字」，不回答尺寸。兩次探測就
 * 自相矛盾（同一句提示，一次叫對了工具、一次 `finish_reason: stop` 根本沒叫），而它的
 * 同家族對照 `meta/llama-3.2-90b-vision-instruct` 在 2026-08-28 的三次探測全部 90 秒逾時，
 * 所以**沒有任何東西能把它的分數歸因到尺寸**。它是這把 key 上總量最小、叫得動、又支援工具的模型。
 *
 * **這個理由在 2026-08-29 鬆動了**：同一個 90B 在那天的盤點裡 11.1 秒回得出 `tool_calls`。
 * 這裡刻意不動 —— 探測跑得動不代表基準任務跑得完，而在量到之前把它升級成對照，等於拿
 * 一次一句話的請求去支撐一整條尺寸推論。要不要接上去，等 `survey.ts` 那一輪的數字。
 */
export const SCORER_CONTROL: ModelTier = {
  label: 'llama-11b',
  modelId: 'meta/llama-3.2-11b-vision-instruct',
  totalBillions: 11,
};

/** 這一輪會真的送出請求的所有模型，階梯順序在前、對照在後。 */
export const ALL_MODELS_UNDER_TEST: readonly ModelTier[] = [
  ...MODEL_LADDERS.flatMap((ladder) => ladder.tiers),
  SCORER_CONTROL,
];
