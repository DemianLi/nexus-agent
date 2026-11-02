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
 * 工具靠樹上會話查找服務的 `forCall(config)`（`@nexus/session`，#1463）拿自己這次該寫的那一份——
 * **關鍵是它宣告了 handler 的第二個參數**，身分只在 `ToolRunnableConfig` 裡。服務在 `apply` 當下抓進閉包，
 * `forCall` 在呼叫當下才問：行程裡同時活著幾條 thread，每一次呼叫都靠 `thread_id` 認出主人。
 *
 * ## 與 dsh 的偏離，三條
 *
 * 1. **`todos` 投影不由這個套件註冊。** dsh 由 plugin 自己往 `ctx.sessionProjections` 註冊一個單元
 *    （`turn/start` 清空、`todo/write` 換成最新、`turn/end` 保留），UI 從那裡讀。我們把同一套規則寫在消費者那一側
 *    （[#575](https://github.com/DemianLi/nexus-agent/issues/575)）：harness 的 pump 與歷史路由把 root 的 `todo/write` 與開新
 *    一輪的 `turn/start` 合成 `custom` frame，`@nexus/wire` 折成 `ConversationState.todos`，同交付（#441）、改動（#443）、
 *    用量（#528）。偏的是載體，規則照抄；唯一的對應是「一輪開始」不含 `resume`，理由見 `@nexus/wire` 的 `todos.ts`。
 *
 *    **理由更新（#1463）：** 這一條原本寫的理由是「我們沒有投影註冊表」，那在 #1421 之後不成立了——`@nexus/projections`
 *    已經存在，樹上有 `projections` 那一列。**現在不搬的理由是搬了會動到 wire 與 web**（`conversation-history.ts`、
 *    `thread-pump.ts` 的合成與 `@nexus/wire` 的折疊器都要換來源），那是一張自己的卡，不跟「遷上樹」混在一起。
 *    **另開卡的條件**：有第二個消費者要讀 `todos` 投影（例如另一個入口或評測要同一份折疊），或 wire 的 `custom` frame
 *    那條合成路徑要整個改道的時候。**投影本身這張不搬。**
 * 2. **沒有 `output.schema` 與 `presentCall` 的卡片。** dsh 的工具回結構化結果並自己渲染；
 *    我們的工具回一句字串（LangChain 的 `tool()` 形狀）。模型看到的那句話逐字照抄 dsh 的
 *    `Updated todo list: … pending, … in progress, … completed.`
 * 3. **驗證失敗是回錯誤訊息，不是拋。** dsh 的 `execute` 直接 `throw`，它的 harness 把錯渲染
 *    成一則 `isError` 的工具結果交回模型。我們回一則 `status: 'error'` 的 ToolMessage——同樣
 *    是錯誤，而模型手上的字與 dsh 一致（`Error: ` 前綴由 `@nexus/core` 的 `toolRefusal` 加）。
 *    不拋是因為拋給圍堵的話，模型看到的字會變成「工具 todo_write 執行失敗：…」。驗收在
 *    `apps/harness/src/todo-tool.test.ts`；決議見 [#271](https://github.com/DemianLi/nexus-agent/issues/271)。
 *
 * ## 遷上 Cordis 樹（[#1463](https://github.com/DemianLi/nexus-agent/issues/1463)，Part of #1385）
 *
 * 函式插件，具名匯出 `name`／`inject`／`Config`／`manifest`／`apply`，**沒有 default**；`src/index.ts` 不 import `@nexus/core`
 * （套 #1420 的 lint 設定）。要的兩個服務都由宿主在樹上提供：
 *
 * - `tools`（`@nexus/tools`，契約 `^1.0.0`）：登記 `todo_write`，不帶選項（**刻意不是 `rootOnly`**，見上）。
 * - `sessionLookup`（`@nexus/session`，契約 `^1.0.0`）：「這次呼叫該寫進哪一份日誌」。**在 `apply` 當下抓進閉包**，呼叫當下才
 *   `forCall`：列卸載之後經 `ctx` 取服務會拋（`cannot get required service … in inactive context`），抓住的那份仍可呼叫，
 *   所以「這一列停用之後，開著的 thread 照樣寫得進自己的日誌」。
 *
 * **這是逐條 thread 接縫的第三段**（#1418 → #1458 → 這張）：服務看的是行程裡**每一條活著的 thread**，多條同時活著時每一次
 * 呼叫都靠 `configurable.thread_id` 認出主人。挑法與 `registry.sessions.forCall` 是同一支實作（`@nexus/core` 的
 * `pickSessionForCall`）。這個插件**只認服務回來的四種結果**，不在這裡再挑一次。
 *
 * **舊的 `NexusPlugin` 外殼搬走了**（`apps/harness/src/todo.fixture.ts`，同 echo、skills、feedback、ask-user 的前例）：還在
 * 相容層組裝的測試經它掛這顆工具，它與樹上這一列共用 {@link createTodoTool}，所以兩邊的工具本體是同一份程式碼。
 *
 * **`src/invariant.ts` 不在這條路上**：配套入口還是相容層的列（`todo-invariant`），它 import `@nexus/core` 並寫 `NexusPlugin`。
 * 它從 SDK lint 排除（偏離，登記在 `docs/plugin-contract.md`；撤除條件是 2026-11-03 配套入口重審）。
 *
 * @see [#132](https://github.com/DemianLi/nexus-agent/issues/132)
 * @module
 */

import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { Context } from '@nexus/cordis';
import { defineManifest, injectOf, need, service } from '@nexus/sdk';
import { sessionLookupToken, TODO_STATUSES } from '@nexus/session';
import type { SessionLookup, TodoItem, TodoStatus } from '@nexus/session';
import { toolCallIdOf, toolRefusal } from '@nexus/tool-result';
import { toolsToken } from '@nexus/tools';
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

/**
 * 掛 todo 工具時要決定的東西。
 *
 * `allowParallelInProgress` **必填，沒有預設**——這一條照 dsh，而它的理由值得抄過來：
 * 工具**觀測不到執行期的並行**，所以這是部署方要拍的板，不是工具猜得出來的東西。它同時
 * 決定模型看到的描述（見 {@link todoToolDescription}）與拒絕條件，兩者必須是同一個答案。
 *
 * **不變量刻意不跟著它走**：一份在允許並行時寫下的日誌，在政策收緊之後仍然要回放得了。
 * 見 [`./invariant.ts`](./invariant.ts)。
 */
export const todoConfigSchema = z.strictObject({
  allowParallelInProgress: z.boolean(),
});

/** 驗過的設定。 */
export type TodoConfig = z.infer<typeof todoConfigSchema>;

/** 工廠收的東西：schema 的輸入面。 */
export type TodoPluginOptions = z.input<typeof todoConfigSchema>;

/**
 * 組出 `todo_write` 這顆工具。
 *
 * **工具本體只有這一份**：樹上的列（{@link apply}）與還在相容層組裝的測試（`apps/harness/src/todo.fixture.ts`）都從這裡取。
 * 它們之間唯一不同的是「這次呼叫的會話怎麼來」，所以那一格是參數。
 *
 * @param allowParallel - 允不允許同時多條 `in_progress`；決定描述與拒絕條件，兩者是同一個答案。
 * @param lookup - 這次呼叫的會話查找。**在呼叫當下才呼叫它**，不在建工具的時候。參數是工具 handler 的第二個參數（整份原樣，
 *   thread 身分在裡面）。
 * @returns 可以登記的工具。
 */
export function createTodoTool(
  allowParallel: boolean,
  lookup: (invocation: unknown) => SessionLookup,
): StructuredToolInterface {
  return tool(
    ({ todos: raw }: { todos: RawTodo[] }, invocation?: unknown) => {
      // 四條出口都是「這次呼叫沒有生效」，一律回錯誤訊息、不帶碼：dsh 對驗證失敗拋的是
      // 一般 `Error`，後三條 dsh 沒有對應物。
      const refuse = (message: string) =>
        toolRefusal(message, { callId: toolCallIdOf(invocation) ?? '', name: TODO_TOOL_NAME });
      // **先驗再找日誌**：驗不過的那一次連日誌都不必問，而且錯誤訊息與「寫不進去」
      // 是兩回事——前者是模型送錯東西，後者是接線的問題。
      //
      // **接住而不是往外拋**，見檔頭第 3 條。
      let todos: readonly TodoItem[];
      try {
        todos = toTodoList(raw, allowParallel);
      } catch (error: unknown) {
        return refuse(error instanceof Error ? error.message : String(error));
      }
      const found = lookup(invocation);
      if (found.kind === 'not-attached') return refuse(TODO_NOT_ATTACHED_MESSAGE);
      if (found.kind === 'unknown-caller') return refuse(TODO_UNKNOWN_CALLER_MESSAGE);
      if (found.kind === 'ambiguous') return refuse(todoAmbiguousMessage(found.count));
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
  );
}

/** 插件在樹上的列用的名字（`ctx.fiber.runtime.name`，錯誤訊息、log 與相容層清單用）。 */
export const name = 'todo';

/**
 * 要的服務：`tools`（`^1.0.0`，不帶選項）與 `sessionLookup`（`^1.0.0`）。範圍在這裡宣告，經
 * `Service.resolveIntercept` 合併，提供者的 `check` 讀得到。
 */
export const inject = injectOf(need(toolsToken, '^1.0.0'), need(sessionLookupToken, '^1.0.0'));

/** 這個插件的設定（manifest 的 `config`）：見 {@link todoConfigSchema}。`strictObject`：未知欄位讓載入失敗。 */
export const Config = todoConfigSchema;

export const manifest = defineManifest({
  id: 'todo',
  version: '0.1.0',
  owner: '平台團隊',
  provides: [],
  consumes: [
    { token: toolsToken.name, range: '^1.0.0' },
    { token: sessionLookupToken.name, range: '^1.0.0' },
  ],
  config: Config,
  // 換程式碼要重啟行程；設定（並行政策）只給新的 thread（#1405、決議 §3-2 第 6 條：組 thread 時取快照）。
  reload: { code: 'restart', config: 'next-thread' },
  capabilities: [],
});

/**
 * 掛上：把 `todo_write` 登記進行程級的工具登記處。
 *
 * **會話查找在這裡抓進閉包**，列卸載之後經 `ctx` 取服務會拋，抓住的那份仍可呼叫（見檔頭）。**呼叫當下才 `forCall`**：
 * 行程裡活著哪幾條 thread 是呼叫當下的事實，不是掛載當下的。
 *
 * @param ctx - 這一列的 Cordis context。
 * @param config - 驗過的設定。
 */
export function apply(ctx: Context, config: TodoConfig): void {
  const sessions = service(ctx, sessionLookupToken);
  service(ctx, toolsToken).register(
    createTodoTool(config.allowParallelInProgress, (invocation) => sessions.forCall(invocation)),
  );
}
