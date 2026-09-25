/**
 * 讀檔卡與搜尋卡要畫什麼（[#625](https://github.com/DemianLi/nexus-agent/issues/625)）：從工具結果的 `meta` 驗出來，
 * 驗不過就走通用卡。畫法在 `components/tool-result.tsx`。
 *
 * 照 dsh `readCardModel`／`searchCardModel`（`packages/client/ui-tool/src/client/tool/models/read-card-model.ts`、
 * `search-card-model.ts`，master `477b4f4`），`meta` 的形狀逐字相同（harness 的 `packages/nexus-core/src/tool-result-meta.ts`）。
 * 跟 dsh 不同的三處，都是基座的參數或結果文字跟 dsh 的工具不一樣：
 *
 * - **不驗結果文字的外框**：dsh 讀檔卡要求結果文字是它自己的 `<path>…<content>` 外框（`read-card-model.ts:111`），
 *   我們的是 deepagents 的格式，照抄的話每一張都走通用卡。#601 已經定了 web 不從文字猜，只驗 `meta`。
 * - **讀檔參數只驗 `file_path`**：dsh 要 `offset`／`limit` 是 ≥1 的整數；deepagents 的 `read_file` 是
 *   `z.coerce.number().default(0)`——0 起算、字串也收，照抄會把「從檔頭讀」這種最常見的呼叫擋掉。有 `meta` 就代表
 *   基座接受了那組參數，行號一律從 `meta` 取。
 * - **grep 的檔案過濾叫 `glob`、可以是 `null`**（dsh 叫 `include`），照 deepagents 的 schema 驗。
 *
 * **搜尋的 `meta` 可能比模型看到的文字多**：基座還會再截文字，`meta` 是截之前的那份，`total` 是截之前的總數；
 * 卡片以 `meta` 為準，不跟文字對。dsh 截斷時還有一個看完整結果的出口（`recovery`），我們沒有存完整結果的地方，不做。
 *
 * 子代理的呼叫照樣畫：dsh 排除的是 `parentCallId`（`run_code` 裡的子呼叫，我們沒有這種）。
 *
 * @module
 */

import type { ToolEntry } from '@nexus/wire';

import { parseArgs } from '@/lib/tool-diff';

export const READ_FILE = 'read_file';
export const GREP = 'grep';
export const GLOB = 'glob';

/** 對話裡讀檔卡最多畫幾行，多的收在中間（dsh `CHAT_READ_MAX_LINES`）。 */
export const CHAT_READ_MAX_LINES = 8;

/** 對話裡搜尋卡最多畫幾列（檔案標題也算一列），多的收在中間（dsh `CHAT_SEARCH_MAX_LINES`）。 */
export const CHAT_SEARCH_MAX_LINES = 8;

type Settled = Pick<ToolEntry, 'name' | 'status' | 'input' | 'meta'>;

/** 讀到的一行與它在檔案裡的行號（1 起算）。 */
export interface ReadLine {
  readonly number: number;
  readonly text: string;
}

