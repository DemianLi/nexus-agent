/**
 * 尺寸比較的三個橫階 —— 開發計劃第 5 節 Phase 5，[#31](https://github.com/DemianLi/nexus-agent/issues/31)
 * 三項收斂裡的模型定案那一項。
 *
 * ## 級距換掉了，而且是被資料換掉的
 *
 * 計劃原本寫的是「9B 以下 / 26–35B / 100B 以上」三個桶子，前提是「端點上三個桶子都有
 * 候選」。**2026-08-28 逐一實測，那個前提不成立。**
 *
 * - `GET /models` 列 **84** 個，但**這把 key 只叫得動 29 個** —— 其餘 55 個一律
 *   `404 "Not found for account"`。清單是型錄，不是權限。
 * - 29 個裡真的回得出 `finish_reason: tool_calls` 的只有 **14** 個；其餘不是
 *   `400 "Tool use has not been enabled"`（safety / translate 那幾支），就是逾時。
 * - **9B 以下那一格是空的。** 叫得動又支援工具的模型，最小的是 `openai/gpt-oss-20b`
 *   （20B 總量）。所有 8B 以下的候選（`mistral-7b-instruct-v0.3`、`granite-3.0-8b-instruct`、
 *   `gemma-3-4b-it`、`zamba2-7b-instruct` 等）全部 404。
 *
 * → 所以桶子改成**同一個家族的三個橫階**。這比原本的三個桶子更嚴，不是更鬆：原本的寫法
 * 允許三格各來自不同廠商、不同訓練配方、不同微調目標，量到的差異裡有多少是尺寸造成的
 * 沒人分得開。
 *
 * ## 為什麼是 Nemotron-3 這一家
 *
 * 它是這把 key 上**唯一**在三個尺寸都有、而且都支援工具呼叫的家族。同廠商、同家族、
 * 同端點、同一份 `@langchain/openai`、同一把 key —— 除了尺寸，其他全部按住。
 *
 * ## 稀疏模型：兩欄，不是一欄
 *
 * 三個都是 MoE，id 裡的 `-aNb` 是 NVIDIA 自己標的 **active 參數量**（`30b-a3b` = 總量
 * 30B、每 token 實際活化 3B）。**這件事必須兩欄分開報**：一個 120B-a12b 的計算量離
 * 253B 的密集模型很遠，反而更接近 12B。混成一欄的話，「工具呼叫在多小的模型上開始崩」
 * 量到的崩塌點會是「哪一格剛好抽到稀疏模型」的產物。
 *
 * 兩欄都是單調的（總量 30 → 120 → 550，活化 3 → 12 → 55，各約 4 倍一階），所以這道階梯
 * 在兩種讀法下都成立 —— 這正是挑這一家而不是湊三個廠商的理由。
 *
 * **`a` = active 是 NVIDIA 的命名慣例，不是查證過的規格**：`GET /models` 的紀錄只有
 * `id` / `object` / `created` / `owned_by` 四個鍵，端點這側拿不到參數量。
 *
 * ## 這道階梯回答的是什麼，不回答什麼
 *
 * 它回答**「在同一套訓練配方裡，工具呼叫隨尺寸怎麼衰減」**。它**不**回答「換一家供應商
 * 我們這套 stack 跑不跑得通」—— 那是 Phase 2 那道二元閘門，仍然沒跑過（見開發計劃第 5 節）。
 *
 * ## 這份清單是綁在帳號上的
 *
 * 換一把 key，叫得動的集合就不一樣，這道階梯可能整個不存在。要重新盤點就照上面那套做：
 * 拿 `GET /models` 的**全部** id，逐一送一個帶 `tools` 的請求（配逾時），把結果分成
 * 「叫不動 / 不支援工具 / 逾時 / 可用」四類 —— 光看 `/models` 或看名字都會踩空。
 */

/** 一個橫階。 */
export interface ModelTier {
  /** 報表上的短名。 */
  readonly label: string;
  /** 端點上的 model id。 */
  readonly modelId: string;
  /** 總參數量（十億）。 */
  readonly totalBillions: number;
  /**
   * 每 token 活化的參數量（十億）。
   *
   * 稀疏模型才有意義，而三個橫階都是稀疏的 —— 所以它跟 {@link totalBillions} 一樣承重，
   * 不是附註。
   */
  readonly activeBillions: number;
}

/**
 * 三個橫階，由小到大。
 *
 * 順序有意義：報表按這個順序印，「隨尺寸衰減」這句話才讀得出來。
 */
export const MODEL_TIERS: readonly ModelTier[] = [
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
];
