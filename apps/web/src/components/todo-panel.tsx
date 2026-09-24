import type { ConversationStatus, WireTodoItem } from '@nexus/wire';
import { ChevronDown, ListTodo } from 'lucide-react';
import { useState } from 'react';

import { TodoList } from '@/components/todo-list';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { todoPanelLabel, todoSummary } from '@/lib/todo-view';

/**
 * 輸入框上方的待辦清單（[#575](https://github.com/DemianLi/nexus-agent/issues/575) 的 Q1、Q2、Q6）：root 這一輪的
 * 模型現在的清單。資料是 harness 的投影 `ConversationState.todos`（照 dsh 的 `todos` 投影：每次寫入整份換掉、
 * 開新的一輪回到 `null`、一輪結束保留），所以重新整理後拿到同一份。
 *
 * - **放在換手區外面、上面**：不管底下是輸入框還是核准／提問面板都在。停下來等你核准時，正是最需要知道它做到哪一步
 *   的時候。放在 `PendingSwap` 的 zone 外，它搬焦點的判斷不會把這裡算進去。
 * - **`null` 或空陣列就不畫**（Q5）。模型寫一份空清單時是 `[]`。
 * - **預設收合，一行**：「2/5 完成 · 進行中的第一項」，其餘同時進行的另起一格「+N」（同工具卡，照 dsh `planSummary`）。
 * - **展開或收合跟著人**：狀態放在這一層，而這一層一直掛著——每開一輪清單都會先回到 `null`，條件式掛載的話人選的
 *   展開每一輪都被丟掉。
 * - **進行中那一項只在這一輪執行中閃**（Q2 的修正）：一輪結束或停在核准點時清單留著，沒收尾的那一項閃著等於說
 *   模型還在做。
 * - **報讀**（Q6）：觸發按鈕的名稱是「待辦清單：」接收著那一行（`todoPanelLabel`）。不掛 `role="status"`，更新時
 *   不唸：全站的 live region 只有狀態列一個，模型每改一次清單就唸一次太吵。
 * - **展開有高度上限**：底部這一區不縮，二十項的清單會把對話擠掉，所以清單自己捲。
 */
export function TodoPanel({
  todos,
  status,
}: {
  readonly todos: readonly WireTodoItem[] | null;
  readonly status: ConversationStatus;
}) {
  const [open, setOpen] = useState(false);
  if (todos === null || todos.length === 0) return null;
  const summary = todoSummary(todos);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      data-testid="todo-panel"
      className="bg-card mb-2 rounded-3xl border p-1"
    >
      <CollapsibleTrigger
        aria-label={todoPanelLabel(summary)}
        className="group text-muted-foreground hover:bg-chip-hover active:bg-chip-pressed flex min-h-11 w-full min-w-0 items-center gap-2 rounded-[20px] px-3 text-left text-xs transition-colors duration-(--duration-quick) lg:min-h-9"
      >
        <ListTodo aria-hidden className="size-4 shrink-0" />
        <span className="flex min-w-0 flex-1 gap-1.5">
          <span className="min-w-0 truncate">{summary.text}</span>
          {summary.extra > 0 && (
            <span className="shrink-0" data-testid="todo-extra">
              +{summary.extra}
            </span>
          )}
        </span>
        <ChevronDown
          aria-hidden
          className="size-4 shrink-0 transition-transform duration-(--duration-fast) ease-(--ease-smooth-out) group-data-[state=open]:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden">
        <div className="m-1 mt-0 max-h-60 overflow-y-auto" data-testid="todo-panel-scroll">
          <TodoList todos={todos} live={status === 'running'} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
