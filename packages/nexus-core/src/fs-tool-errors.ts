/**
 * 檔案工具失敗了就是錯誤：基座的檔案工具回報 backend 錯誤時，把結果標成 `status: 'error'`。
 *
 * ## 缺口在基座
 *
 * `deepagents@1.13.1` 的 `write_file`／`edit_file`／`grep` 遇到 backend 回的 `{ error }` 時
 * `return result.error`，`ls`／`glob` 回帶前綴的字串，`read_file` 回 `Error: …` 文字塊
 * （`dist/langsmith-zm0ILQsV.js:2037`、`:2066`、`:2144`、`:2176`、`:2246`、`:2273`）——
 * `ToolNode` 把它們包成 `status: "success"`。同一份原始碼的 `toolError()` 註解自己寫著裸字串會被
 * 當成成功，所以權限路徑與 `delete` 用它；其餘那幾處沒用。`1.13.4` 與上游 `main` 照舊。
 * 後果是 fence 擋下的寫入在會話日誌是 `isError: false`、web 畫成「完成」、離線掃描數不到
 * （[#293](https://github.com/DemianLi/nexus-agent/issues/293)，2026-09-13 live 實跑量到）。
 *
 * **這一層只修得到日誌與模型那一半。** web 的工具卡來自基座在工具本體裡就發的 `tool-finished`，
 * 早於這裡換狀態；那一半由 pump 改以日誌的 `tool/result` 為準才修掉
 * （[#296](https://github.com/DemianLi/nexus-agent/issues/296)，`apps/harness/src/thread-pump.ts`）。
 *
 * ## 對 dsh
 *
 * dsh 的 `write`／`edit` 在工具本體裡拋 `FsError`（`packages/fs/tool-fs/src/write.ts:116-123`，
 * SHA `c291e79`），註冊表渲染成 `isError`；sandbox 拒絕的碼是 `FS_SANDBOX_DENIED`
 * （`tool-fs/src/sandbox.ts:124-130`），其餘檔案失敗照樣是 `isError`。**範圍照抄**：每一種 backend
 * 錯誤都是錯誤；fence 拒絕帶 `FS_SANDBOX_DENIED`，自己實作的 `read`／`edit`／`write` 失敗帶 `FS_NOT_FOUND` 等七個原因碼
 * （{@link noteFsError}，#1563）。其餘（基座的 `ls`／`glob`／`delete`）仍沒有碼，要分得解析基座的措辭。**文字只補
 * `Error: `**：原本是一字不變（[#271](https://github.com/DemianLi/nexus-agent/issues/271)），
 * [#318](https://github.com/DemianLi/nexus-agent/issues/318) 照 dsh 的 `toolErrorResult` 補上前綴，
 * 基座自己已經寫成錯誤的那幾句不補（見 {@link fsToolErrorsListener}）。
 *
 * **碼不只給基座的檔案工具**（[#316](https://github.com/DemianLi/nexus-agent/issues/316)）：dsh 的註冊表
 * 從拋出來的錯誤通用地取碼，不看是哪顆工具，所以 plugin 工具（`submit_record`）被同一道 fence 擋下
 * 也該帶。記錄每一顆工具呼叫都開；換狀態、補前綴仍只對基座那七個，其餘只補碼（`withSandboxCode`）。
 *
 * **偏離：在工具外面改狀態，不是在工具裡拋。** 基座的檔案工具我們改不了，所以退到最接近的——
 * `tools/execute` 最內層的一位監聽者，結果離開之前換狀態。時刻是 dsh 的 `tools/execute`：拋在工具
 * 本體裡、註冊表接住的那一刻（攔截索引的第 6 格，`apps/harness/src/interception-index.test.ts`）。
 * 判準是結構訊號而不是字面：
 *
 * - {@link recordBackendOutcomes} 包住交給基座的 backend，記下**這一次呼叫**裡每個方法最後一次
 *   回的是不是 `{ error }`；
 * - 監聽者只看那顆工具**主要的那個方法**（{@link FS_TOOL_PRIMARY_METHOD}）。基座的工具在主要
 *   方法回錯時一律立刻回報，其餘方法的錯不算——`delete` 先 `ls` 判斷是不是目錄，那一次的錯是
 *   它的判斷依據，不是失敗。
 *
 * **「這一次呼叫」由 `AsyncLocalStorage` 界定**，不走 backend factory：`resolveBackend` 雖然接受
 * `(runtime) => backend`，但 `BackendFactory` 在基座的型別上是 `@deprecated`（「Pass a
 * pre-constructed backend instance instead of a factory」），把新機制押在要退場的縫上，升版時會
 * 無聲失效。包的是同一個實例，「先讀後改」照樣從工具實際讀寫的那一個取版本。
 *
 * ## 已知的界線
 *
 * - 只認得 `BackendProtocolV2` 的 `{ error }` 形狀。回裸字串的 v1 backend（plugin 掛的路由若是）
 *   由基座的轉接器轉，這一層在轉接之前，看不到。
 * - 沒有 backend 的組裝（基座自己的 `StateBackend`）不包、不掛——那條路上沒有 fence。
 * - 非檔案工具的碼認的是「這次呼叫裡 fence 喊過拒絕，而工具回了錯誤」，不是 dsh 那樣認拋出來的
 *   那顆錯誤。差別在同一次呼叫裡有兩件事時：子代理在 `task` 那一次呼叫裡跑，它的摘要器 offload
 *   被擋也記在 `task` 身上。今天走不到：`task`（`deepagents@1.13.1`，`langsmith-Ck9t7AGW.cjs:3532-3568`）
 *   成功回 `Command`、失敗是拋，都不是這裡補碼的那種結果。
 * - 包在 `Command` 裡回的錯誤不補碼。
 *
 * @module
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { toolNameOfCall } from './tool-call-step.js';
import { TOOL_ERROR_PREFIX } from './tool-events.js';
import type { CoreToolListener, PipelineExecuteResult, PipelineResult } from './tool-pipeline.js';

/** `tools/execute` 的 core 監聽者沿用的名字；stack 裡沒有叫這個名字的一格，`@nexus/core` 主入口仍轉出。 */
export const FS_TOOL_ERRORS_MIDDLEWARE_NAME = 'nexusFsToolErrors';

