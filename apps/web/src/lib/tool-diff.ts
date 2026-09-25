/**
 * 工具卡上的 diff（[#601](https://github.com/DemianLi/nexus-agent/issues/601)、[#625](https://github.com/DemianLi/nexus-agent/issues/625)）：
 * `write_file`、`edit_file` 改了什麼。
 *
 * 照 dsh `diffCardModel`＋`DiffBlock`（`packages/client/ui-tool/src/client/tool/models/diff-card-model.ts:100-112`、
 * `packages/client/ui-primitives/src/DiffBlock.tsx`，master `477b4f4`）：
 *
 * - **執行中從參數算**：write 是 `content` 整檔新增，edit 是 `old_string` → `new_string`。
 * - **成功之後讀結果的 `meta.diffs`**（harness 在 #619 補上，形狀同 dsh `FsDiffMeta`）：那是實際套用的改動，
 *   write 覆寫舊檔時就是跟舊檔比的 diff，edit 的 `replace_all` 改了好幾處也都在。
 * - **`meta` 沒有 diffs**（新建檔、內容沒變、格式 16 以前的日誌、超過上限被 harness 拿掉）：write 退回參數算的整檔
 *   新增（dsh 同樣這麼做），**edit 退回通用卡**——參數那一段只是片段，結束之後拿它當「改了什麼」不準。
 *   `meta` 形狀不對也走這一條，不畫半套。
 * - **失敗一律退回通用卡**；參數解不開或欄位不對也不給。
 * - **算法**：每一段 `{oldText, newText}` 各自跑 `diff` 的 `structuredPatch`，上下文 3 行；比較的改動超過
 *   {@link MAX_DIFF_EDIT_LENGTH} 就不找了，整段當成替換（`diff@9` 在那時回 `undefined`）。
 * - **不畫行號**：edit 的兩段、`meta` 的每一段都是從檔案中間截出來的，算出來的行號從 1 起跳，跟檔案裡的位置對不上；
 *   dsh 也不畫。換檔時先一列路徑，同一檔的下一段、同一段裡相隔太遠的兩處改動之前各一列 `⋯`。
 *
 * **更正幀**：即時路徑先來一顆沒 `meta` 的完成、再來同 id 帶 `meta` 的一顆（wire 的 reducer 換掉那一格），
 * 呼叫端的 memo 要把 `meta` 算進去，卡片才補畫得出來。
 *
 * 子代理的呼叫照樣畫：dsh 排除的是 `parentCallId`（`run_code` 裡發出的子呼叫，我們沒有這種）；我們的子代理工具卡
 * 跟 root 的並排、只多一枚歸屬。
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

/** 一段改動：改之前（沒有時是 `null`，例如新檔）與改之後。同 harness 的 `FileDiff`（dsh 的 `DiffHunk`）。 */
export interface FileDiff {
  readonly path: string;
  readonly oldText: string | null;
  readonly newText: string;
}

/** 一段 diff 算好的 hunks。 */
export interface DiffFragment {
  readonly path: string;
  readonly hunks: readonly WorkspaceDiffHunk[];
}

/** diff 裡的一列。路徑與 `⋯` 是版面，其他照 {@link DiffRow} 的三種。 */
export type ToolDiffRow =
  | { readonly kind: 'path' | 'gap'; readonly text: string }
  | { readonly kind: DiffRow['kind']; readonly text: string };

