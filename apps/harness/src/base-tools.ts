/**
 * 基座自己帶進來、不經過我們 registry 的工具名。
 *
 * 這是 `foldRegistry` 的 `baseToolNames` 輸入——**設定驗證用的名字宇宙**，不是「這一次
 * 會出現哪些工具」。形狀照 dsh 的 `ToolProviderResult.knownNames`
 * （`packages/core/system-prompt/src/index.ts`）：宇宙由提供者貢獻，而基座是這幾個名字
 * 唯一的提供者。所有權留在這裡，因為 `apps/harness` 是唯一呼叫 `createDeepAgent` 的
 * 地方，只有它知道自己開了哪些東西。
 *
 * 名單不能從 `deepagents` import——`FILESYSTEM_TOOL_NAMES` 與 `ASYNC_TASK_TOOL_NAMES`
 * 都沒有出現在它的 public export 裡（1.13.1 實測）。所以是手抄的，而
 * [`baseline.test.ts`](./baseline.test.ts) 的第一條測試就是它的守衛：那條斷言
 * `StateBackend` 下基座實際註冊了哪些工具，名單漂掉時會當場紅。
 */

/**
 * 檔案系統工具，出處是基座的 `FILESYSTEM_TOOL_NAMES`（`src/middleware/fs.ts`）。
 *
 * `execute` 列在裡面但**不一定會出現**：基座只在 backend 支援命令執行時才註冊它
 * （`StateBackend` 沒有 shell，所以現在看不到）。宇宙照樣要收——「這一次不可見」與
 * 「這個名字不存在」是兩件事，Phase 2 的 sandbox backend 會讓它變成真的。
 */
const FILESYSTEM_TOOL_NAMES = [
  'ls',
  'read_file',
  'write_file',
  'edit_file',
  'delete',
  'glob',
  'grep',
  'execute',
] as const;

/**
 * 基座工具的完整名字宇宙。
 *
 * **`ASYNC_TASK_TOOL_NAMES` 那五個刻意不收**（`start_async_task` / `check_async_task` /
 * `update_async_task` / `cancel_async_task` / `list_async_tasks`）。基座只在
 * `subagents` 裡出現 `AsyncSubAgent`（帶 `graphId` 的那種）時才掛上那組工具，而
 * `registry.subagents.register()` 收的是 `SubAgent`，型別上就進不來——所以在目前的組裝
 * 裡那五個名字**永遠不會存在**。把它們放進宇宙的下場是
 * `interrupts.require('start_async_task', ...)` 通過檢查然後什麼都不擋，正是那條檢查
 * 存在的理由。哪天真的支援 async subagent，這裡跟著補。
 */
export const BASE_TOOL_NAMES: readonly string[] = [
  ...FILESYSTEM_TOOL_NAMES,
  // subagent middleware 帶的委派工具，不是檔案工具。
  'task',
];

/**
 * 基座**拒絕**被自訂工具佔用的名字。
 *
 * 出處是 `createDeepAgent()` 開頭那段 `BUILTIN_TOOL_NAMES` 檢查：`tools` 裡有任何一個
 * 名字落在這個集合，它直接丟 `ConfigurationError('TOOL_NAME_COLLISION')`。這裡與
 * {@link BASE_TOOL_NAMES} 剛好同一份名單，但**是兩個不同的概念**——一個是「驗證用的
 * 名字宇宙」（刻意寬），一個是「不准叫這些名字」（基座說了算）。基座那份還多了 async
 * 那五個；我們不重抄，因為我們產不出會觸發它們的組裝，而且真撞了基座自己會擋。
 */
export const RESERVED_BASE_TOOL_NAMES: ReadonlySet<string> = new Set(BASE_TOOL_NAMES);
