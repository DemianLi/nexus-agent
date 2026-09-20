/**
 * 模型宣告交付的檔案——耐久事件 `deliverables/presented` 的詞彙。
 *
 * 形狀照 dsh 的 `@deepseek-ai/dsh-tool-present`
 * （`references/deepseek-harness/packages/deliverables/tool-present/src/types.ts`，`ddefc45`）。
 *
 * **為什麼詞彙在這裡而工具在 plugin：同 {@link ./todo.ts | todo.ts} 那一條。**
 * {@link ./session-log.ts | SessionEventMap} 是封閉的映射，酬載型別要寫得出來就得住在這裡；
 * 工具、檢查與不變量住在 `@nexus/plugin-present`。
 *
 * @see [#441](https://github.com/DemianLi/nexus-agent/issues/441)
 * @module
 */

/**
 * 一個宣告交付的檔案。**只記路徑與說明，不複製內容**：使用者打開的是那個路徑上現在的檔，
 * 之後被改、被刪，宣告不會跟著變（dsh 同）。
 */
export interface PresentedFile {
  /** 模型給的原樣。相對路徑以工作區根為準，不在這裡正規化。 */
  readonly path: string;
  /** 模型給使用者的一句說明。沒給就整個不放 key。 */
  readonly description?: string;
}
