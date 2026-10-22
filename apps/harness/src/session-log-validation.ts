/**
 * 會話日誌的形狀驗證，照 dsh `session-format-v3-to-v4/src/validation.ts`（`687f282e`）。
 *
 * 獨立成一個模組、不逐行插進讀檔的迴圈裡（[#1549](https://github.com/DemianLi/nexus-agent/issues/1549) 做法 1）：
 * 建立（[#1559](https://github.com/DemianLi/nexus-agent/issues/1559) N0622）與讀盤（#1549）共用同一支 header 驗證，
 * 兩邊才不會各說各話。今天只有 header 這一支；事件信封與事件之間的關係由 #1549 加在這裡。
 *
 * 拋的是 `TypeError`，訊息說哪一格：建立那一側原樣交給呼叫方（同 dsh `materializeCreateHeader` 拋 `TypeError`），
 * 讀盤那一側由讀方換成它自己的錯誤。
 */

import { isAbsolute } from 'node:path';

/**
 * 這一版寫得出來的 header 鍵（`@nexus/core` 的 `StoredSessionHeader`），照 dsh 的精確鍵白名單
 * （`validation.ts:19-42` 的 `required` 與 `allowed`）。
 */
const REQUIRED_HEADER_KEYS = ['version', 'id', 'createdAt'] as const;
const ALLOWED_HEADER_KEYS: ReadonlySet<string> = new Set([
  ...REQUIRED_HEADER_KEYS,
  'cwd',
  'workspaceRoot',
  'parentSession',
  'build',
  'plugins',
  'configHash',
  'modelEntryId',
]);
/** 有的話要是字串的那幾格。 */
const OPTIONAL_STRING_KEYS = [
  'workspaceRoot',
  'parentSession',
  'configHash',
  'modelEntryId',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 非負的安全整數，同 dsh 的 `sessionFormatCount`。 */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * header 各格的形狀，照 dsh 的 `assertReleasedV4Header`（`validation.ts:19-42`）：缺必填的、多出這一版不寫的鍵、
 * 某一格型別不對，都拒。**版本是哪一版不在這裡判**：建立時要等於這一版（同 dsh 的 `encodeCurrentHeader`），讀盤時
 * 由版本邊目錄判，兩邊規則不同。
 *
 * nexus 的 header 沒有 dsh 的 `isSeeded`、`delegationDepth`、`origin`、`agentPreset`（繼承前綴歸
 * [#1579](https://github.com/DemianLi/nexus-agent/issues/1579)），多了 `workspaceRoot`、`build`、`plugins`、`configHash`、
 * `modelEntryId`，各照 `StoredSessionHeader` 的宣告驗。
 *
 * @param header - 還沒驗過的 header。
 * @throws `TypeError` 哪一格不對。
 */
export function assertStoredHeaderFields(header: unknown): void {
  if (!isRecord(header)) throw new TypeError('session header 不是一個物件');
  const missing = REQUIRED_HEADER_KEYS.find((key) => !Object.hasOwn(header, key));
  if (missing !== undefined) throw new TypeError(`session header 少了 ${missing}`);
  const unexpected = Object.keys(header).find((key) => !ALLOWED_HEADER_KEYS.has(key));
  if (unexpected !== undefined) {
    throw new TypeError(`session header 有這一版不寫的鍵 ${JSON.stringify(unexpected)}`);
  }
  if (typeof header['id'] !== 'string') throw new TypeError('session header 的 id 要是字串');
  if (!isCount(header['createdAt'])) {
    throw new TypeError('session header 的 createdAt 要是非負的安全整數');
  }
  const { cwd } = header;
  if (cwd !== undefined && (typeof cwd !== 'string' || !isAbsolute(cwd))) {
    throw new TypeError('session header 的 cwd 要是絕對路徑');
  }
  for (const key of OPTIONAL_STRING_KEYS) {
    if (header[key] !== undefined && typeof header[key] !== 'string') {
      throw new TypeError(`session header 的 ${key} 要是字串`);
    }
  }
  const { build } = header;
  if (build !== undefined) {
    if (
      !isRecord(build) ||
      Object.keys(build).some((key) => key !== 'commit' && key !== 'dirty') ||
      !(build['commit'] === null || typeof build['commit'] === 'string') ||
      !(build['dirty'] === null || typeof build['dirty'] === 'boolean')
    ) {
      throw new TypeError(
        'session header 的 build 要是 {commit: string|null, dirty: boolean|null}',
      );
    }
  }
  const { plugins } = header;
  if (plugins !== undefined) {
    if (!Array.isArray(plugins)) throw new TypeError('session header 的 plugins 要是陣列');
    plugins.forEach((row: unknown, index) => {
      if (
        !isRecord(row) ||
        Object.keys(row).some((key) => key !== 'name' && key !== 'id' && key !== 'disabled') ||
        typeof row['name'] !== 'string' ||
        (row['id'] !== undefined && typeof row['id'] !== 'string') ||
        typeof row['disabled'] !== 'boolean'
      ) {
        throw new TypeError(
          `session header 的 plugins[${index}] 要是 {name: string, id?: string, disabled: boolean}`,
        );
      }
    });
  }
}
