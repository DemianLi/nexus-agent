/**
 * 工具卡上的 diff（[#601](https://github.com/DemianLi/nexus-agent/issues/601)）：`write_file`、`edit_file` 改了什麼。
 *
 * 照 dsh `diffCardModel`＋`DiffBlock`（`packages/client/ui-tool/src/client/tool/models/diff-card-model.ts`、
 * `packages/client/ui-primitives/src/DiffBlock.tsx`，master `477b4f4`）：
 *
 * - **執行中從參數算**：write 是 `content` 整檔新增，edit 是 `old_string` → `new_string`。
 * - **結束之後**：dsh 讀結果 metadata 的 `diffs`，我們線上還沒有這一格（等 harness，見 #601「不在這張」）。所以
 *   write 沿用參數算出的整檔新增（dsh 在 metadata 缺席時也是這樣），**edit 退回通用卡**——參數那一段只是片段，
 *   結束之後拿它當「改了什麼」不準（`replace_all` 會改好幾處）。失敗一律退回通用卡。
 * - **參數解不開或欄位不對就不給**，不畫半套（例如 `content` 不是字串）。
 * - **算法**：`diff` 的 `structuredPatch`，上下文 3 行；比較的改動超過 {@link MAX_DIFF_EDIT_LENGTH} 就不找了，
 *   整段當成替換（`diff@9` 在那時回 `undefined`）。
 * - **不畫行號**：edit 的兩段是從檔案中間截出來的，算出來的行號從 1 起跳，跟檔案裡的位置對不上；dsh 也不畫。
 *   每個檔先一列路徑，同一段裡相隔太遠的兩處改動之間一列 `⋯`。
 *
 * 子代理的呼叫 dsh 不畫 diff 卡（它們收在子代理那張卡底下）；我們的子代理工具卡跟 root 的並排、只多一枚歸屬，
 * 所以照樣畫。
 *
 * @module
 */

import { structuredPatch } from 'diff';
import type { ToolEntry, WorkspaceDiffHunk } from '@nexus/wire';

import { hunkRows } from '@/lib/diff-rows';
import type { DiffRow } from '@/lib/diff-rows';

export const WRITE_FILE = 'write_file';
export const EDIT_FILE = 'edit_file';

/** 對話裡最多畫幾列（含路徑那一列），多的收在中間（dsh `CHAT_DIFF_MAX_LINES`）。 */
export const CHAT_DIFF_MAX_LINES = 9;

/** 逐行比較最多找這麼多處改動，一處替換算兩處（dsh `MAX_DIFF_EDIT_LENGTH`）。 */
export const MAX_DIFF_EDIT_LENGTH = 256;

/** 一個檔的改動：改之前（沒有時是 `null`，例如新檔）與改之後。 */
export interface FileDiff {
  readonly path: string;
  readonly oldText: string | null;
  readonly newText: string;
}

/** diff 裡的一列。路徑與 `⋯` 是版面，其他照 {@link DiffRow} 的三種。 */
export type ToolDiffRow =
  | { readonly kind: 'path' | 'gap'; readonly text: string }
  | { readonly kind: DiffRow['kind']; readonly text: string };

function parseArgs(input: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(input);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** 這張卡要畫的 diff；沒有就走通用卡。 */
export function toolDiff(
  entry: Pick<ToolEntry, 'name' | 'status' | 'input'>,
): FileDiff | undefined {
  if (entry.name !== WRITE_FILE && entry.name !== EDIT_FILE) return undefined;
  if (entry.status === 'failed' || entry.status === 'suspended') return undefined;
  const args = parseArgs(entry.input);
  if (args === undefined) return undefined;
  const path = args.file_path;
  if (typeof path !== 'string' || path.trim() === '') return undefined;
  if (entry.name === WRITE_FILE) {
    return typeof args.content === 'string'
      ? { path, oldText: null, newText: args.content }
      : undefined;
  }
  if (entry.status !== 'running') return undefined;
  const { old_string: oldText, new_string: newText, replace_all: replaceAll } = args;
  if (typeof oldText !== 'string' || typeof newText !== 'string') return undefined;
  if (replaceAll !== undefined && typeof replaceAll !== 'boolean') return undefined;
  return { path, oldText: oldText === '' ? null : oldText, newText };
}

/**
 * 一邊的文字切成行：空字串是零行，結尾那一個換行是行尾、不是多一行空行（dsh `contentLines`）。
 */
export function contentLines(text: string): string[] {
  if (text === '') return [];
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}

/** 一個檔的 hunks。改動太多時整段替換，hunk 的四個數字照實補上（`hunkRows` 要讀）。 */
export function diffHunks(diff: FileDiff): WorkspaceDiffHunk[] {
  const oldLines = contentLines(diff.oldText ?? '');
  const newLines = contentLines(diff.newText);
  const normalize = (lines: readonly string[]) => lines.map((line) => `${line}\n`).join('');
  const patch = structuredPatch(
    '',
    '',
    normalize(oldLines),
    normalize(newLines),
    undefined,
    undefined,
    {
      context: 3,
      maxEditLength: MAX_DIFF_EDIT_LENGTH,
    },
  );
  if (patch !== undefined) return patch.hunks;
  return [
    {
      oldStart: 1,
      oldLines: oldLines.length,
      newStart: 1,
      newLines: newLines.length,
      lines: [...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`)],
    },
  ];
}

/** 新增與刪除的行數，不算上下文；整段替換時兩邊整段都算（dsh `diffTotals`）。 */
export function diffTotals(hunks: readonly WorkspaceDiffHunk[]): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added += 1;
      else if (line.startsWith('-')) removed += 1;
    }
  }
  return { added, removed };
}

/** 攤平成要畫的列：先一列路徑，hunk 之間一列 `⋯`（dsh `buildRows`）。 */
export function diffRows(path: string, hunks: readonly WorkspaceDiffHunk[]): ToolDiffRow[] {
  const rows: ToolDiffRow[] = [{ kind: 'path', text: path }];
  hunks.forEach((hunk, index) => {
    if (index > 0) rows.push({ kind: 'gap', text: '⋯' });
    for (const row of hunkRows(hunk)) rows.push({ kind: row.kind, text: row.text });
  });
  return rows;
}

/** 卡片要的全部：diff、hunks、增刪行數。沒有 diff 就走通用卡。 */
export function toolDiffView(entry: Pick<ToolEntry, 'name' | 'status' | 'input'>):
  | {
      readonly diff: FileDiff;
      readonly hunks: WorkspaceDiffHunk[];
      readonly totals: { added: number; removed: number };
    }
  | undefined {
  const diff = toolDiff(entry);
  if (diff === undefined) return undefined;
  const hunks = diffHunks(diff);
  return { diff, hunks, totals: diffTotals(hunks) };
}

/**
 * 收著時畫哪幾列：超過 `max` 就取頭 ⌈max/2⌉、尾 ⌊max/2⌋，中間收起來（dsh `DiffBlock` 同一套切法）。
 * `hidden` 是收起來的列數，0 表示全畫了。
 */
export function cappedRows<T>(
  rows: readonly T[],
  max: number,
): { head: readonly T[]; tail: readonly T[]; hidden: number } {
  const hidden = rows.length - max;
  if (hidden <= 0) return { head: rows, tail: [], hidden: 0 };
  const headLines = Math.ceil(max / 2);
  return {
    head: rows.slice(0, headLines),
    tail: rows.slice(rows.length - (max - headLines)),
    hidden,
  };
}
