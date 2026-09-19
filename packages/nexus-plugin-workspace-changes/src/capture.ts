/**
 * 檔案工具改檔前後的整檔副本：這一輪第一次改一個路徑之前的內容，與這一輪結束時的內容，以內容定址存在
 * 會話的暫存目錄底下，所以比較的兩側都撐得過之後的修改。照 dsh `workspace-changes/src/capture.ts`
 * （`ddefc45`）逐條移植；工具名與參數換成我們基座的那三個（見 {@link mutationPath}）。
 *
 * @module
 */

import { createHash } from 'node:crypto';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 判二進位時看前面多少位元組有沒有 NUL，同 git。 */
const BINARY_PROBE_BYTES = 8000;

/** 一個路徑的一側。 */
export type Capture =
  /** 那個路徑上沒有檔案。 */
  | { readonly kind: 'absent' }
  /** 比上限大的一般檔案；內容不存。 */
  | { readonly kind: 'oversized' }
  /** 存下來的副本，以內容的 SHA-1 命名。 */
  | { readonly kind: 'file'; readonly file: string; readonly binary: boolean };

/** 檔案系統錯誤是不是「不存在」。 */
function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * 存下一個路徑現在的內容。最多讀 `maxBytes + 1` 個位元組，所以讀的時候長大超過上限的檔，花的記憶體
 * 也不超過上限。
 * @param absolute - 標準化的絕對路徑。
 * @param directory - 放內容定址副本的目錄；不存在就建。
 * @param maxBytes - 一份副本的位元組上限（含）。
 * @returns 副本；既不是缺席也不是一般檔案的路徑回 `undefined`。
 * @throws 打不開或讀不了（不是因為不存在），或副本寫不進去。
 */
export async function captureFile(
  absolute: string,
  directory: string,
  maxBytes: number,
): Promise<Capture | undefined> {
  let handle;
  try {
    handle = await open(absolute, 'r');
  } catch (error: unknown) {
    if (!isMissing(error)) throw error;
    return { kind: 'absent' };
  }
  let bytes: Buffer;
  try {
    if (!(await handle.stat()).isFile()) return undefined;
    const probe = Buffer.allocUnsafe(maxBytes + 1);
    let length = 0;
    while (length < probe.length) {
      const { bytesRead } = await handle.read(probe, length, probe.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) return { kind: 'oversized' };
    bytes = probe.subarray(0, length);
  } finally {
    await handle.close();
  }
  const file = join(directory, createHash('sha1').update(bytes).digest('hex'));
  await mkdir(directory, { recursive: true });
  // 同樣的內容跨路徑、跨輪共用一份；`wx` 讓已經在的那份原樣留著。
  await writeFile(file, bytes, { flag: 'wx' }).catch((error: unknown) => {
    if ((error as { code?: unknown }).code !== 'EEXIST') throw error;
  });
  return {
    kind: 'file',
    file,
    binary: bytes.subarray(0, BINARY_PROBE_BYTES).includes(0),
  };
}

/**
 * 兩側是不是確定一樣。兩側都缺席算一樣；兩份副本雜湊相同算一樣；過大的那一側永遠不算確定一樣——
 * 沒讀過的內容不能認定沒改。
 * @param a - 一側。
 * @param b - 另一側。
 * @returns 只有確定一樣時是 true。
 */
export function sameCapture(a: Capture, b: Capture): boolean {
  if (a.kind === 'absent' || b.kind === 'absent') return a.kind === b.kind;
  return a.kind === 'file' && b.kind === 'file' && a.file === b.file;
}

/** 非空白字串，否則 `undefined`。 */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * 一次檔案工具呼叫要改的那個路徑。
 *
 * dsh 認的是它自己的 `write`、`edit` 與會改檔的 `str_replace_editor`；我們的檔案工具是基座的
 * `write_file`、`edit_file` 與 `delete`（`deepagents@1.13.1`，`--workspace` 底下沒有 `execute`，見
 * [#443](https://github.com/DemianLi/nexus-agent/issues/443) 第二則決議）。參數的必填欄照各自的 schema：
 * 缺了的呼叫不會跑到本體，也就不擷取。基座在 schema 前把 `path` 正規化成 `file_path`
 * （`normalizeFilePathInput`），這裡讀的是正規化之前的原始參數，所以兩個名字都認。
 *
 * @param name - 工具名。
 * @param args - 解析過的呼叫參數。
 * @returns 模型給的路徑，或 `undefined`。
 */
export function mutationPath(name: string, args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  const path = text(record.file_path) ?? ('file_path' in record ? undefined : text(record.path));
  switch (name) {
    case 'write_file':
      return typeof record.content === 'string' ? path : undefined;
    case 'edit_file':
      return typeof record.old_string === 'string' && typeof record.new_string === 'string'
        ? path
        : undefined;
    case 'delete':
      return path;
    default:
      return undefined;
  }
}
