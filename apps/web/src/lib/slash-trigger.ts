/*
 * 輸入框的 `/` 選單：觸發、排序、選了之後怎麼改草稿。照 dsh（本機 clone `ddefc45`，MIT，Copyright (c) DeepSeek）：
 *
 * - 觸發照 `ui-input-trigger/src/core/detect.ts` 的 `/` 那一支：從游標往左掃到空白為止；`/` 只在字首、空白或
 *   標點後面才算，網址裡的 `//` 與 `https:/` 不算。第一個非空白字就是它時是 leading，不然是 inline。
 * - 候選照 `ui-commands/src/client/service.ts` 的 `candidates`：inline 只列不帶參數的命令；有打字時用
 *   `ui-primitives/src/rank-by-name.ts` 排序（下面逐行搬來）。空字串時照目錄順序——dsh 分區（`sectionRows`）
 *   是它自己內建命令的分組，nexus 沒有那幾個命令。
 * - 選了之後照 `service.ts` 的 `dispatch` 的順序：有裝飾的命令（光打名字就另有動作，nexus 目前只有 `/feedback`
 *   開回饋框）直接執行；帶參數的在草稿填上 `/名稱 ` 等人打參數（dsh 的 claim；nexus 沒有 claim 的標籤，用文字
 *   表達）；不帶參數的從草稿拿掉那一段、直接執行。
 */

import type { SlashDescriptor } from '@nexus/wire';

export interface SlashHit {
  /** `/` 到游標之間的字。 */
  readonly query: string;
  readonly position: 'leading' | 'inline';
  /** `/` 的位置。 */
  readonly start: number;
  /** 游標。 */
  readonly end: number;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;
const WHITESPACE = /\s/u;

/** `/` 只在字首、空白或標點後面才開；網址的 `//` 與 `scheme:/` 不開。 */
function boundaryOk(draft: string, index: number): boolean {
  if (index === 0) return true;
  const prev = draft.charAt(index - 1);
  if (WHITESPACE.test(prev)) return true;
  if (WORD_CHAR.test(prev)) return false;
  if (prev === '/') return false;
  if (prev === ':' && index >= 2 && !WHITESPACE.test(draft.charAt(index - 2))) return false;
  return true;
}

/** 游標所在的 `/` 片段；沒有就是 null。 */
export function detectSlash(draft: string, caret: number): SlashHit | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = draft.charAt(i);
    if (WHITESPACE.test(ch)) return null;
    if (ch !== '/') continue;
    if (!boundaryOk(draft, i)) continue;
    return {
      query: draft.slice(i + 1, caret),
      position: draft.search(/\S/) === i ? 'leading' : 'inline',
      start: i,
      end: caret,
    };
  }
  return null;
}

/** 名字開頭與 `-`／`_` 後面的字加分。 */
function boundaryBonus(name: string, index: number): number {
  return index === 0 || name.charAt(index - 1) === '-' || name.charAt(index - 1) === '_' ? 8 : 0;
}

/**
 * 最好的有序子序列對齊分數，O(名字長 × 查詢長)。邊界與相鄰的命中加分，跳過與開頭前的字扣分；
 * 查詢不是名字的子序列時是 undefined。
 */
function alignmentScore(name: string, query: string): number | undefined {
  if (query.length > name.length) return undefined;
  const noMatch = Number.NEGATIVE_INFINITY;
  let previous = Array<number>(name.length).fill(noMatch);
  for (let index = 0; index < name.length; index++) {
    if (name.charAt(index) === query.charAt(0)) {
      previous[index] = 1 + boundaryBonus(name, index) - index;
    }
  }
  for (let queryIndex = 1; queryIndex < query.length; queryIndex++) {
    const current = Array<number>(name.length).fill(noMatch);
    // 把上一列掃一遍：`left` 是往回一格的分數（相鄰接續），`leftLeft` 是往回兩格（最早的跳格接續）。
    let left = noMatch;
    let leftLeft = noMatch;
    let bestGapped = noMatch;
    for (const [index, prior] of previous.entries()) {
      if (leftLeft !== noMatch) bestGapped = Math.max(bestGapped, leftLeft + index - 2);
      if (name.charAt(index) === query.charAt(queryIndex)) {
        const bonus = 1 + boundaryBonus(name, index);
        let score = noMatch;
        if (left !== noMatch) score = left + bonus + 4;
        if (bestGapped !== noMatch) score = Math.max(score, bestGapped + bonus + 1 - index);
        current[index] = score;
      }
      leftLeft = left;
      left = prior;
    }
    previous = current;
  }
  let best = noMatch;
  for (const score of previous) best = Math.max(best, score);
  return best === noMatch ? undefined : best;
}

/** 依查詢排序：開頭命中的在前，再依對齊分數，再依原順序；不分大小寫，查詢是空字串時原樣回傳。 */
export function rankByName<T extends { readonly name: string }>(
  items: readonly T[],
  rawQuery: string,
): readonly T[] {
  const query = rawQuery.toLowerCase();
  if (query === '') return items;
  const ranked: { item: T; index: number; prefix: boolean; score: number }[] = [];
  items.forEach((item, index) => {
    const lower = item.name.toLowerCase();
    const score = alignmentScore(lower, query);
    if (score !== undefined) ranked.push({ item, index, prefix: lower.startsWith(query), score });
  });
  ranked.sort(
    (left, right) =>
      Number(right.prefix) - Number(left.prefix) ||
      right.score - left.score ||
      left.index - right.index,
  );
  return ranked.map((match) => match.item);
}

/** 這個片段要列哪些命令。 */
export function slashCandidates(
  commands: readonly SlashDescriptor[],
  hit: SlashHit,
): readonly SlashDescriptor[] {
  const visible = commands.filter(
    (command) => hit.position === 'leading' || command.input === undefined,
  );
  return rankByName(visible, hit.query);
}

export interface SlashPick {
  readonly draft: string;
  readonly caret: number;
  /** 要執行的那一行；帶參數的命令不執行，等人打完參數再送。 */
  readonly run?: string;
}

/**
 * 選了 `command` 之後草稿變成什麼、要不要執行。
 * @param decorated 光打名字就另有動作的命令（照 dsh，裝飾排在參數之前判）。
 */
export function applySlashPick(
  draft: string,
  hit: SlashHit,
  command: SlashDescriptor,
  decorated: ReadonlySet<string> = new Set(),
): SlashPick {
  const before = draft.slice(0, hit.start);
  const after = draft.slice(hit.end);
  if (command.input !== undefined && !decorated.has(command.name)) {
    const token = `/${command.name} `;
    return { draft: before + token + after, caret: before.length + token.length };
  }
  return { draft: before + after, caret: before.length, run: `/${command.name}` };
}
