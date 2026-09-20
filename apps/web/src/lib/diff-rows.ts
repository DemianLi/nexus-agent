/**
 * 把一個檔的比較（`WorkspaceFileDiff` 的 hunks）排成要畫的列（[#443](https://github.com/DemianLi/nexus-agent/issues/443) web 第二刀）。
 *
 * 照 dsh `ReviewTab` 的 `hunkRows`、`splitRows`、`renderedHunks`（`packages/client/ui-deliverables/src/client/ReviewTab.tsx`，
 * `ddefc45`）：
 *
 * - **單欄**：上下文兩側都算行號，刪掉的只算左側，新增的只算右側。
 * - **左右對照**：一段連續的刪除跟緊接著的那段新增逐列對齊，多出來的那側留空；上下文兩側都有。
 * - **最多畫 {@link MAX_RENDERED_LINES} 行**：逐行比較逾時退成整檔替換時，靠近大小上限的檔會一次畫出每一行。
 *
 * @module
 */

import type { WorkspaceDiffHunk } from '@nexus/wire';

/** 畫到這麼多行就停（dsh `MAX_RENDERED_LINES`）。 */
export const MAX_RENDERED_LINES = 5000;

/** 單欄的一列：兩側的行號，沒有的那側是 `undefined`。 */
export interface DiffRow {
  readonly kind: 'add' | 'del' | 'context';
  readonly old: number | undefined;
  readonly new: number | undefined;
  readonly text: string;
}

/** 左右對照的一列：左邊是舊的、右邊是新的，可能只有一側。 */
export interface SplitRow {
  readonly left?: { readonly no: number; readonly text: string; readonly kind: 'del' | 'context' };
  readonly right?: { readonly no: number; readonly text: string; readonly kind: 'add' | 'context' };
}

/** 一個 hunk 的每一行，帶兩側行號。 */
export function hunkRows(hunk: WorkspaceDiffHunk): DiffRow[] {
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  return hunk.lines.map((line): DiffRow => {
    const text = line.slice(1);
    switch (line[0]) {
      case '+':
        return { kind: 'add', old: undefined, new: newNo++, text };
      case '-':
        return { kind: 'del', old: oldNo++, new: undefined, text };
      default:
        return { kind: 'context', old: oldNo++, new: newNo++, text };
    }
  });
}

/** 一個 hunk 排成左右對照：每段刪除跟後面那段新增逐列配對。 */
export function splitRows(hunk: WorkspaceDiffHunk): SplitRow[] {
  const rows: SplitRow[] = [];
  let dels: NonNullable<SplitRow['left']>[] = [];
  let adds: NonNullable<SplitRow['right']>[] = [];
  const flush = () => {
    for (let at = 0; at < Math.max(dels.length, adds.length); at += 1) {
      const left = dels[at];
      const right = adds[at];
      rows.push({
        ...(left === undefined ? {} : { left }),
        ...(right === undefined ? {} : { right }),
      });
    }
    dels = [];
    adds = [];
  };
  for (const row of hunkRows(hunk)) {
    if (row.kind === 'del') dels.push({ no: row.old!, text: row.text, kind: 'del' });
    else if (row.kind === 'add') adds.push({ no: row.new!, text: row.text, kind: 'add' });
    else {
      flush();
      rows.push({
        left: { no: row.old!, text: row.text, kind: 'context' },
        right: { no: row.new!, text: row.text, kind: 'context' },
      });
    }
  }
  flush();
  return rows;
}

/** 左右對照那一列算哪一種：任一側是刪除或新增就算那一種，否則是上下文。 */
export function splitRowKind(row: SplitRow): DiffRow['kind'] {
  if (row.left?.kind === 'del') return 'del';
  if (row.right?.kind === 'add') return 'add';
  return 'context';
}

/** 要畫的 hunks：總共切在 {@link MAX_RENDERED_LINES} 行，最後那個 hunk 視需要截短；`truncated` 講有沒有真的切掉東西。 */
export function renderedHunks(hunks: readonly WorkspaceDiffHunk[]): {
  hunks: WorkspaceDiffHunk[];
  truncated: boolean;
} {
  let budget = MAX_RENDERED_LINES;
  const kept: WorkspaceDiffHunk[] = [];
  for (const hunk of hunks) {
    if (budget === 0) return { hunks: kept, truncated: true };
    kept.push(hunk.lines.length <= budget ? hunk : { ...hunk, lines: hunk.lines.slice(0, budget) });
    budget -= Math.min(budget, hunk.lines.length);
  }
  return { hunks: kept, truncated: hunks.some((hunk, at) => kept[at] !== hunk) };
}

/** hunk 的標頭，unified diff 的寫法。 */
export function hunkHeader(hunk: WorkspaceDiffHunk): string {
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
}
