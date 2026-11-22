/**
 * 路徑的分類與顯示形式。照 dsh `workspace-changes/src/paths.ts`（`ddefc45`）逐條移植，export 跟它一對一。
 * 我們的檔案工具收的是以工作區為根的虛擬路徑，先對到磁碟上的那一步不在這裡：它是 `@nexus/core` 的
 * `hostPathOf`，跟 present、交付讀檔路由共用同一份（[#693](https://github.com/DemianLi/nexus-agent/issues/693)）。
 *
 * @module
 */

import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

/**
 * 原生相對路徑的斜線形式。
 * @param path - 原生路徑。
 * @returns 分隔符換成 `/` 的同一條路徑。
 */
export function toPosix(path: string): string {
  return path.split(sep).join('/');
}

/**
 * `path` 是 `root` 本身或在它底下。
 * @param root - 絕對目錄。
 * @param path - 要判的絕對路徑。
 * @returns 根本身與每一個子孫都是 true。
 */
export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * 暫存目錄的標準寫法：`/tmp` 與平台的暫存區，各自連同解開符號連結的那個寫法，所以 `/tmp` 與
 * `/private/tmp` 都認得。
 * @param candidates - 要標準化的目錄。
 * @returns 絕對目錄路徑。
 */
export async function temporaryRoots(
  candidates: readonly string[] = ['/tmp', tmpdir()],
): Promise<string[]> {
  const roots = new Set<string>();
  for (const root of candidates) {
    roots.add(root);
    roots.add(await canonicalPath(root));
  }
  return [...roots];
}

/**
 * 解開符號連結的路徑。還不存在的路徑經由它最近那個存在的祖先解開，所以一個經由目錄符號連結建出來的
 * 檔，建出來之前與之後的標準寫法一樣。
 * @param path - 絕對路徑。
 * @returns 標準寫法。
 */
export async function canonicalPath(path: string): Promise<string> {
  const missing: string[] = [];
  let head = path;
  for (;;) {
    try {
      return join(await realpath(head), ...missing);
    } catch {
      // 缺席或讀不到的那一段照字面接在最近那個解得開的祖先底下；除了根以外一個祖先都不存在時，整條照原樣。
      const parent = dirname(head);
      if (parent === head || dirname(parent) === parent) return path;
      missing.unshift(basename(head));
      head = parent;
    }
  }
}

/**
 * 檔案是不是在暫存目錄底下——模型放草稿的地方。
 * @param path - 絕對檔案路徑。
 * @param roots - {@link temporaryRoots}。
 * @returns 草稿路徑是 true，它們永遠不進摘要。
 */
export function isTemporaryPath(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => isInside(root, path));
}

/**
 * 一個改過的檔的排序鍵與標籤，見 `WorkspaceChangedFile.display`。
 * @param absolute - 標準化的絕對路徑。
 * @param cwd - 標準化的工作區根。
 * @param root - repo 的頂層目錄；沒有快照時就是工作區根。repo 裡、工作區之上的檔是 `../` 形式。
 * @param home - 標準化的家目錄，空字串表示不用 `~` 形式。
 * @returns 斜線分隔的顯示路徑。
 */
export function displayPathOf(absolute: string, cwd: string, root: string, home: string): string {
  if (isInside(cwd, absolute) || isInside(root, absolute)) return toPosix(relative(cwd, absolute));
  if (home !== '' && isInside(home, absolute)) return `~/${toPosix(relative(home, absolute))}`;
  return toPosix(absolute);
}

/**
 * 耐久的 `path` 欄：工作區內是相對路徑，其餘是絕對路徑。
 * @param absolute - 標準化的絕對路徑。
 * @param cwd - 標準化的工作區根。
 * @returns 路徑。
 */
export function durablePathOf(absolute: string, cwd: string): string {
  return isInside(cwd, absolute) ? toPosix(relative(cwd, absolute)) : absolute;
}

/**
 * 顯示路徑的碼元順序，`../` 與絕對路徑排在字母前面。
 * @param a - 第一個檔。
 * @param b - 第二個檔。
 * @returns 給 `Array.prototype.sort` 的負數、零或正數。
 */
export function compareDisplay(a: { display: string }, b: { display: string }): number {
  return a.display < b.display ? -1 : a.display > b.display ? 1 : 0;
}
