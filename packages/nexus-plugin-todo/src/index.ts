/**
 * `@nexus/plugin-todo`——模型自己的**待辦清單**：一顆整表替換的工具，寫進呼叫它的那一份
 * 會話日誌。
 *
 * 形狀照 dsh 的 `packages/todo/tool-todo/`（對讀日期 2026-09-01，版本
 * `0a53fb55bea101816fa226bb964ae2bed71c343b`）。那一組**只有一個子套件、只有工具沒有
 * 命令**，而我們照抄了那個形狀——理由不是省事：
 *
 * | 誰寫 | 走哪條 |
 * | --- | --- |
 * | 人交代長期目標 | `/goal`（`@nexus/plugin-goal`） |
 * | 人要求先想再做 | `/plan`（`@nexus/plugin-plan-mode`） |
 * | **模型自己的規劃草稿** | **這顆工具** |
 *
 * 三條狀態軌道，**寫入者不同**。給 todo 加一個 `/todo` 命令等於讓人去改模型的草稿，
 * 而那份草稿下一次呼叫就被整份覆蓋掉了。調研與三個決定見
 * [`.docs/todo-design-survey.md`](../../../.docs/todo-design-survey.md)。
 *
 * ## 為什麼是會話事件，不是 middleware 的 `stateSchema`
 *
 * langchain 1.x 的主進入點匯得出 `todoListMiddleware`，掛上去一行就有一顆 `write_todos`
 * ——狀態活在 graph state。**那條路我們不走，而且它按 AGENTS.md 標註不了偏離**：偏離條款
 * 要求「現有基礎建設表達不出來」，但事件路我們表達得出來（`@nexus/plugin-goal` 就走這條）。
 *
 * 真正的判準是**誰看得見**。走 graph state 的狀態不進日誌，所以不變量配套入口看不到、
 * 遙測協調器也鏡像不到——`@nexus/plugin-plan-mode` 的 `invariant.ts` 第一節就叫「檢不到
 * 的那一條」。而 dsh 對 todo 唯一真的在檢的規則（`todo/write` 只能在開著的輪裡 append）
 * 只有走事件路才檢得到。見 [`./invariant.ts`](./invariant.ts)。
 *
 * ## 單一所有者：subagent 各自一份，**所以它不是 `rootOnly`**
 *
 * dsh 的 README 明說：「列表属于创建它的那一个 agent 会话——subagent 与其他 agent 各自
 * 维护自己的列表」。這正是 [#137](https://github.com/DemianLi/nexus-agent/issues/137) 補上
 * 的那條水管，而它與 [#136](https://github.com/DemianLi/nexus-agent/pull/136) 的 `rootOnly`
 * 是**兩條相反的政策**：goal 是人交代的所以拒絕 subagent，todo 是模型自己的草稿所以每一次
 * spawn 各一份。
 *
 * 工具靠 `registry.sessions.forCall(config)` 拿自己這次該寫的那一份——**關鍵是它宣告了
 * handler 的第二個參數**，身分只在 `ToolRunnableConfig` 裡。
 *
 * ## 與 dsh 的偏離，三條
 *
 * 1. **沒有 `todos` 投影。** dsh 註冊一個 `ctx.sessionProjections` 單元（`turn/start` 清空、
 *    `todo/write` 換成最新、`turn/end` 保留），UI 從那裡讀。**我們沒有投影註冊表**——那是
 *    `@nexus/core` 的 `sessions.ts` 已經標過的同一條偏離（「後半還沒有」），不是這張卡新
 *    造的。今天讀清單的路是日誌本身與遙測。
 * 2. **沒有 `output.schema` 與 `presentCall` 的卡片。** dsh 的工具回結構化結果並自己渲染；
 *    我們的工具回一句字串（LangChain 的 `tool()` 形狀）。模型看到的那句話逐字照抄 dsh 的
 *    `Updated todo list: … pending, … in progress, … completed.`
 * 3. **驗證失敗是回字串，不是拋。** dsh 的 `execute` 直接 `throw`，它的 harness 把錯渲染
 *    成一則工具結果交回模型。**LangGraph 的 ToolNode 不接**——實測（驗收在
 *    `apps/harness/src/todo-tool.test.ts`）一顆重複的 content 會讓 `agent.invoke` 整個炸掉，
 *    也就是模型打錯一次字就死一輪。所以工具自己接住，回的那句話帶著 dsh 那個 `Error: `
 *    前綴，讓模型手上拿到的字與 dsh 一致。見 {@link TODO_ERROR_PREFIX}。
 *
 * @see [#132](https://github.com/DemianLi/nexus-agent/issues/132)
 * @module
 */

import { tool } from '@langchain/core/tools';
import type { NexusPlugin, PluginRegistry, TodoItem, TodoStatus } from '@nexus/core';
import { TODO_STATUSES } from '@nexus/core';
import { z } from 'zod';

