/**
 * `permissions` 的 deny 規則，拿來比**解開符號連結之後**的位置（[#2260](https://github.com/DemianLi/nexus-agent/issues/2260)）。
 *
 * 基座的檔案工具比的是模型給的路徑（`deepagents@1.13.1` 的 `checkPermission`，`dist/langsmith-zm0ILQsV.js:1742`），
 * 根內一條連結指到被擋的路徑時，經連結就讀寫得到。`ContainedFilesystemBackend` 解開連結之後用這裡的函式再判一次。
 *
 * 比對規則對應基座沒有匯出的那幾支（同檔 `:1031-1078`、`:1767-1879`），只差在路徑不合格時回 `undefined`，不拋錯：
 *
 * - {@link decidePathAccess}：照宣告順序，先命中的那條決定，沒有一條命中就放行；
 * - glob 用基座自己依賴的那一份 `micromatch`，`dot: true`；
 * - {@link deleteDenyPatterns}：刪除可能是整棵子樹時不看 allow，任何一條 deny 可能命中目標或它底下的東西就擋。
 *
 * 跟基座的實際行為是否一致，由 `path-permissions.test.ts` 拿同一張路徑表對基座真的工具層比對。
 *
 * @module
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import type { FilesystemPermission } from 'deepagents';

/** `micromatch` 用到的那一支。 */
interface Micromatch {
  isMatch(path: string, pattern: string, options: { readonly dot: boolean }): boolean;
}

/** 從 `deepagents` 那裡解出來的，就是基座比對時用的同一份。 */
const micromatch = createRequire(fileURLToPath(import.meta.resolve('deepagents')))(
  'micromatch',
) as Micromatch;

/** 規則比的兩種操作。 */
export type PermissionOperation = 'read' | 'write';

/** `permissions` 規則表，形狀同基座的 `FilesystemPermission[]`。 */
export type PermissionRules = readonly FilesystemPermission[];

const GLOB_WILDCARD_CHARACTERS = ['*', '?', '{', '['];

/**
 * 基座的 `validatePath`：要是絕對路徑、不含 `..` 與 `~` 段，合併重複的斜線。不合格回 `undefined`。
 *
 * @param raw - 路徑。
 * @returns 正規化後的路徑，或 `undefined`。
 */
function validPath(raw: string): string | undefined {
  if (raw.length === 0 || !raw.startsWith('/')) return undefined;
  const segments = raw.split('/').filter((segment) => segment.length > 0);
  if (segments.includes('..') || segments.includes('~')) return undefined;
  return `/${segments.join('/')}`;
}

function globMatch(path: string, pattern: string): boolean {
  return micromatch.isMatch(path, pattern, { dot: true });
}

/**
 * 基座的 `decidePathAccess`。
 *
 * @param rules - 規則表。
 * @param operation - 操作。
 * @param path - 已正規化的路徑。
 * @returns `allow` 或 `deny`。
 */
export function decidePathAccess(
  rules: PermissionRules,
  operation: PermissionOperation,
  path: string,
): 'allow' | 'deny' {
  for (const rule of rules) {
    if (!rule.operations.includes(operation)) continue;
    if (rule.paths.some((pattern) => globMatch(path, pattern))) return rule.mode ?? 'allow';
  }
  return 'allow';
}

/**
 * 讀或寫 `path` 被規則擋下時的拒絕句，文字同基座 `checkPermission` 去掉 `Error: ` 開頭（基座的檔案工具把 backend 的錯誤交給模型時會加）。
 * 路徑不合格時不判，交給後面的檢查。
 *
 * @param rules - 規則表。
 * @param operation - 操作。
 * @param path - 解開連結之後的虛擬路徑。
 * @returns 拒絕句，或沒被擋時的 `undefined`。
 */
export function permissionDenial(
  rules: PermissionRules,
  operation: PermissionOperation,
  path: string,
): string | undefined {
  if (rules.length === 0) return undefined;
  const canonical = validPath(path);
  if (canonical === undefined) return undefined;
  return decidePathAccess(rules, operation, canonical) === 'deny'
    ? `permission denied for ${operation} on ${canonical}`
    : undefined;
}

