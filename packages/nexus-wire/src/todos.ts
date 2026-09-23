/**
 * 模型的待辦清單上線的形狀（[#575](https://github.com/DemianLi/nexus-agent/issues/575)）。
 *
 * 照 dsh 的 `todos` 投影（`packages/todo/tool-todo/src/index.ts:134-142`，`46a7f68`）：**只算 root**、可以從日誌重播，
 * 值是整份清單或 `null`：
 *
 * - `todo/write`：換成最新那份。
 * - 一輪開始（`turn/start`）：回到 `null`。人開的輪與 goal 續行的輪都算。
 * - 一輪結束、失敗、被停止：不動，所以讀回覆時還看得到剛才的清單。
 *
 * 載體是協定的 `custom` 事件，`data.name` 是 {@link TODOS}，`payload` 是 {@link TodosPayload}——**投影的整個值**，
 * 後到的取代先到的。即時由 pump 在 root 日誌寫進 `todo/write` 或開新的一輪時送；歷史路由每一頁送一顆「到這一頁
 * 結尾為止」的值（是 `null` 就不送，折疊器的初值就是 `null`）。
 *
 * ## 「一輪開始」不含 `resume`
 *
 * 我們停在核准點之後，人按批准會寫一顆 `turn/start {kind:'resume'}`，那是**同一輪接著跑**（歷史路由也這樣認，
 * 見 `conversation-history.ts`）。dsh 的核准在一輪裡面等，不另起一輪，所以它的「`turn/start` 就清空」對應到我們的
 * 是「不是 `resume` 的 `turn/start`」。照字面也清掉 `resume` 的話，人按下批准那一刻清單就不見了——而 #575 的 Q1
 * 正是要在那個時候看得到它。
 *
 * @module
 */

/** `custom` 事件的 `data.name`：root 的待辦清單現在是這一份（或沒有）。 */
export const TODOS = 'todos';

/** 清單裡的一項。照 dsh 的 `TodoItem`。 */
export interface WireTodoItem {
  readonly content: string;
  readonly status: 'pending' | 'in_progress' | 'completed';
}

/** {@link TODOS} 的 `payload`：投影的整個值。 */
export interface TodosPayload {
  /** 整份清單；一輪剛開始、還沒寫過就是 `null`。 */
  readonly todos: readonly WireTodoItem[] | null;
}