export function parseArgs(input: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(input);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** 參數算出來的那一段（dsh `intendedDiff`）。 */
function intendedDiff(entry: Pick<ToolEntry, 'name' | 'input'>): FileDiff | undefined {
  const args = parseArgs(entry.input);
  if (args === undefined) return undefined;
  const path = args.file_path;
  if (typeof path !== 'string' || path.trim() === '') return undefined;
  if (entry.name === WRITE_FILE) {
    return typeof args.content === 'string'
      ? { path, oldText: null, newText: args.content }
      : undefined;
  }
  const { old_string: oldText, new_string: newText, replace_all: replaceAll } = args;
  if (typeof oldText !== 'string' || typeof newText !== 'string') return undefined;
  if (replaceAll !== undefined && typeof replaceAll !== 'boolean') return undefined;
  return { path, oldText: oldText === '' ? null : oldText, newText };
}

/**
 * 結果 `meta` 裡實際套用的那幾段（dsh `appliedDiffs`＋`narrowDiffs`）。`'empty'` 是形狀對、但一段都沒有
 * （新建檔、內容沒變）；`undefined` 是沒有這一格或形狀不對。
 */
function appliedDiffs(meta: unknown): FileDiff[] | 'empty' | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined;
  const diffs = (meta as Record<string, unknown>).diffs;
  if (!Array.isArray(diffs)) return undefined;
  if (diffs.length === 0) return 'empty';
  const out: FileDiff[] = [];
  for (const diff of diffs as unknown[]) {
    if (typeof diff !== 'object' || diff === null) return undefined;
    const { path, oldText, newText } = diff as Record<string, unknown>;
    if (typeof path !== 'string') return undefined;
    if (oldText !== null && typeof oldText !== 'string') return undefined;
    if (typeof newText !== 'string') return undefined;
    out.push({ path, oldText, newText });
  }
  return out;
}

/** 這張卡要畫的那幾段；沒有就走通用卡。 */
export function toolDiffs(
  entry: Pick<ToolEntry, 'name' | 'status' | 'input' | 'meta'>,
): FileDiff[] | undefined {
  if (entry.name !== WRITE_FILE && entry.name !== EDIT_FILE) return undefined;
  if (entry.status === 'failed' || entry.status === 'suspended') return undefined;
  const intended = intendedDiff(entry);
  if (intended === undefined) return undefined;
  if (entry.status === 'running') return [intended];
  const applied = appliedDiffs(entry.meta);
  if (applied === undefined || applied === 'empty') {
    return entry.name === WRITE_FILE ? [intended] : undefined;
  }
  return applied;
}

/**
 * 一邊的文字切成行：空字串是零行，結尾那一個換行是行尾、不是多一行空行（dsh `contentLines`）。
 */
export function contentLines(text: string): string[] {
  if (text === '') return [];
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}

/** 一段的 hunks。改動太多時整段替換，hunk 的四個數字照實補上（`hunkRows` 要讀）。 */
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

/**
 * 攤平成要畫的列（dsh `buildRows`）：換檔時先一列路徑；同一檔的下一段、同一段裡的下一個 hunk 之前各一列 `⋯`。
 */
export function diffRows(fragments: readonly DiffFragment[]): ToolDiffRow[] {
  const rows: ToolDiffRow[] = [];
  let previousPath: string | undefined;
  for (const fragment of fragments) {
    if (fragment.path !== previousPath) rows.push({ kind: 'path', text: fragment.path });
    else rows.push({ kind: 'gap', text: '⋯' });
    previousPath = fragment.path;
    fragment.hunks.forEach((hunk, index) => {
      if (index > 0) rows.push({ kind: 'gap', text: '⋯' });
      for (const row of hunkRows(hunk)) rows.push({ kind: row.kind, text: row.text });
    });
  }
  return rows;
}

/** 卡片要的全部：每一段的 hunks 與合計的增刪行數。沒有 diff 就走通用卡。 */
export function toolDiffView(entry: Pick<ToolEntry, 'name' | 'status' | 'input' | 'meta'>):
  | {
      readonly fragments: readonly DiffFragment[];
      readonly totals: { added: number; removed: number };
    }
  | undefined {
  const diffs = toolDiffs(entry);
  if (diffs === undefined) return undefined;
  const fragments = diffs.map((diff) => ({ path: diff.path, hunks: diffHunks(diff) }));
  return { fragments, totals: diffTotals(fragments.flatMap((fragment) => fragment.hunks)) };
}

/**
 * 收著時畫哪幾列：超過 `max` 就取頭 ⌈max/2⌉、尾 ⌊max/2⌋，中間收起來（dsh `headTailCap`）。
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