function posixParts(path: string): string[] {
  return path.split('/').filter(Boolean);
}

function isRelativeTo(child: string, ancestor: string): boolean {
  if (ancestor === '/') return true;
  return child === ancestor || child.startsWith(`${ancestor}/`);
}

function globAnchor(pattern: string): string {
  const safe: string[] = [];
  for (const part of posixParts(pattern)) {
    if (GLOB_WILDCARD_CHARACTERS.some((character) => part.includes(character))) break;
    safe.push(part);
  }
  return safe.length === 0 ? '/' : `/${safe.join('/')}`;
}

function pathsOverlap(callPath: string, ruleAnchor: string): boolean {
  // 基座在這裡對兩邊各跑一次 `validatePath`，不合格就拋；規則路徑在基座建檔案 middleware 時已經驗過（`validatePermissionPaths`，不合格就拋），目標是呼叫端驗過的。
  const a = validPath(callPath) ?? callPath;
  const b = validPath(ruleAnchor) ?? ruleAnchor;
  return a === b || isRelativeTo(a, b) || isRelativeTo(b, a);
}

function wildcardDeleteOverlap(pattern: string, anchor: string, target: string): boolean {
  if (anchor === '/') return true;
  if (globMatch(target, pattern)) return true;
  if (isRelativeTo(anchor, target)) return true;
  if (!isRelativeTo(target, anchor)) return false;
  const anchorParts = posixParts(anchor);
  const suffix = posixParts(pattern).slice(anchorParts.length);
  if (suffix.length !== 1 || (suffix[0] ?? '').includes('**')) return true;
  const targetParts = posixParts(target);
  for (let depth = anchorParts.length; depth < targetParts.length; depth += 1) {
    if (globMatch(`/${targetParts.slice(0, depth).join('/')}`, pattern)) return true;
  }
  return false;
}

function deleteDenyPatternsForLeaf(rules: PermissionRules, target: string): string[] {
  for (const rule of rules) {
    if (!rule.operations.includes('write')) continue;
    const matched = rule.paths.filter((pattern) => globMatch(target, pattern));
    if (matched.length === 0) continue;
    return (rule.mode ?? 'allow') === 'deny' ? matched : [];
  }
  return [];
}

/**
 * 基座的 `findDeleteDenyPatterns`：擋下刪除 `target` 的那幾條 deny。
 *
 * @param rules - 規則表。
 * @param target - 已正規化的路徑。
 * @param hasDescendants - 目標可能是目錄（刪掉會連子樹一起）。
 * @returns 命中的 deny pattern，沒有就是空的。
 */
export function deleteDenyPatterns(
  rules: PermissionRules,
  target: string,
  hasDescendants: boolean,
): string[] {
  if (!hasDescendants) return deleteDenyPatternsForLeaf(rules, target);
  const denying: string[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    if (rule.mode !== 'deny' || !rule.operations.includes('write')) continue;
    for (const pattern of rule.paths) {
      if (seen.has(pattern)) continue;
      const anchor = globAnchor(pattern);
      const overlaps = GLOB_WILDCARD_CHARACTERS.some((character) => pattern.includes(character))
        ? wildcardDeleteOverlap(pattern, anchor, target)
        : pathsOverlap(target, anchor);
      if (overlaps) {
        seen.add(pattern);
        denying.push(pattern);
      }
    }
  }
  return denying;
}

/**
 * 刪除 `path` 被規則擋下時的拒絕句，文字同基座 `delete` 工具去掉 `Error: ` 開頭。
 *
 * @param rules - 規則表。
 * @param path - 解開連結之後的虛擬路徑。
 * @param hasDescendants - 目標可能是目錄。
 * @returns 拒絕句，或沒被擋時的 `undefined`。
 */
export function deleteDenial(
  rules: PermissionRules,
  path: string,
  hasDescendants: boolean,
): string | undefined {
  if (rules.length === 0) return undefined;
  const canonical = validPath(path);
  if (canonical === undefined) return undefined;
  const patterns = deleteDenyPatterns(rules, canonical, hasDescendants);
  return patterns.length === 0
    ? undefined
    : `permission denied for write on ${canonical} (matches deny rule(s): ${patterns.join(', ')})`;
}
