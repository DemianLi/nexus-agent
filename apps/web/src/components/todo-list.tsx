import { Check, Circle, CircleDot } from 'lucide-react';

import { TODO_STATUS_LABEL } from '@/lib/todo-view';
import type { TodoItem } from '@/lib/todo-view';

/**
 * 一份待辦清單逐項列出來（[#575](https://github.com/DemianLi/nexus-agent/issues/575)），工具卡與輸入框上方的面板共用。
 *
 * - 照模型給的順序；完成的打勾、文字變淡，進行中是實心圈，待處理是空心圈。圖示不唸，狀態靠每項前面那幾個字。
 * - **`live` 才讓進行中那一項閃**（`text-shimmer`，減少動態時停住）。工具卡是那一次寫入的快照，歷史裡的「進行中」
 *   不代表現在還在跑，所以不給；面板只在這一輪執行中才給——一輪結束後清單會留著，沒收尾的那一項閃著就是在說謊。
 */
export function TodoList({
  todos,
  live = false,
}: {
  readonly todos: readonly TodoItem[];
  readonly live?: boolean;
}) {
  if (todos.length === 0) {
    return <p className="text-muted-foreground px-3 py-2 text-xs">清單是空的。</p>;
  }
  return (
    <ul className="bg-stage shadow-stage flex flex-col gap-2 rounded-xl p-3 text-sm">
      {todos.map((todo, index) => (
        <li
          key={`${index}:${todo.content}`}
          className="flex min-w-0 items-start gap-2"
          data-testid="todo-item"
          data-status={todo.status}
        >
          <TodoStatusIcon status={todo.status} />
          <span
            className={`min-w-0 break-words ${todo.status === 'completed' ? 'text-muted-foreground' : ''} ${live && todo.status === 'in_progress' ? 'text-shimmer' : ''}`}
          >
            <span className="sr-only">{TODO_STATUS_LABEL[todo.status]}：</span>
            {todo.content}
          </span>
        </li>
      ))}
    </ul>
  );
}

function TodoStatusIcon({ status }: { status: TodoItem['status'] }) {
  if (status === 'completed')
    return <Check aria-hidden className="text-muted-foreground mt-0.5 size-4 shrink-0" />;
  if (status === 'in_progress')
    return <CircleDot aria-hidden className="text-brand mt-0.5 size-4 shrink-0" />;
  return <Circle aria-hidden className="text-muted-foreground mt-0.5 size-4 shrink-0" />;
}
