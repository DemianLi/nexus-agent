/**
 * 計劃模式現在開著還是關著上線的形狀（[#895](https://github.com/DemianLi/nexus-agent/issues/895)）。
 *
 * 照 dsh 的 `plan` 投影（`packages/plan/plan-mode/src/index.ts:137-169`，`c1b47e41fcd`）：root 日誌上最後一顆
 * `plan/mode` 的 `active`；整份值不是切換，後到的取代先到的。
 *
 * 載體是協定的 `custom` 事件，`data.name` 是 {@link PLAN_MODE}，`payload` 是 {@link PlanModePayload}：
 *
 * - **即時**：root 日誌每記下一顆 `plan/mode` 就送一顆。寫者兩個：`/plan`（人）與 `exit_plan_mode`（模型，計劃獲准之後）。
 *   後者不是當場寫，要等到下一個 `agent/pre-step`——所以人按下批准到下一次模型呼叫之間，投影仍然是開著。日誌是真相，
 *   這一小段不補（dsh 同形）。
 * - **歷史**：只在最新一頁送一顆**目前的**值，同標題與送出佇列；較舊的頁不帶，免得往上捲時把新的蓋回舊的。計劃模式
 *   跨輪、跨頁，不像待辦清單在一輪開頭清空，所以不能「一頁一顆，是這一頁結尾時的」。
 *
 * ## `null` 的意思
 *
 * 折疊器的 `planMode` 初值是 `null`，意思是**日誌上還沒有過 `plan/mode`**，等同關著——不是「還沒收到」。dsh 的
 * `{ active: false }` 在這裡就是 `null`，因為輸入框的指示只在開著時才畫，分不分「從沒開過」與「開過又關了」都畫不出
 * 兩樣。這個組裝有沒有計劃模式不從這裡看，看 `slash.list` 有沒有 `plan`。
 *
 * ## 少了 `pending`
 *
 * dsh 的值是 `{ active, pending }`，`pending` 是「一次 `/plan` 的選擇已經記進日誌（`command/run`）、還沒落實成
 * `plan/mode`」的那一段。我們的 `/plan` handler 當場就寫 `plan/mode`，日誌上不存在可以停留的那一段，這一欄永遠
 * 是 `false`，所以不送。這是「dsh 的欄位在我們的載體上沒有值可填」，不是基礎建設表達不出來。
 *
 * ## 已知的缺口：`startActive`
 *
 * 計劃模式 plugin 的 `startActive` 是「日誌上一顆 `plan/mode` 都沒有時」的初值，出廠是關的，今天只剩測試用。開著它
 * 又沒人寫日誌的組裝，模型在計劃模式裡而這個值是 `null`。照 dsh（它的初值就是 inactive）不處理。
 *
 * **對 dsh 的偏離**：dsh 的投影值走 follow 快照與 host-wide 的 `session.control` 投影 frame。我們沒有那條通道，每條
 * thread 各自一條下行，所以跟 `todos`、`title` 一樣由 pump 合成 `custom` 事件。
 *
 * @module
 */

/** `custom` 事件的 `data.name`：這條會話的計劃模式現在是這樣。 */
export const PLAN_MODE = 'plan';

/** {@link PLAN_MODE} 的 `payload`：投影的整個值。 */
export interface PlanModePayload {
  /** 計劃模式現在開著嗎。 */
  readonly active: boolean;
}