/** fence 擋下一次變更的碼。dsh `FsErrorCode` 的同名成員。 */
export const FS_SANDBOX_DENIED = 'FS_SANDBOX_DENIED';

/**
 * 檔案工具失敗的原因碼（[#1563](https://github.com/DemianLi/nexus-agent/issues/1563)）。除 `FS_NO_SPACE` 外字面照 dsh `FsErrorCode`
 * （`packages/fs/fs/src/types.ts:176-188`，`687f282e`）。載體跟 {@link FS_SANDBOX_DENIED} 一樣：backend 在這一次呼叫的記錄上寫碼
 * （{@link noteFsError}），監聽者標錯時帶出去，最後落進會話日誌那顆 `tool/result` 的 `error`，web 的 trace 列照實顯示。
 *
 * - `FS_NOT_FOUND`：路徑不存在（`read`／`edit`）。
 * - `FS_NOT_REGULAR_FILE`：路徑存在但不是一般檔（目錄等）。
 * - `FS_NOT_TEXT`：二進位檔，或不是合法 UTF-8。
 * - `FS_EDIT_NOT_FOUND`：`old_string` 是空的，或在檔案裡找不到。
 * - `FS_AMBIGUOUS_EDIT`：`old_string` 命中好幾處、又沒有 `replace_all`。
 * - `FS_PERMISSION_DENIED`：作業系統回 `EACCES`／`EPERM`。
 * - `FS_NO_SPACE`：作業系統回 `ENOSPC`／`EDQUOT`（[#2195](https://github.com/DemianLi/nexus-agent/issues/2195)）。
 *
 * **不做 `FS_TOO_LARGE`：** nexus 的 `read` 沒有整檔大小上限（#1530 刻意不加，dsh 的 read 工具也沒有；dsh 的 `FS_TOO_LARGE` 只出在
 * `readWholeBytes` 的 `maxBytes`，給附件與媒體用），沒有產生它的地方。**`FS_ABORTED` 不做：** 基座的 backend 方法拿不到取消訊號。
 */
export const FS_NOT_FOUND = 'FS_NOT_FOUND';
export const FS_NOT_REGULAR_FILE = 'FS_NOT_REGULAR_FILE';
export const FS_NOT_TEXT = 'FS_NOT_TEXT';
export const FS_EDIT_NOT_FOUND = 'FS_EDIT_NOT_FOUND';
export const FS_AMBIGUOUS_EDIT = 'FS_AMBIGUOUS_EDIT';
export const FS_PERMISSION_DENIED = 'FS_PERMISSION_DENIED';
export const FS_NO_SPACE = 'FS_NO_SPACE';

