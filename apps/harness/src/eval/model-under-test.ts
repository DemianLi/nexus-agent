/**
 * 「這一輪要送請求的一個模型」—— 三個概念的共同上位。
 *
 * 這個介面存在的理由是**它刻意什麼都不知道**。`compare.ts` 那一層跑一次執行只需要
 * 一個 id 跟一個報表上的名字，它從來沒讀過參數量；把簽名收到這裡，尺寸就成了
 * **呼叫端的概念**而不是 runner 的概念。
 *
 * 目前有三個東西滿足它，而它們回答的是不同的問題：
 *
 * | 型別 | 在哪 | 回答什麼 |
 * | --- | --- | --- |
 * | `MeasuredModel` | `tiers.ts` | 這個模型走完整基準任務量到什麼（預設模型只准從這裡挑） |
 * | `SCORER_CONTROL` | `tiers.ts` | 判準量不量得出 `1.00` 以下 |
 * | `SurveyModel` | `survey.ts` | 選型：這把 key 上叫得動的模型，同題表現如何 |
 *
 * **三個都沒有尺寸欄位，而那是設計不是偷懶。** `SurveyModel` 從一開始就沒有
 * （[#85](https://github.com/DemianLi/nexus-agent/issues/85) 第 3 條：候選來自不同廠商、
 * 不同訓練配方，那條線讀不成尺寸效應）。`MeasuredModel` 是 2026-09-05 跟著尺寸階梯一起
 * 收掉的（[#167](https://github.com/DemianLi/nexus-agent/issues/167)）—— 階梯是唯一一個
 * 「只有尺寸在變」成立的地方，階梯沒了，尺寸欄位就只剩下被誤讀的用途。
 * 把欄位拿掉，「這不是在比尺寸」就從報告裡的一句話變成型別上的事實 —— 想照尺寸排序的人編不過。
 */
export interface ModelUnderTest {
  /** 報表上的短名。全域唯一，報表靠它指名。 */
  readonly label: string;
  /** 端點上的 model id。 */
  readonly modelId: string;
}
