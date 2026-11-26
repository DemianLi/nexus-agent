/**
 * 摘要訊息的本文：凍結的索引條目在前、一份可變的現況在後
 * （[#2776](https://github.com/DemianLi/nexus-agent/issues/2776)）。
 *
 * ```
 * <index>
 * [#1 messages 0-41] 標題
 * - 發生了什麼（至多三行）
 * Anchors: 字面錨點
 * [#2 messages 42-97] 標題
 * Supersedes: #1 …
 * </index>
 * <state>
 * 現況（模型寫的 Markdown）
 * </state>
 * ```
 *
 * 條目寫進去之後不再改：下一次摘要把舊的 `<index>` 內文**原樣**抄過來、新條目接在後面，所以這一段跨多次摘要逐位元組
 * 相同，請求前綴的快取失效點落在舊索引之後（新條目起）。方括號的指標由程式組，模型寫的是標題、各行、錨點與取代。
 *
 * 沒有 `<index>` 的本文是這個形狀出現以前的摘要：整份當現況，條目從零開始。
 *
 * 全是純函式，不碰日誌、不叫模型。
 *
 * @module
 */

/** 條目各格的上限（字元；`lines` 是行數）。超過不截斷：那一筆不成立，見 {@link parseEntryDraft}。 */
export const SUMMARY_ENTRY_LIMITS = {
  title: 160,
  lines: 3,
  line: 240,
  anchors: 400,
  supersedes: 240,
} as const;

/** 現況的上限（字元）。超過不截斷：重生一次，仍超過這次摘要就不成立。 */
export const SUMMARY_STATE_MAX_CHARS = 24_000;

/**
 * 索引條目那一次呼叫的指令：接在要描述的那一段後面，當最後一則 user 訊息。
 */
export const SUMMARY_ENTRY_INSTRUCTION = [
  'You are now writing ONE index entry for a compaction log. Describe only the messages ABOVE that come after the most recent summary message (or the whole conversation if there is no summary message). Do not describe the summary message itself.',
  '',
  'Output EXACTLY this shape and nothing else:',
  '',
  'Title: <one line naming what this stretch of the conversation was about>',
  '- <what happened, one line>',
  '- <optional second line>',
  '- <optional third line>',
  'Anchors: <literal strings worth searching for later, separated by "; ": exact error strings, numeric values, config keys, file paths, identifiers>',
  'Supersedes: #<entry number> <what this stretch replaced or overturned>',
  '',
  'Rules:',
  '- At most three "- " lines. Each line is a single line.',
  '- Omit the "Supersedes:" line unless this stretch explicitly overturns something recorded in an earlier index entry.',
  '- Copy anchors verbatim from the conversation. Do not paraphrase them.',
  '- Do not use angle-bracket tags. Do not call any tool or take any other action.',
].join('\n');

/**
 * 讀回被摘掉的原文的兩個工具（`history-recall.ts`）。名字放這裡不放 `history-recall.ts`：摘要的前言（`summarizer-engine.ts`）也寫著它們，
 * 而 `history-recall.ts` 自己 import `summarizer-engine.ts`。
 */
export const HISTORY_READ_TOOL_NAME = 'history_read';
export const HISTORY_SEARCH_TOOL_NAME = 'history_search';

/** 模型寫的那幾格。 */
export interface SummaryEntryDraft {
  readonly title: string;
  readonly lines: readonly string[];
  readonly anchors?: string;
  /** 取代了哪一筆：序號與說明。 */
  readonly supersedes?: { readonly index: number; readonly note: string };
}

/** 一筆索引條目。沒有 `draft` 是只有指標的條目。 */
export interface SummaryEntry {
  /** 第幾筆，從 1 起。 */
  readonly index: number;
  /** 被摘掉的那一段在 state 訊息串上的範圍 `[from, to)`。 */
  readonly range: readonly [from: number, to: number];
  readonly draft?: SummaryEntryDraft;
}

/** 拆開的摘要本文。 */
export interface SummaryHead {
  /** `<index>` 的內文，原樣；沒有索引是空字串。 */
  readonly indexText: string;
  /** 索引裡有幾筆條目。 */
  readonly entries: number;
  /** 現況；這個形狀出現以前的摘要是整份本文。 */
  readonly state: string;
}