/** 檔案工具失敗的七個原因碼（不含 fence 的 {@link FS_SANDBOX_DENIED}，它有自己的旁路）。 */
export type FsErrorCode =
  | typeof FS_NOT_FOUND
  | typeof FS_NOT_REGULAR_FILE
  | typeof FS_NOT_TEXT
  | typeof FS_EDIT_NOT_FOUND
  | typeof FS_AMBIGUOUS_EDIT
  | typeof FS_PERMISSION_DENIED
  | typeof FS_NO_SPACE;

/**
 * 搜尋失敗的碼（[#1532](https://github.com/DemianLi/nexus-agent/issues/1532)）。dsh `SearchErrorCode` 的四個成員
 * （`packages/fs/tool-fs-search/src/search-core.ts:78-82`，`687f282e`），字面照抄。載體跟 {@link FS_SANDBOX_DENIED}
 * 一樣：backend 在這一次呼叫的記錄上寫碼（{@link noteSearchError}），監聽者標錯時帶出去，最後落進會話日誌
 * 那顆 `tool/result` 的 `error`。nexus 沒有 dsh 的 `HarnessError` 註冊表，這是 #293 已經用過的載體，不另立新的。
 */
export const SEARCH_INVALID_PATTERN = 'SEARCH_INVALID_PATTERN';
export const SEARCH_FAILED = 'SEARCH_FAILED';
export const SEARCH_RAW_OUTPUT_OVERFLOW = 'SEARCH_RAW_OUTPUT_OVERFLOW';
export const SEARCH_ABORTED = 'SEARCH_ABORTED';

/** 搜尋失敗的四個碼。 */
export type SearchErrorCode =
  | typeof SEARCH_INVALID_PATTERN
  | typeof SEARCH_FAILED
  | typeof SEARCH_RAW_OUTPUT_OVERFLOW
  | typeof SEARCH_ABORTED;

/**
 * 基座自己寫成錯誤的那幾句的開頭：`read_file` 的 `Error: …`、`ls`／`glob` 的 `Error listing files: …`
 * 與 `Error finding files: …`（`deepagents@1.13.1`，見檔頭）。這幾句不補前綴，理由見 {@link fsToolErrorsListener}。
 */
const BASE_ERROR_WORD = 'Error';

/**
 * 基座的檔案工具 → 它回報失敗所依據的那個 backend 方法。
 *
 * 名字是 `deepagents@1.13.1` 內建工具的名字，不是我們取的（同 `observation.ts` 的
 * `OBSERVED_*`）。
 */
export const FS_TOOL_PRIMARY_METHOD: Readonly<Record<string, string>> = {
  ls: 'ls',
  read_file: 'read',
  write_file: 'write',
  edit_file: 'edit',
  glob: 'glob',
  grep: 'grep',
  delete: 'delete',
};

const TRACKED_METHODS = new Set(Object.values(FS_TOOL_PRIMARY_METHOD));

/** 一次工具呼叫裡記下的東西。 */
interface CallRecord {
  /** 每個方法最後一次回的是不是 `{ error }`。 */
  readonly failed: Map<string, boolean>;
  /** 這一次有沒有被 fence 擋下。 */
  sandboxDenied: boolean;
  /** 這一次工具呼叫的取消訊號（使用者停止、工具逾時），langchain 放在 `request.runtime.signal`；沒有就是 `undefined`。 */
  readonly signal: AbortSignal | undefined;
  /** backend 的搜尋失敗了，是哪一種（{@link noteSearchError}）。 */
  searchError: SearchErrorCode | undefined;
  /** backend 的讀寫改失敗了，是哪一種（{@link noteFsError}）。 */
  fsError: FsErrorCode | undefined;
  /** 搜尋成功、但這次呼叫累計有幾條路徑讀不到而被略過（{@link noteSearchSkipped}）。 */
  searchSkipped: number;
}

/**
 * 正在跑的那一次工具呼叫。**模組層一份**：fence 住在 `apps/harness`，它回報拒絕時要找得到
 * 同一個；每次呼叫各 `run` 一份記錄，兩次呼叫（含平行的）不會共用。
 */
const currentCall = new AsyncLocalStorage<CallRecord>();

/** backend 方法回的是不是 `BackendProtocolV2` 的錯誤結果。 */
function isBackendError(result: unknown): boolean {
  if (typeof result !== 'object' || result === null) return false;
  const error = (result as { readonly error?: unknown }).error;
  return typeof error === 'string' && error.length > 0;
}

