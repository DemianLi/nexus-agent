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
 * 錯誤都是錯誤，只有 fence 拒絕帶碼——其餘要分出 `FS_NOT_FOUND` 之類得解析基座的措辭。**文字一字
 * 不變**（[#271](https://github.com/DemianLi/nexus-agent/issues/271)）。
 *
 * **偏離：在工具外面改狀態，不是在工具裡拋。** 基座的檔案工具我們改不了，所以退到最接近的——
 * 一顆貼著工具本體的 `wrapToolCall`，結果離開之前換狀態。時刻是 dsh 的 `tools/execute`：拋在工具
 * 本體裡、註冊表接住的那一刻（攔截索引的第 6 格，`apps/harness/src/interception-index.test.ts`）。
 * 判準是結構訊號而不是字面：
 *
 * - {@link recordBackendOutcomes} 包住交給基座的 backend，記下**這一次呼叫**裡每個方法最後一次
 *   回的是不是 `{ error }`；
 * - middleware 只看那顆工具**主要的那個方法**（{@link FS_TOOL_PRIMARY_METHOD}）。基座的工具在主要
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
 *
 * @module
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { ToolMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from './base-types.js';
import { resolveToolName } from './containment.js';
import { markToolError } from './tool-events.js';

/** 這個 middleware 的名字。排序斷言用得到。 */
export const FS_TOOL_ERRORS_MIDDLEWARE_NAME = 'nexusFsToolErrors';

/** fence 擋下一次變更的碼。dsh `FsErrorCode` 的同名成員。 */
export const FS_SANDBOX_DENIED = 'FS_SANDBOX_DENIED';

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

/** 一次檔案工具呼叫裡記下的東西。 */
interface CallRecord {
  /** 每個方法最後一次回的是不是 `{ error }`。 */
  readonly failed: Map<string, boolean>;
  /** 這一次有沒有被 fence 擋下。 */
  sandboxDenied: boolean;
}

/**
 * 正在跑的那一次檔案工具呼叫。**模組層一份**：fence 住在 `apps/harness`，它回報拒絕時要找得到
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
 * 不是「失敗了」。不在任何一次檔案工具呼叫裡（直接呼叫 backend 的測試、摘要器的 offload）時什麼都不做。
 */
export function noteSandboxDenial(): void {
  const record = currentCall.getStore();
  if (record !== undefined) record.sandboxDenied = true;
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
 * 造一顆把檔案工具的失敗標成錯誤的 middleware。**無狀態**：記錄每次呼叫各一份，root 與每個
 * subagent 共用同一顆。
 *
 * @returns 交給 fold 排位置的 middleware。
 */
export function createFsToolErrorsMiddleware(): AgentMiddleware {
  return createMiddleware({
    name: FS_TOOL_ERRORS_MIDDLEWARE_NAME,
    wrapToolCall: async (request, handler) => {
      const method = FS_TOOL_PRIMARY_METHOD[resolveToolName(request)];
      if (method === undefined) return handler(request);
      const record: CallRecord = { failed: new Map(), sandboxDenied: false };
      const result = await currentCall.run(record, () => handler(request));
      if (record.failed.get(method) !== true || !ToolMessage.isInstance(result)) return result;
      const error = record.sandboxDenied ? { name: 'FsError', code: FS_SANDBOX_DENIED } : undefined;
      // 已經是錯誤（`delete` 走基座的 `toolError`）而沒有碼要補：原樣交出去，別人的訊息不動。
      if (result.status === 'error' && error === undefined) return result;
      const failure = new ToolMessage({
        content: result.content,
        tool_call_id: result.tool_call_id,
        ...(result.name !== undefined && { name: result.name }),
        status: 'error',
      });
      return error === undefined ? failure : markToolError(failure, error);
    },
  }) as AgentMiddleware;
}
