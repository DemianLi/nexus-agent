/**
 * 檔案工具的組態（[#1605](https://github.com/DemianLi/nexus-agent/issues/1605) N0355）：哪幾顆基座工具模型看得到、讀檔的上限。
 * 欄位與意義照 dsh `tool-fs` 的 Config（`packages/fs/tool-fs/src/index.ts:20-98`，`687f282e`）；設定列住在
 * `apps/harness/src/settings/tool-fs.ts`，組裝點把驗過的值交給 `foldRegistry`（{@link FoldOptions.fileTools}），這裡是 core 側的形狀與換算。
 *
 * ## 開關換算成基座的 `tools` 白名單
 *
 * dsh 的 `write: false` 是「不註冊那顆工具」。基座的 `createFilesystemMiddleware` 收 `tools` 白名單（`dist/langsmith-zm0ILQsV.js:2323-2328`、
 * `:2363-2414`），名單外的不建，所以模型根本看不到：比 `wrapModelCall` 過濾更接近 dsh 的「不註冊」。
 * 白名單是 {@link FILESYSTEM_TOOL_NAMES} 扣掉被關的，**一定含 `read_file`**（基座在組裝時要求，沒有就拋；這就是 `tool-fs` 不開
 * `read` 這一格的原因，見設定列檔頭）。
 *
 * - `write: false` 扣掉 `write_file` 與 **`delete`**。**偏離 dsh（理由 1：基座表達不出來）**：dsh 沒有 `delete` 這顆工具，基座多一顆會改檔的工具，
 *   dsh 沒有可以對照的開關，歸到寫入面最接近。
 * - `edit: false` 扣掉 `edit_file`。
 * - `execute` 留在白名單裡：它本來就只在 backend 支援執行時才出現（基座執行期過濾），不歸這兩個開關管。
 *
 * **全部開著時不傳 `tools`**（{@link filesystemToolWhitelist} 回 `undefined`）：自有組裝與 `createDeepAgent` 逐位元組相同的比對
 * （`assembly-parity.test.ts`）不受影響，也不會因為基座將來新增一顆工具而被我們的名單悄悄擋掉。
 *
 * 關掉的工具，「先讀後改」那句系統提示也跟著不出現：`observationGuidance` 看的是這一輪送給模型的工具清單
 * （`observation.ts`），工具不在清單裡，那一句就不寫。
 *
 * @module
 */

import type { FsToolName } from 'deepagents';

import type { ReadLimits } from './read-continuation.js';

/**
 * 基座 `FILESYSTEM_TOOL_NAMES`（`deepagents@1.13.1`，`dist/langsmith-zm0ILQsV.js:1538-1547`）。值沒有從 `deepagents` 匯出，這裡抄一份，
 * `fs-tools-options.test.ts` 對著基座實際建出來的工具核對。
 */
export const FILESYSTEM_TOOL_NAMES = [
  'ls',
  'read_file',
  'write_file',
  'edit_file',
  'delete',
  'glob',
  'grep',
  'execute',
] as const satisfies readonly FsToolName[];

/** 驗過的 `tool-fs` 設定。 */
export interface FileToolsOptions extends Required<ReadLimits> {
  /** `false`：模型看不到 `write_file` 與 `delete`。 */
  readonly write: boolean;
  /** `false`：模型看不到 `edit_file`。 */
  readonly edit: boolean;
}

/**
 * 要交給 `createFilesystemMiddleware({ tools })` 的白名單。
 *
 * @param options - `tool-fs` 的設定；缺席當成全開。
 * @returns 名單；沒有東西被關時是 `undefined`（不傳 `tools`）。
 */
export function filesystemToolWhitelist(
  options: Pick<FileToolsOptions, 'write' | 'edit'> | undefined,
): FsToolName[] | undefined {
  if (options === undefined || (options.write && options.edit)) return undefined;
  const closed = new Set<string>();
  if (!options.write) {
    closed.add('write_file');
    closed.add('delete');
  }
  if (!options.edit) closed.add('edit_file');
  return FILESYSTEM_TOOL_NAMES.filter((name) => !closed.has(name));
}
