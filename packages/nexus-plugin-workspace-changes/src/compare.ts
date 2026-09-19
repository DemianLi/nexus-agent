/**
 * 兩份整檔文字的逐行比較，有逾時，逾時就退成整檔替換。照 dsh `workspace-changes/src/compare.ts`（`ddefc45`）
 * 逐行移植，比較器同是 `diff` 的 `structuredPatch`。
 *
 * @module
 */

import { structuredPatch } from 'diff';
import type { WorkspaceDiffHunk } from '@nexus/wire';

/** 每處改動前後的上下文行數，unified diff 的預設。 */
const CONTEXT_LINES = 3;

/** hunk、有沒有因逾時而退化，以及它們帶的增刪行數。 */
export interface Comparison {
  readonly hunks: WorkspaceDiffHunk[];
  readonly coarse: boolean;
  readonly added: number;
  readonly deleted: number;
}

/** 每一行都補上結尾換行：最後一行只按內容比，空字串讀成零行而不是一個空行。 */
function terminated(text: string): string {
  return text === '' || text.endsWith('\n') ? text : `${text}\n`;
}

/** 補過結尾的文字的內容行；空字串是零行。 */
function lines(text: string): string[] {
  return text === '' ? [] : text.slice(0, -1).split('\n');
}

/**
 * 逐行比較兩份文字。`null` 表示那一側檔案不存在。比較超過 `timeoutMs` 時，回一個刪掉全部舊行、加上全部
 * 新行的 hunk。
 * @param before - 這一輪開始時的文字，或 `null`。
 * @param after - 這一輪結束時的文字，或 `null`。
 * @param timeoutMs - 逐行比較可以跑多久。
 * @returns hunk 與行數；兩側逐行相同時沒有 hunk。
 */
export function compareText(
  before: string | null,
  after: string | null,
  timeoutMs: number,
): Comparison {
  const oldText = terminated(before ?? '');
  const newText = terminated(after ?? '');
  const patch = structuredPatch('', '', oldText, newText, undefined, undefined, {
    context: CONTEXT_LINES,
    timeout: timeoutMs,
  });
  let hunks: WorkspaceDiffHunk[];
  let coarse = false;
  if (patch === undefined) {
    coarse = true;
    const oldLines = lines(oldText);
    const newLines = lines(newText);
    hunks = [
      {
        oldStart: 1,
        oldLines: oldLines.length,
        newStart: 1,
        newLines: newLines.length,
        lines: [...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`)],
      },
    ];
  } else {
    hunks = patch.hunks.map(({ oldStart, oldLines, newStart, newLines, lines: body }) => ({
      oldStart,
      oldLines,
      newStart,
      newLines,
      lines: body,
    }));
  }
  let added = 0;
  let deleted = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added += 1;
      else if (line.startsWith('-')) deleted += 1;
    }
  }
  return { hunks, coarse, added, deleted };
}