export interface ReadCard {
  readonly path: string;
  readonly lines: readonly ReadLine[];
  readonly totalLines: number;
  readonly lang?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** dsh `readMeta`：行號嚴格遞增、不小於 `offset`、不超過總行數。 */
function readMeta(meta: unknown): ReadCard | undefined {
  if (!isRecord(meta)) return undefined;
  const { path, offset, lines, totalLines, lang } = meta;
  if (typeof path !== 'string' || !isNonNegativeInteger(offset) || offset < 1) return undefined;
  if (!isNonNegativeInteger(totalLines) || !Array.isArray(lines)) return undefined;
  if (lang !== undefined && typeof lang !== 'string') return undefined;
  const narrowed: ReadLine[] = [];
  let previous = offset - 1;
  for (const line of lines as unknown[]) {
    if (!isRecord(line)) return undefined;
    const { number, text } = line;
    if (!isNonNegativeInteger(number) || number <= previous || number > totalLines) {
      return undefined;
    }
    if (typeof text !== 'string') return undefined;
    previous = number;
    narrowed.push({ number, text });
  }
  return { path, lines: narrowed, totalLines, ...(lang === undefined ? {} : { lang }) };
}

/** 這張讀檔卡要畫什麼；沒有就走通用卡。 */
export function readCardOf(entry: Settled): ReadCard | undefined {
  if (entry.name !== READ_FILE || entry.status !== 'done') return undefined;
  const args = parseArgs(entry.input);
  const path = args?.file_path;
  if (typeof path !== 'string' || path.trim() === '') return undefined;
  return readMeta(entry.meta);
}

/** 只讀了一部分時講讀到哪裡（dsh 的 `window`）；整份都讀了、或一行都沒有時不講。 */
export function readWindowText(card: ReadCard): string | undefined {
  const first = card.lines[0];
  const last = card.lines.at(-1);
  if (first === undefined || last === undefined || card.lines.length >= card.totalLines) {
    return undefined;
  }
  const range =
    first.number === last.number ? `第 ${first.number} 行` : `第 ${first.number}–${last.number} 行`;
  return `${range}，共 ${card.totalLines} 行`;
}

/** 一個檔的命中。 */
export interface SearchFile {
  readonly path: string;
  readonly matches: readonly { readonly lineNumber: number; readonly line: string }[];
}

export type SearchCard =
  | {
      readonly kind: 'matches';
      readonly files: readonly SearchFile[];
      readonly truncated: boolean;
      readonly total: number;
    }
  | {
      readonly kind: 'paths';
      readonly paths: readonly string[];
      readonly truncated: boolean;
      readonly total: number;
    };

/** dsh `validSearchCall`，檔案過濾照 deepagents 的 `glob`（見檔頭）。 */
function validSearchCall(entry: Settled): typeof GREP | typeof GLOB | undefined {
  if (entry.name !== GREP && entry.name !== GLOB) return undefined;
  const args = parseArgs(entry.input);
  if (args === undefined) return undefined;
  const { pattern, path } = args;
  if (typeof pattern !== 'string') return undefined;
  if (entry.name === GREP ? pattern === '' : pattern.trim() === '') return undefined;
  if (path !== undefined && (typeof path !== 'string' || path.trim() === '')) return undefined;
  if (entry.name === GREP) {
    const { glob } = args;
    if (glob !== undefined && glob !== null && typeof glob !== 'string') return undefined;
  }
  return entry.name;
}

function searchFiles(value: unknown): SearchFile[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const files: SearchFile[] = [];
  for (const file of value as unknown[]) {
    if (!isRecord(file)) return undefined;
    const { path, matches } = file;
    if (typeof path !== 'string' || !Array.isArray(matches)) return undefined;
    const narrowed: { lineNumber: number; line: string }[] = [];
    for (const match of matches as unknown[]) {
      if (!isRecord(match)) return undefined;
      const { lineNumber, line } = match;
      if (!isNonNegativeInteger(lineNumber) || lineNumber < 1) return undefined;
      if (typeof line !== 'string') return undefined;
      narrowed.push({ lineNumber, line });
    }
    files.push({ path, matches: narrowed });
  }
  return files;
}

/**
 * 這張搜尋卡要畫什麼；沒有就走通用卡。grep 只有 content 模式帶 `meta`，其他模式自然走通用卡。
 */
export function searchCardOf(entry: Settled): SearchCard | undefined {
  if (entry.status !== 'done') return undefined;
  const tool = validSearchCall(entry);
  if (tool === undefined || !isRecord(entry.meta)) return undefined;
  const { shape, truncated, total } = entry.meta;
  if (typeof truncated !== 'boolean' || !isNonNegativeInteger(total)) return undefined;
  if (tool === GREP) {
    if (shape !== 'matches') return undefined;
    const files = searchFiles(entry.meta.files);
    return files === undefined ? undefined : { kind: 'matches', files, truncated, total };
  }
  const { paths } = entry.meta;
  if (shape !== 'paths' || !Array.isArray(paths)) return undefined;
  if (!(paths as unknown[]).every((path): path is string => typeof path === 'string')) {
    return undefined;
  }
  return { kind: 'paths', paths: paths as string[], truncated, total };
}

/** 卡上留著的結果數：grep 是命中的行數，glob 是路徑數。截斷時拿它跟 `total` 比。 */
function shownCount(card: SearchCard): number {
  return card.kind === 'paths'
    ? card.paths.length
    : card.files.reduce((sum, file) => sum + file.matches.length, 0);
}

/**
 * 標頭那一句（dsh `summaryText`）：截斷時「顯示 X／共 N」寫在同一句，卡片看起來才不會像完整的結果。
 */
export function searchSummary(card: SearchCard): string {
  const shown = shownCount(card);
  if (shown === 0 && !card.truncated) return '沒有符合的結果';
  const count = card.truncated ? `顯示 ${shown}／共 ${card.total}` : `${shown}`;
  return card.kind === 'paths'
    ? `${count} 個路徑`
    : `${count} 處符合 · ${card.files.length} 個檔案`;
}

/** 攤平之後的一列：檔案標題、命中、路徑。截斷時三種都算一列。 */
export type SearchRow =
  | { readonly type: 'file'; readonly path: string; readonly count: number; readonly index: number }
  | {
      readonly type: 'match';
      readonly lineNumber: number;
      readonly line: string;
      readonly fileIndex: number;
    }
  | { readonly type: 'path'; readonly path: string };

export function searchRows(card: SearchCard): SearchRow[] {
  if (card.kind === 'paths') return card.paths.map((path) => ({ type: 'path', path }));
  return card.files.flatMap((file, index): SearchRow[] => [
    { type: 'file', path: file.path, count: file.matches.length, index },
    ...file.matches.map((match): SearchRow => ({ type: 'match', ...match, fileIndex: index })),
  ]);
}

/**
 * 收著時畫哪幾列（dsh `SearchBlock` 的切法）：頭 ⌈max/2⌉、尾 ⌊max/2⌋。尾段從某個檔的命中中間開始、而那個檔的
 * 標題不在頭段裡時，把標題補在尾段最前面、頂掉尾段第一列，總數仍是 `max`，被頂掉的那一列算進收起來的。
 */
export function cappedSearchRows(
  rows: readonly SearchRow[],
  max: number,
): {
  head: readonly SearchRow[];
  tail: readonly SearchRow[];
  hidden: number;
} {
  const hidden = rows.length - max;
  if (hidden <= 0) return { head: rows, tail: [], hidden: 0 };
  const headLines = Math.ceil(max / 2);
  const head = rows.slice(0, headLines);
  const naturalTail = rows.slice(rows.length - (max - headLines));
  const lead = naturalTail[0];
  if (
    lead?.type !== 'match' ||
    head.some((row) => row.type === 'file' && row.index === lead.fileIndex)
  ) {
    return { head, tail: naturalTail, hidden };
  }
  const header = rows.find((row) => row.type === 'file' && row.index === lead.fileIndex);
  return header === undefined
    ? { head, tail: naturalTail, hidden }
    : { head, tail: [header, ...naturalTail.slice(1)], hidden };
}
