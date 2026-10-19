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
 *   dsh 也不畫。
 * - **交給 SG 的是 unified patch**（#1685 B，`StepRow` 的 `step.patch`）：{@link toolPatch} 組字串。換檔時一列
 *   `diff --git a/<路徑> b/<路徑>`（SG 照畫，等於以前的路徑那一列），每個 hunk 前一列**不帶數字的 `@@`**（取代以前的 `⋯`）：
 *   帶數字就畫出從 1 起算、對不上的行號；不給 `@@` 的話，內容是 `+++ x`／`--- x` 的行在 hunk 外會被 SG 當成檔頭丟掉。
 *   全樹組 unified patch 字串的只有這一支（審查頁不畫 `DiffView`，自己用 `hunkHeader` 畫標頭）。
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

export const WRITE_FILE = 'write_file';
export const EDIT_FILE = 'edit_file';

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

const ESCAPES: Readonly<Record<string, string>> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/**
 * 路徑放進 `diff --git` 那一列之前，C0 控制字元與 DEL 轉義成看得見的 `\n`、`\x1b` 這種寫法：路徑裡的換行會把那一列拆成兩列，
 * 後半段可能被上色、算進增刪數，或憑空開出一個 hunk。開頭的 `/` 拿掉一個，不畫成 `a//notes.md`。
 */
export function patchPath(path: string): string {
  return path
    .replace(/^\//, '')
    .replace(
      // eslint-disable-next-line no-control-regex -- 要找的就是控制字元
      /[\u0000-\u001f\u007f]/g,
      (c) => ESCAPES[c] ?? `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`,
    );
}

/**
 * 幾段 diff 組成 SG `DiffView` 吃的 unified patch（#1685 B）：換檔時先一列 `diff --git`，同一個檔的下一段不重複；
 * 每個 hunk 前一列不帶數字的 `@@`（見檔頭）。hunk 的每一行本來就帶 `+`／`-`／空白前綴，原樣接上。
 */
export function toolPatch(fragments: readonly DiffFragment[]): string {
  const lines: string[] = [];
  let previousPath: string | undefined;
  for (const fragment of fragments) {
    if (fragment.path !== previousPath) {
      const path = patchPath(fragment.path);
      lines.push(`diff --git a/${path} b/${path}`);
    }
    previousPath = fragment.path;
    for (const hunk of fragment.hunks) {
      lines.push('@@');
      for (const line of hunk.lines) lines.push(line);
    }
  }
  return lines.join('\n');
}

/** 卡片要的全部：交給 SG 的 patch 與合計的增刪行數。 */
export interface ToolDiffView {
  readonly patch: string;
  readonly totals: { readonly added: number; readonly removed: number };
}

/**
 * 一則工具呼叫算好的 diff，以那一則為鍵記住（#1685 B）：工具卡與它所在的工具段（`tool-run.tsx` 的 steps）都從這裡拿，
 * 拿到的是**同一個字串**，nexus 層 `patchStats` 的快取（`components/ui/diff-view.tsx`）以字串為鍵，同一個實例查起來不必重算雜湊。
 * wire 的 reducer 換掉那一格時是新的物件，舊的跟著被回收。
 */
const views = new WeakMap<object, ToolDiffView | undefined>();

function computeDiffView(
  entry: Pick<ToolEntry, 'name' | 'status' | 'input' | 'meta'>,
): ToolDiffView | undefined {
  const diffs = toolDiffs(entry);
  if (diffs === undefined) return undefined;
  const fragments = diffs.map((diff) => ({ path: diff.path, hunks: diffHunks(diff) }));
  return {
    patch: toolPatch(fragments),
    totals: diffTotals(fragments.flatMap((fragment) => fragment.hunks)),
  };
}

/** 這張卡的 diff；沒有 diff 就走通用卡。 */
export function toolDiffView(
  entry: Pick<ToolEntry, 'name' | 'status' | 'input' | 'meta'>,
): ToolDiffView | undefined {
  if (views.has(entry)) return views.get(entry);
  const view = computeDiffView(entry);
  views.set(entry, view);
  return view;
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