const INDEX_OPEN = '<index>\n';
const INDEX_TO_STATE = '\n</index>\n<state>\n';
const STATE_CLOSE = '\n</state>';
const POINTER = /^\[#(\d+) messages (\d+)-(\d+)\]/;

/**
 * @param text - 摘要本文（不含前言與 `<summary>` 包法）。
 * @returns 索引與現況。
 */
export function parseSummaryHead(text: string): SummaryHead {
  const split = text.indexOf(INDEX_TO_STATE);
  if (!text.startsWith(INDEX_OPEN) || split < 0 || !text.endsWith(STATE_CLOSE))
    return { indexText: '', entries: 0, state: text };
  const indexText = text.slice(INDEX_OPEN.length, split);
  return {
    indexText,
    entries: indexText.split('\n').filter((line) => POINTER.test(line)).length,
    state: text.slice(split + INDEX_TO_STATE.length, text.length - STATE_CLOSE.length),
  };
}

/**
 * @param previousIndexText - 上一份的 `<index>` 內文，原樣抄。
 * @param entry - 這次的新條目。
 * @param state - 新的現況。
 * @returns 摘要本文。
 */
export function composeSummaryHead(
  previousIndexText: string,
  entry: SummaryEntry,
  state: string,
): string {
  const index =
    previousIndexText === ''
      ? renderSummaryEntry(entry)
      : `${previousIndexText}\n${renderSummaryEntry(entry)}`;
  return `${INDEX_OPEN}${index}${INDEX_TO_STATE}${state}${STATE_CLOSE}`;
}

/**
 * @param entry - 條目。
 * @returns 條目在 `<index>` 裡的文字：指標一行，接模型寫的那幾格。
 */
export function renderSummaryEntry(entry: SummaryEntry): string {
  const pointer = `[#${entry.index} messages ${entry.range[0]}-${entry.range[1] - 1}]`;
  const { draft } = entry;
  if (draft === undefined) return pointer;
  return [
    `${pointer} ${draft.title}`,
    ...draft.lines.map((line) => `- ${line}`),
    ...(draft.anchors === undefined ? [] : [`Anchors: ${draft.anchors}`]),
    ...(draft.supersedes === undefined
      ? []
      : [`Supersedes: #${draft.supersedes.index} ${draft.supersedes.note}`]),
  ].join('\n');
}

const hasTag = (text: string): boolean => /<\/?[a-zA-Z][^>]*>/.test(text);

/**
 * 把模型對 {@link SUMMARY_ENTRY_INSTRUCTION} 的回覆讀成條目。認不得的行、超過上限、帶角括號標籤都算不成立，
 * **不截斷**：截斷的錨點是錯的錨點。「- 」行要在 `Anchors`／`Supersedes` 之前，這兩種行各至多一行。
 *
 * @param text - 模型的回覆。
 * @param earlierEntries - 已經有幾筆條目；`Supersedes` 指到的序號超出範圍時丟掉那一行，其餘照留。
 * @returns 條目內文；不成立回 `undefined`。
 */
export function parseEntryDraft(
  text: string,
  earlierEntries: number,
): SummaryEntryDraft | undefined {
  const rows = text
    .split('\n')
    .map((row) => row.trim())
    .filter((row) => row !== '');
  const first = rows[0];
  if (first === undefined || hasTag(text)) return undefined;
  const title = first
    .replace(/^#+\s*/, '')
    .replace(/^Title:\s*/i, '')
    .trim();
  if (title === '' || title.length > SUMMARY_ENTRY_LIMITS.title || title.startsWith('- '))
    return undefined;
  const lines: string[] = [];
  let anchors: string | undefined;
  let supersedes: SummaryEntryDraft['supersedes'];
  for (const row of rows.slice(1)) {
    const anchor = /^Anchors:\s*(.*)$/i.exec(row);
    const replaced = /^Supersedes:\s*#(\d+)\s*(.*)$/i.exec(row);
    if (anchor !== null) {
      if (anchors !== undefined || anchor[1]!.length > SUMMARY_ENTRY_LIMITS.anchors)
        return undefined;
      if (anchor[1] !== '') anchors = anchor[1]!;
    } else if (replaced !== null) {
      if (supersedes !== undefined || replaced[2]!.length > SUMMARY_ENTRY_LIMITS.supersedes)
        return undefined;
      const index = Number(replaced[1]);
      if (index >= 1 && index <= earlierEntries) supersedes = { index, note: replaced[2]! };
    } else if (row.startsWith('- ')) {
      const line = row.slice(2).trim();
      if (
        anchors !== undefined ||
        supersedes !== undefined ||
        line.length > SUMMARY_ENTRY_LIMITS.line ||
        lines.length >= SUMMARY_ENTRY_LIMITS.lines
      )
        return undefined;
      lines.push(line);
    } else return undefined;
  }
  return {
    title,
    lines,
    ...(anchors === undefined ? {} : { anchors }),
    ...(supersedes === undefined ? {} : { supersedes }),
  };
}
