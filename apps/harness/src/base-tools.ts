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
 *
 * **這兩個常數與模型無關，而基座那側不是。** `createDeepAgent()` 會依 `model` 解出一份
 * harness profile，那份 profile 加得了工具也拿得掉工具——「基座這次帶哪些名字」因此是
 * 模型的函式，是這裡的常數形狀表達不出來的東西。那件事在
 * [`harness-profile.ts`](./harness-profile.ts) 處理，見
 * [#140](https://github.com/DemianLi/nexus-agent/issues/140)。
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
 * async subagent 橋接工具，出處是基座的 `ASYNC_TASK_TOOL_NAMES`
 * （`src/middleware/async_subagents.ts`）。
 */
const ASYNC_TASK_TOOL_NAMES = [
  'start_async_task',
  'check_async_task',
  'update_async_task',
  'cancel_async_task',
  'list_async_tasks',
] as const;

/**
 * 基座工具的名字宇宙——「這個名字有可能指到一個真的工具」。
 *
 * **`ASYNC_TASK_TOOL_NAMES` 那五個刻意不收。** 基座只在 `subagents` 裡出現
 * `AsyncSubAgent`（帶 `graphId` 的那種）時才掛上那組工具，而
 * `registry.subagents.register()` 收的是 `SubAgent`，型別上就進不來——所以在目前的組裝
 * 裡那五個名字**永遠不會有對應的工具**。把它們放進宇宙的下場是 `toolOrder` 列了一個
 * 排不到任何東西的名字而不報錯。哪天真的支援 async subagent，這裡跟著補。
 *
 * （這份宇宙過去還餵給核准的名字檢查，那條隨機制一起走了——見
 * [#111](https://github.com/DemianLi/nexus-agent/issues/111)。）
 *
 * `execute` 反過來要收：它現在也看不見（`StateBackend` 沒有 shell），但只要換一個支援
 * 命令執行的 backend 它就在，而換 backend 是組裝點的一個參數而已。
 */
export const BASE_TOOL_NAMES: readonly string[] = [
  ...FILESYSTEM_TOOL_NAMES,
  // subagent middleware 帶的委派工具，不是檔案工具。
  'task',
];

/**
 * 基座**拒絕**被自訂工具佔用的名字——「不准叫這個名字」。
 *
 * 出處是 `createDeepAgent()` 開頭那段 `BUILTIN_TOOL_NAMES` 檢查：`tools` 裡有任何一個
 * 名字落在這個集合，它直接丟 `ConfigurationError('TOOL_NAME_COLLISION')`。
 *
 * **它比 {@link BASE_TOOL_NAMES} 多了 async 那五個，而且那不是疏漏。** 基座那段檢查是
 * **無條件**跑的——不管這次組裝有沒有 async subagent，名字一律保留。這正是這兩個常數
 * 必須分開的地方：「這個名字會不會指到一個真的工具」是條件式的（async 五個現在不會，
 * 所以不進宇宙，否則核准標記會標在空氣上），「這個名字准不准用」是無條件的（少收了就
 * 會有 plugin 順利通過我們的檢查、再撞上基座那個沒有 plugin 姓名的錯誤訊息）。
 */
export const RESERVED_BASE_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...BASE_TOOL_NAMES,
  ...ASYNC_TASK_TOOL_NAMES,
]);