function note(method: string, result: unknown): void {
  currentCall.getStore()?.failed.set(method, isBackendError(result));
}

/**
 * fence 擋下了這一次呼叫。**只有 fence 該叫它**：碼是 `FS_SANDBOX_DENIED`，它斷言的是「政策擋的」，
 * 不是「失敗了」。不在任何一次工具呼叫裡（直接呼叫 backend 的測試、摘要器的 offload）時什麼都不做。
 */
export function noteSandboxDenial(): void {
  const record = currentCall.getStore();
  if (record !== undefined) record.sandboxDenied = true;
}

/**
 * 搜尋失敗了：backend 在回 `{ error }` 之前叫它，記下是哪一個碼（{@link SearchErrorCode}）。不在任何一次工具呼叫裡時什麼都不做。
 *
 * @param code - 四個碼之一。
 */
export function noteSearchError(code: SearchErrorCode): void {
  const record = currentCall.getStore();
  if (record !== undefined) record.searchError = code;
}

/**
 * 搜尋成功了，但有路徑讀不到、被略過（[#1704](https://github.com/DemianLi/nexus-agent/issues/1704)）：backend 在回結果之前
 * 叫它，監聽者在 `grep`／`glob` 成功的結果後面接上一句「N 條路徑讀不到、已略過」。基座的 `GrepResult`／`GlobResult`
 * 沒有地方放這種話（`truncated` 會讓基座接上「hit the maximum match count」，說的是別的事），所以走跟 {@link noteSearchError}
 * 同一條載體。
 *
 * **記的是數字，句子在監聽者組**：基座的 `CompositeBackend.grep('/')` 一次工具呼叫會依序搜預設 backend 與每一條 route，
 * 每一個都可能略過一些；數字累加，各自記一句的話後面的會蓋掉前面的、N 少算。也讓 core 不必帶任意文字。
 * 不在任何一次工具呼叫裡、或 `count` 不是正整數時什麼都不做。
 *
 * @param count - 這一次 backend 呼叫略過幾條路徑。
 */
export function noteSearchSkipped(count: number): void {
  const record = currentCall.getStore();
  if (record !== undefined && Number.isInteger(count) && count > 0) record.searchSkipped += count;
}

/**
 * 檔案工具失敗了：backend 在回 `{ error }` 之前叫它，記下是哪一個碼（{@link FsErrorCode}）。錯誤文字不變，碼只進 `tool/result`。
 * 不在任何一次工具呼叫裡時什麼都不做。**fence 的拒絕不走這裡**，叫 {@link noteSandboxDenial}；兩者同時出現時 fence 的碼優先。
 *
 * @param code - {@link FsErrorCode} 之一。
 */
export function noteFsError(code: FsErrorCode): void {
  const record = currentCall.getStore();
  if (record !== undefined) record.fsError = code;
}

/**
 * 正在跑的這一次工具呼叫的取消訊號（[#1532](https://github.com/DemianLi/nexus-agent/issues/1532)）。
 * langchain 的 `ToolNode.runTool` 把 `lgConfig.signal` 放進 `request.runtime.signal`，監聽者開記錄時從 `site.signal` 帶上。
 * 使用者按停止、工具逾時都經這個訊號；backend 自己起子行程時據此收掉它。
 *
 * @returns 不在工具呼叫裡、或這一次沒有訊號時是 `undefined`。
 */
export function currentToolCallSignal(): AbortSignal | undefined {
  return currentCall.getStore()?.signal;
}

/**
 * 把 backend 包一層，記下每次呼叫裡那幾個方法回的是不是錯誤。
 *
 * **轉交的是同一個實例**：方法以原物件為 `this` 呼叫，非方法的屬性原樣讀出，所以
 * `CompositeBackend.isInstance`（看 `routePrefixes`）與 `instanceof` 照樣成立。
 *
 * @param backend - fold 折出來的那個。
 * @returns 交給基座的那一份。
 */
export function recordBackendOutcomes<T extends object>(backend: T): T {
  return new Proxy(backend, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => unknown;
      if (typeof property !== 'string' || !TRACKED_METHODS.has(property)) {
        return method.bind(target);
      }
      return (...args: unknown[]): unknown => {
        const out = method.apply(target, args);
        if (out instanceof Promise) {
          return out.then((resolved: unknown) => {
            note(property, resolved);
            return resolved;
          });
        }
        note(property, out);
        return out;
      };
    },
  });
}

