/**
 * 一個會話的**待辦清單**——耐久事件 `todo/write` 的詞彙。
 *
 * 形狀照 dsh 的 `@deepseek-ai/dsh-tool-todo`
 * （`references/deepseek-harness/packages/todo/tool-todo/src/types.ts`，對讀日期
 * 2026-09-01，版本 `0a53fb55bea101816fa226bb964ae2bed71c343b`）。
 *
 * **為什麼詞彙在這裡而工具在 plugin：同 {@link ./goal.ts | goal.ts} 那一條。**
 * `todo/write` 這個事件種類由 `@nexus/plugin-todo` 用宣告合併補進 {@link ./session-log.ts | SessionEventMap}
 * （照 dsh 的 `declare module '@deepseek-ai/dsh-session/types'`，[#679](https://github.com/DemianLi/nexus-agent/issues/679)
 * 第 4 步），工具、驗證與不變量也住在那裡；酬載裡的 {@link TodoItem} 留在這裡，因為 web 的測試讀這個檔的原文。
 *
 * @see [#132](https://github.com/DemianLi/nexus-agent/issues/132)
 * @module
 */

/**
 * 一條待辦的生命週期狀態，**執行期的那一份**。
 *
 * 抽成常數是因為驗證要走訪它（`@nexus/plugin-todo` 的不變量與工具各一次），而型別
 * 走訪不了。兩邊都由這一份推出來，所以加一種狀態只有一個地方要改。
 */
export const TODO_STATUSES = ['pending', 'in_progress', 'completed'] as const;

/** 一條待辦的生命週期狀態。 */
export type TodoStatus = (typeof TODO_STATUSES)[number];

/**
 * 待辦清單裡的一條。
 *
 * **刻意最小：一句 `content` 加三態 `status`，沒有 id、沒有優先級。** 照 dsh 的原話：
 * 每一次寫入都整表替換（last-write-wins），所以條目不需要穩定身分。
 *
 * 這一刀跟 {@link ./goal.ts | goal} 的取捨剛好相反——goal 有 `GoalId` 與 CAS 修訂號，
 * 因為它是**人**交代的、一次改一格；todo 是模型自己的規劃草稿，一次重寫整份。**兩種
 * 狀態軌道，兩種併發模型**，混用任何一邊的機制都會付另一邊的代價。
 */
export interface TodoItem {
  /** 這條任務是什麼——一句短的祈使句。**非空、且已經去過頭尾空白**。 */
  readonly content: string;
  /** 生命週期狀態。`in_progress` 標的是現在正在做的那些。 */
  readonly status: TodoStatus;
}