/** 註冊出來的工具名。**照 dsh 的 `todo_write`**，不是 langchain 那顆 `write_todos`。 */
export const TODO_TOOL_NAME = 'todo_write';

/** 這次組裝沒接上會話註冊表時工具回的話。 */
export const TODO_NOT_ATTACHED_MESSAGE = '這次組裝沒有接上會話日誌，清單沒有地方放，所以沒有寫。';

/**
 * 認不出呼叫者時回的話。
 *
 * **與 {@link TODO_NOT_ATTACHED_MESSAGE} 刻意不同一句**：兩種都是「寫不進去」，但要修的
 * 東西不一樣——一個是組裝點漏了 `attachSession`，一個是這次呼叫根本不在圖裡。
 */
export const TODO_UNKNOWN_CALLER_MESSAGE =
  '認不出這次呼叫屬於哪一個會話，清單沒有主人，所以沒有寫。';

/**
 * 一次組裝綁著多張註冊表時回的話。
 * @param count - 綁著幾張。
 * @returns 給模型的那句話。
 */
export function todoAmbiguousMessage(count: number): string {
  return `這次組裝接了 ${count} 份會話，挑不出該寫哪一份，所以沒有寫。`;
}

/**
 * 驗證失敗回給模型的那一句的前綴。
 *
 * **`Error: ` 這四個字是模型體驗的一部分，不是裝飾。** dsh 的工具是**拋**的，它的 harness
 * 把拋出來的東西渲染成 `Error: <message>` 交回模型（README 把那幾句列成「稳定失败文本」）。
 * 我們這側拋不得——實測 LangGraph 的 ToolNode **不接**，一顆重複的 content 會把整輪炸掉
 * （驗收在 `apps/harness/src/todo-tool.test.ts`）。所以工具自己接住並回字串，而字串要與
 * dsh 交到模型手上的那一句一致。
 */
export const TODO_ERROR_PREFIX = 'Error: ';

/** content 空掉時的錯誤，逐字照 dsh。 */
export const TODO_EMPTY_CONTENT_MESSAGE = 'invalid todo: `content` must be a non-empty string';

/**
 * content 重複時的錯誤，逐字照 dsh。
 * @param content - 重複的那一句。
 * @returns 錯誤訊息。
 */
export function todoDuplicateMessage(content: string): string {
  return `invalid todos: duplicate content ${JSON.stringify(content)}`;
}

/**
 * 禁止並行時多於一條 `in_progress` 的錯誤，逐字照 dsh。
 * @param count - 實際有幾條。
 * @returns 錯誤訊息。
 */
export function todoParallelMessage(count: number): string {
  return `invalid todos: at most one task may be in_progress (got ${count})`;
}

const DESCRIPTION_HEAD =
  'Record and update a structured task list for the current work. Send the ENTIRE ' +
  'list every call — it REPLACES the previous list (there are no partial updates, ' +
  'no per-item edits). Use it to plan multi-step work and show progress: add one ' +
  'todo per concrete step before you start. ';

const DESCRIPTION_PARALLEL =
  'Mark every todo being actively worked ' +
  'on `in_progress` — several at once when work genuinely runs in parallel (e.g. ' +
  'concurrent subagents or background commands), one for sequential work; while ' +
  'work remains, at least one task should be `in_progress`. ';

const DESCRIPTION_SINGLE =
  'Keep AT MOST ONE todo `in_progress` at a ' +
  'time; while work remains, exactly one active task should be `in_progress`. ';

const DESCRIPTION_TAIL =
  'Mark a todo ' +
  '`completed` the moment it is done (do not batch completions), and allow no ' +
  '`in_progress` item only once all work is complete. Skip the list for trivial ' +
  'single-step tasks. Statuses: `pending` (not started), `in_progress` (being ' +
  'worked on now), `completed` (finished).';

/**
 * 這一次掛載給模型看的描述。
 *
 * **只有「活躍狀態」那一段跟著設定變**，因為那是並行政策唯一改變的指令——逐字照 dsh 的
 * `describe()`。描述是英文的，同這棵樹裡其他面向模型的字串。
 *
 * @param allowParallel - 允不允許同時多條 `in_progress`。
 * @returns 組好的描述。
 */
export function todoToolDescription(allowParallel: boolean): string {
  return (
    DESCRIPTION_HEAD +
    (allowParallel ? DESCRIPTION_PARALLEL : DESCRIPTION_SINGLE) +
    DESCRIPTION_TAIL
  );
}

/** 模型送進來的一條，schema 擋過之後的形狀。 */
interface RawTodo {
  readonly content: string;
  readonly status: TodoStatus;
}

