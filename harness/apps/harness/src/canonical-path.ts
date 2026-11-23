/**
 * 路徑的實際位置與「在不在底下」：檔案圍堵（`contained-backend.ts`）與啟動時的工作區重疊檢查
 * （`assembly-root.ts` 的 `assertLaunchPathsOutsideWorkspace`，[#1620](https://github.com/DemianLi/nexus-agent/issues/1620)）共用一份。
 *
 * `realpath` 用 `node:fs/promises` 那支：它是 native 的 `realpath(3)`，在不分大小寫的檔案系統上會把大小寫正規化成實際的寫法；
 * JS 版的 `realpathSync` 不會（macOS、Node v25.9.0 實測，見 #1620）。
 *
 * @module
 */

import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { realpath } from 'node:fs/promises';

const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR']);

/**
 * 把一個絕對路徑解到它的實際位置——**最深的那個存在的祖先** realpath 之後，再把還不存在的
 * 尾巴接回去。
 *
 * 要這一步是因為寫檔的目標通常還不存在，直接 `realpath()` 會 ENOENT。祖先的 symlink 就是
 * 在這裡被解開的，而那是 fence 唯一有趣的失敗法：只比對 `..` 是在測字串處理。
 *
 * @param target - 已經 `resolve()` 過的絕對路徑。
 * @returns 解析後的絕對路徑；連根都不存在時原樣回傳。
 * @throws ENOENT／ENOTDIR 以外的錯（ELOOP、EACCES…）原樣往外拋。
 */
export async function canonicalize(target: string): Promise<string> {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    try {
      const real = await realpath(current);
      return missing.length === 0 ? real : join(real, ...missing.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === undefined || !MISSING_CODES.has(code)) throw error;
      const parent = dirname(current);
      if (parent === current) return target;
      missing.push(basename(current));
      current = parent;
    }
  }
}

/**
 * 一個**要存在才算**的檔的實際位置；不存在（ENOENT／ENOTDIR，懸空的 symlink 也是）回 `undefined`。
 * 只做 `realpath`，不開檔、不讀內容。
 *
 * @param target - 已經 `resolve()` 過的絕對路徑。
 * @returns 實際位置，或不存在時的 `undefined`。
 * @throws 其餘的錯（ELOOP、EACCES…）原樣往外拋，同 {@link canonicalize}。
 */
export async function canonicalizeExisting(target: string): Promise<string | undefined> {
  try {
    return await realpath(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== undefined && MISSING_CODES.has(code)) return undefined;
    throw error;
  }
}

/**
 * `path` 是 `root` 本身或在它底下。兩邊都要是絕對路徑；要比實際位置就先各自 {@link canonicalize}。
 *
 * **感知分隔符**：`${root}${sep}` 前綴的寫法在根是 `/` 時會變成 `//`，什麼都比不中。用 `relative` 也要小心：
 * `/a` 對 `/a/..nexus` 的 `relative` 是 `..nexus`，只看 `startsWith('..')` 會把它判成外面。所以只有 `..` 本身、
 * `..` 加分隔符開頭、或跨磁碟機的絕對路徑才算外面。照 dsh `fs-local` 的 `contains`（`packages/fs/fs-local/src/index.ts:152-155`，
 * `687f282e`），同一個判斷式。`packages/nexus-plugin-workspace-changes/src/paths.ts` 的 `isInside` 照的是 dsh workspace-changes 自己那一支
 * （`packages/deliverables/workspace-changes/src/paths.ts:21-24`），有上面那個 `..nexus` 的窄，那邊照 dsh 不改。
 *
 * @param root - 絕對目錄。
 * @param path - 要判的絕對路徑。
 * @returns 根本身與每一個子孫都是 `true`。
 */
export function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}
