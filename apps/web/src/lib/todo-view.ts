/**
 * `todo_write` 那張工具卡要知道的事（[#575](https://github.com/DemianLi/nexus-agent/issues/575) 的 transcript 那一半）：
 * 模型這一次把待辦清單寫成什麼樣子。
 *
 * **只讀呼叫參數**，照 dsh 的 `TodoRow`（`packages/client/ui-tool/src/client/tool/toolviews/todo-row.tsx`，`46a7f68`）：
 * 參數是整份清單，`{ todos: [{ content, status }] }`，所以一顆呼叫的參數就是那一刻的快照。**不做跟前一次的差異**
 * （dsh 有；#575 grilling Q3 決定先不做）。「現在的清單」是另一件事，那是輸入框上方的面板，資料走 harness 的投影。
 *
 * @module
 */

/** 模型看到的工具名（`@nexus/plugin-todo` 的 `TODO_TOOL_NAME`，照 dsh `tool-todo`）。 */
export const TODO_WRITE = 'todo_write';

/** 一項的狀態，同 `@nexus/core` 的 `TODO_STATUSES`。 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

const STATUSES: readonly string[] = ['pending', 'in_progress', 'completed'] satisfies TodoStatus[];

/** 清單裡的一項，照模型給的原樣。 */
export interface TodoItem {
  readonly content: string;
  readonly status: TodoStatus;
}

/**
 * 呼叫參數裡的清單。解不開、或**有任何一項**形狀不對就是 `undefined`，卡片退回參數原文：串流中途的參數是半截
 * JSON；被工具本體拒絕的那顆參數原樣留著，可能有空白的 `content`。只挑好的那幾項畫的話，「2/5 完成」的分母就
 * 是錯的，所以寧可整份不畫（#575 grilling Q6「不畫半套」）。
 */
export function todosOf(input: string): TodoItem[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return undefined;
  }
  const todos = (parsed as { todos?: unknown } | null)?.todos;
  if (!Array.isArray(todos)) return undefined;
  const items: TodoItem[] = [];
  for (const raw of todos as unknown[]) {
    const item = raw as { content?: unknown; status?: unknown } | null;
    if (typeof item?.content !== 'string' || item.content.trim() === '') return undefined;
    if (typeof item.status !== 'string' || !STATUSES.includes(item.status)) return undefined;
    items.push({ content: item.content, status: item.status as TodoStatus });
  }
  return items;
}

/**
 * 收著時那一行的兩半，照 dsh `planSummary`（`toolviews/plan-summary.ts:46-59`）**刻意不先接起來**：摘要會被截斷，
 * 而接在尾巴的「+N」正是窄的時候最先被截掉的那一格——偏偏那時它最有資訊。`extra` 由卡片放在不會縮的那一格。
 */
export interface TodoSummary {
  /** 「2/5 完成」，清單空的時候是「清單是空的」。後面接第一個進行中那一項，沒有就只有計數。 */
  readonly text: string;
  /** 第一個之外還有幾項也在進行中；0 就不畫。 */
  readonly extra: number;
}

/** 從一份快照算出收著那一行。 */
export function todoSummary(todos: readonly TodoItem[]): TodoSummary {
  if (todos.length === 0) return { text: '清單是空的', extra: 0 };
  const done = todos.filter((todo) => todo.status === 'completed').length;
  const active = todos.filter((todo) => todo.status === 'in_progress');
  const counts = `${done}/${todos.length} 完成`;
  const first = active[0];
  return first === undefined
    ? { text: counts, extra: 0 }
    : { text: `${counts} · ${first.content}`, extra: active.length - 1 };
}

/** 每一種狀態的字：清單裡的圖示 `aria-hidden`，報讀靠這幾個字。 */
export const TODO_STATUS_LABEL = {
  pending: '待處理',
  in_progress: '進行中',
  completed: '已完成',
} as const satisfies Record<TodoStatus, string>;