/**
 * 把模型送的清單收成正規的 {@link TodoItem}[]，**壞的當場拋**。
 *
 * schema 已經擋掉狀態列舉與多餘的鍵（`.strict()`——落庫的快照必須等於模型以為它寫的
 * 東西），這裡補的是 schema 表達不出來的三條：去空白後非空、不重複，以及並行政策。
 *
 * @param raw - schema 驗過的清單。
 * @param allowParallel - 允不允許同時多條 `in_progress`。
 * @returns 正規化後的清單。
 * @throws content 空、content 重複，或禁止並行時多於一條 `in_progress`。
 */
export function toTodoList(raw: readonly RawTodo[], allowParallel: boolean): TodoItem[] {
  const todos: TodoItem[] = [];
  const seen = new Set<string>();
  let active = 0;
  for (const item of raw) {
    const content = item.content.trim();
    if (content.length === 0) throw new Error(TODO_EMPTY_CONTENT_MESSAGE);
    if (seen.has(content)) throw new Error(todoDuplicateMessage(content));
    seen.add(content);
    if (item.status === 'in_progress') active++;
    todos.push({ content, status: item.status });
  }
  if (!allowParallel && active > 1) throw new Error(todoParallelMessage(active));
  return todos;
}

/**
 * 成功時回給模型的那句話，逐字照 dsh。
 * @param todos - 剛寫進去的清單。
 * @returns 三個計數組成的那一行。
 */
export function todoCountsMessage(todos: readonly TodoItem[]): string {
  const count = (status: TodoStatus): number =>
    todos.filter((todo) => todo.status === status).length;
  return (
    `Updated todo list: ${count('pending')} pending, ` +
    `${count('in_progress')} in progress, ${count('completed')} completed.`
  );
}

/** 掛 todo 工具時要決定的東西。 */
export interface TodoPluginOptions {
  /**
   * 允不允許同時有多條 `in_progress`。
   *
   * **必填，沒有預設**——這一條照 dsh，而它的理由值得抄過來：工具**觀測不到執行期的
   * 並行**，所以這是部署方要拍的板，不是工具猜得出來的東西。它同時決定模型看到的描述
   * （見 {@link todoToolDescription}）與拒絕條件，兩者必須是同一個答案。
   *
   * **不變量刻意不跟著它走**：一份在允許並行時寫下的日誌，在政策收緊之後仍然要回放得了。
   * 見 [`./invariant.ts`](./invariant.ts)。
   */
  readonly allowParallelInProgress: boolean;
}

/**
 * 建一個 todo plugin。
 *
 * 它只掛一樣東西：`tools` 通道的 `todo_write`。**不註冊命令、不改 prompt、不碰 backend**
 * ——理由見檔頭那張表。
 *
 * **刻意不是 `rootOnly`。** 宣告 `rootOnly` 的話 fold 會把每個 subagent 那一份裡的同名項
 * 換成拒絕樁，而那與 dsh 的單一所有者規則相反。
 *
 * @param options - 並行政策，必填。
 * @returns 這一次掛載。
 */
export function createTodoPlugin(options: TodoPluginOptions): NexusPlugin {
  const allowParallel = options.allowParallelInProgress;
  return {
    name: 'todo',
    apply(registry: PluginRegistry): void {
      registry.tools.register(
        tool(
          ({ todos: raw }: { todos: RawTodo[] }, config?: unknown) => {
            // **先驗再找日誌**：驗不過的那一次連日誌都不必問，而且錯誤訊息與「寫不進去」
            // 是兩回事——前者是模型送錯東西，後者是接線的問題。
            //
            // **接住而不是往外拋。** dsh 那側拋得起，因為它的 harness 會把錯渲染成一則
            // 工具結果交回模型；LangGraph 的 ToolNode **不接**，往外拋等於一顆打錯的
            // todo 把整輪弄死。見 {@link TODO_ERROR_PREFIX}。
            let todos: readonly TodoItem[];
            try {
              todos = toTodoList(raw, allowParallel);
            } catch (error: unknown) {
              return TODO_ERROR_PREFIX + (error instanceof Error ? error.message : String(error));
            }
            const found = registry.sessions.forCall(config);
            if (found.kind === 'not-attached') return TODO_NOT_ATTACHED_MESSAGE;
            if (found.kind === 'unknown-caller') return TODO_UNKNOWN_CALLER_MESSAGE;
            if (found.kind === 'ambiguous') return todoAmbiguousMessage(found.count);
            found.log.append('todo/write', { todos });
            return todoCountsMessage(todos);
          },
          {
            name: TODO_TOOL_NAME,
            description: todoToolDescription(allowParallel),
            schema: z.object({
              todos: z
                .array(
                  z
                    .object({
                      content: z.string().describe('What the task is — a short imperative line.'),
                      status: z
                        .enum(TODO_STATUSES)
                        .describe('pending (not started) | in_progress (now) | completed (done).'),
                    })
                    // 多餘的鍵**當場擋**，不靜默攤平：落庫的快照要等於模型以為它寫的東西。
                    .strict(),
                )
                .describe('The COMPLETE task list, replacing any previous list.'),
            }),
          },
        ),
      );
    },
  };
}