/**
 * 不是基座檔案工具的那一次：工具自己回了錯誤，而這次呼叫裡 fence 喊過拒絕，就替它補上
 * `FS_SANDBOX_DENIED`（[#316](https://github.com/DemianLi/nexus-agent/issues/316)）。
 *
 * **只補碼**，文字與狀態是工具自己的。照 dsh：註冊表從拋出來的 `HarnessError` 通用地取碼
 * （`packages/core/tools/src/index.ts:635-641`，SHA `c291e79`），不看是哪顆工具。成功的、已經有碼的、
 * 包在 `Command` 裡的都原樣交出。
 */
function withSandboxCode(result: PipelineResult, record: CallRecord): PipelineExecuteResult {
  if (!record.sandboxDenied || result.kind !== 'message') return result;
  if (!result.isError || result.error !== undefined) return result;
  return { ...result, isError: true, error: { name: 'FsError', code: FS_SANDBOX_DENIED } };
}

/** 略過的路徑數 → 接在結果後面的那一句。只講數量，路徑是主機上別人的檔名。 */
function skippedNotice(count: number): string {
  const noun = count === 1 ? 'path was' : 'paths were';
  return `${String(count)} ${noun} unreadable (permission denied) and skipped; results cover only the readable files`;
}

/**
 * 搜尋成功而 backend 記了略過幾條路徑（{@link noteSearchSkipped}）：把那句接在基座排好的結果後面，字串仍是字串、
 * 文字塊陣列併成一塊。只管 `grep`／`glob`；錯誤的結果、含文字區塊以外的內容原樣交出，不猜。
 */
function withSkippedNotice(
  result: PipelineResult,
  toolName: string,
  record: CallRecord,
): PipelineExecuteResult {
  if (record.searchSkipped === 0 || (toolName !== 'grep' && toolName !== 'glob')) return result;
  if (result.kind !== 'message' || result.isError) return result;
  const suffix = `\n\n(${skippedNotice(record.searchSkipped)})`;
  if (!result.blocks.every((block) => block.type === 'text')) return result;
  return { ...result, content: `${result.content}${suffix}` };
}

/**
 * 把檔案工具的失敗標成錯誤：`tools/execute` 的 core 內層監聽者，貼著工具本體。開一份記錄包住本體，照記錄換結果的狀態與碼。
 * **無狀態**：記錄每次呼叫各一份，root 與每個 subagent 共用同一位。
 */
export const fsToolErrorsListener: CoreToolListener<'tools/execute'> = async (
  _exec,
  next,
  site,
) => {
  // **每一顆工具呼叫都開一份記錄**，不只基座的檔案工具：fence 擋下的若是別的工具
  // （`submit_record`，#316），它的回報也要有地方落。
  const record: CallRecord = {
    failed: new Map(),
    sandboxDenied: false,
    signal: site.signal,
    searchError: undefined,
    fsError: undefined,
    searchSkipped: 0,
  };
  const result = await currentCall.run(record, () => next());
  const toolName = toolNameOfCall(site);
  const method = FS_TOOL_PRIMARY_METHOD[toolName];
  if (method === undefined) return withSandboxCode(result, record);
  if (record.failed.get(method) !== true || result.kind !== 'message') {
    return withSkippedNotice(result, toolName, record);
  }
  const error = record.sandboxDenied
    ? { name: 'FsError', code: FS_SANDBOX_DENIED }
    : record.searchError !== undefined
      ? { name: 'SearchError', code: record.searchError }
      : record.fsError === undefined
        ? undefined
        : { name: 'FsError', code: record.fsError };
  // 已經是錯誤（`delete` 走基座的 `toolError`）而沒有碼要補：原樣交出去，別人的訊息不動。
  if (result.isError && error === undefined) return result;
  // **前綴只補基座沒寫的**（#318）：`write_file`／`edit_file`／`grep` 回的是 backend 的裸錯誤，
  // `read_file` 的 `Error: …` 與 `ls`／`glob` 的 `Error listing/finding files: …` 本來就讀得出是錯。
  // 這是全樹唯一看文字決定前綴的地方：文字是基座寫的，我們不是它的主人。
  const marked = { ...result, isError: true, ...(error !== undefined && { error }) };
  return result.content.startsWith(BASE_ERROR_WORD)
    ? marked
    : { ...marked, content: `${TOOL_ERROR_PREFIX}${result.content}` };
};
