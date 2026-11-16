/**
 * 從會話日誌讀回被摘要遮掉的原文（[#2777](https://github.com/DemianLi/nexus-agent/issues/2777)）。
 *
 * 每一顆 `compaction/summary` 遮掉一段訊息。這個檔把日誌推回那幾段、渲染成逐字稿，給 `history_read`（分頁讀一段）與
 * `history_search`（在所有段落裡做字面比對）用。
 *
 * - 讀到的是**日誌裡記的那一則**：剪除與參數截斷只改送出去的樣子，這裡不套。被外溢層換過的工具結果在日誌裡就只有預覽，
 *   讀回的也是那份預覽。
 * - 一段的範圍從事件算，不看摘要索引上印的數字：迄點是那顆事件的 `cutoffIndex`，起點是同一個生命週期裡上一顆的
 *   `cutoffIndex`，沒有就是 0。`session/end-seed` 之後座標重設，上一顆不算。
 * - 同一步摘了兩次（送出去溢出、整串重摘）時兩顆事件帶同一個條目序號，後面那顆取代前面那顆。
 *
 * 全是純函式：輸入事件，輸出文字，不碰 I/O、不叫模型。
 *
 * @module
 */

import { ReplayFold, isEmptyAssistant } from './conversation-replay.js';
import type { UnreplayableReason } from './conversation-replay.js';
import { nexusContent, nexusToolCalls } from './nexus-message.js';
import type { NexusMessage } from './nexus-message.js';
import type { SessionEvent } from './session-log.js';
import { HISTORY_READ_TOOL_NAME, parseSummaryHead } from './summary-head.js';
import { summaryBodyOfText } from './summarizer-engine.js';

/** `history_read` 一頁至多幾個字元。 */
export const HISTORY_READ_PAGE_CHARS = 16_000;

/** `history_search` 沒給 `limit` 時回幾筆，以及 `limit` 的上限。 */
export const HISTORY_SEARCH_DEFAULT_LIMIT = 20;
export const HISTORY_SEARCH_MAX_LIMIT = 100;

/** 命中前後各帶幾個字元。 */
const SNIPPET_RADIUS = 80;

/** 一顆 `compaction/summary` 遮掉的那一段。 */
export interface RecallSegment {
  /** 那顆事件的 `seq`。 */
  readonly seq: number;
  /** 摘要索引裡對應的條目序號；那份摘要沒有索引就沒有。 */
  readonly entry?: number;
  /** 渲染好的逐字稿。 */
  readonly text: string;
}

/** 推出來的段落。`failure` 有值時，`segments` 只到推不下去的那顆事件之前。 */
export interface RecalledHistory {
  readonly segments: readonly RecallSegment[];
  readonly failure?: { readonly reason: UnreplayableReason; readonly seq: number };
}

function textOf(message: NexusMessage): string {
  const content = nexusContent(message);
  if (typeof content === 'string') return content;
  return content
    .flatMap((block) => {
      if (block.type === 'text' && typeof block.text === 'string') return [block.text];
      if (block.type === 'tool_call' || block.type === 'tool_use') return [];
      return [`[${block.type}]`];
    })
    .join('\n');
}

function isSummary(message: NexusMessage): boolean {
  return message.type === 'human' && message.data.additional_kwargs?.lc_source === 'summarization';
}

function renderMessage(message: NexusMessage): string | undefined {
  if (isSummary(message)) return '[prior summary]';
  if (isEmptyAssistant(message)) return undefined;
  const text = textOf(message);
  switch (message.type) {
    case 'human':
      return `User: ${text}`;
    case 'ai': {
      const calls = nexusToolCalls(message).map(
        (call) => `Tool call ${call.name}: ${JSON.stringify(call.args)}`,
      );
      return [...(text === '' ? [] : [`Assistant: ${text}`]), ...calls].join('\n');
    }
    case 'tool':
      return `Tool result${message.data.name === undefined ? '' : ` (${message.data.name})`}: ${text}`;
    case 'system':
      return `System: ${text}`;
    default:
      return `${message.type}: ${text}`;
  }
}

function renderMessages(messages: readonly NexusMessage[]): string {
  return messages.flatMap((message) => renderMessage(message) ?? []).join('\n\n');
}

function entriesOf(summary: NexusMessage): number {
  return parseSummaryHead(summaryBodyOfText(textOf(summary))).entries;
}

/**
 * @param events - 一份會話日誌的全部事件，照 `seq` 排。
 * @returns 每一顆生效的 `compaction/summary` 遮掉的那一段，照日誌順序。
 */
export function recallHistory(events: readonly SessionEvent[]): RecalledHistory {
  const fold = new ReplayFold({ readOnly: true });
  const segments: (RecallSegment & { readonly from: number })[] = [];
  // 這個生命週期裡上一顆摘要：切點，以及它在 `segments` 裡的位置。
  let previous: { readonly cutoff: number; readonly at: number } | undefined;
  for (const event of events) {
    if (event.type === 'session/end-seed') previous = undefined;
    if (event.type !== 'compaction/summary' || event.data.summary === undefined) {
      fold.feed(event);
      if (fold.failure !== undefined) return { segments, failure: fold.failure };
      continue;
    }
    const before = [...fold.raw, ...fold.pendingMessages()];
    fold.feed(event);
    if (fold.failure !== undefined) return { segments, failure: fold.failure };
    const entries = entriesOf(event.data.summary);
    const replaced =
      previous !== undefined && entries > 0 && segments[previous.at]?.entry === entries
        ? segments[previous.at]
        : undefined;
    const from = replaced?.from ?? previous?.cutoff ?? 0;
    const segment = {
      seq: event.seq,
      ...(entries > 0 ? { entry: entries } : {}),
      text: renderMessages(before.slice(from, event.data.cutoffIndex)),
      from,
    };
    if (replaced !== undefined && previous !== undefined) {
      segments[previous.at] = segment;
      previous = { cutoff: event.data.cutoffIndex, at: previous.at };
    } else {
      segments.push(segment);
      previous = { cutoff: event.data.cutoffIndex, at: segments.length - 1 };
    }
  }
  return { segments };
}

/** 工具回給模型的東西：`ok: false` 的 `content` 是原因。 */
export type RecallResult =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly content: string };

const labelOf = (segment: RecallSegment): string =>
  segment.entry === undefined ? `segment ${segment.seq}` : `entry #${segment.entry}`;

const addressOf = (segment: RecallSegment): string =>
  segment.entry === undefined ? `segment ${segment.seq}` : `entry ${segment.entry}`;

function unavailable(history: RecalledHistory): string {
  if (history.failure !== undefined) {
    return `The session log cannot be replayed past event ${history.failure.seq} (${history.failure.reason}), so the summarized messages after that point cannot be read back.`;
  }
  return 'Nothing in this conversation has been summarized yet: every message is still in context.';
}

function listing(history: RecalledHistory): string {
  return history.segments.map(labelOf).join(', ');
}

/** 找一段：`entry` 重複時取最後那一段，模型眼前那份索引是最後一顆摘要的，序號指的就是那一段。 */
function find(
  history: RecalledHistory,
  address: { readonly entry?: number; readonly segment?: number },
): RecallSegment | undefined {
  if (address.segment !== undefined) {
    return history.segments.find((segment) => segment.seq === address.segment);
  }
  return history.segments.findLast((segment) => segment.entry === address.entry);
}

/**
 * `history_read`：讀一段被摘掉的原文的一頁。
 *
 * @param events - 這次呼叫所屬的那份日誌的事件。
 * @param args - `entry`（摘要索引的序號）與 `segment`（搜尋結果給的事件序號）二選一；`offset` 是字元位移。
 * @returns 那一頁，結尾寫著下一頁的位移或「到底了」。
 */
export function historyRead(
  events: readonly SessionEvent[],
  args: { readonly entry?: number; readonly segment?: number; readonly offset?: number },
): RecallResult {
  if ((args.entry === undefined) === (args.segment === undefined)) {
    return { ok: false, content: 'Pass exactly one of "entry" or "segment".' };
  }
  const history = recallHistory(events);
  const segment = find(history, args);
  if (segment === undefined) {
    const which =
      args.entry === undefined ? `segment ${args.segment}` : `index entry #${args.entry}`;
    return {
      ok: false,
      content:
        history.segments.length === 0
          ? unavailable(history)
          : `No ${which}. Available: ${listing(history)}.${history.failure === undefined ? '' : ` ${unavailable(history)}`}`,
    };
  }
  const offset = args.offset ?? 0;
  const total = segment.text.length;
  if (offset >= total && total > 0) {
    return {
      ok: false,
      content: `Offset ${offset} is past the end of ${labelOf(segment)} (${total} characters).`,
    };
  }
  const end = Math.min(total, offset + HISTORY_READ_PAGE_CHARS);
  const footer =
    end < total
      ? `[more: call ${HISTORY_READ_TOOL_NAME} with ${addressOf(segment)}, offset ${end}]`
      : `[end of ${labelOf(segment)}]`;
  return {
    ok: true,
    content: `[${labelOf(segment)}, characters ${offset}-${end} of ${total}]\n${segment.text.slice(offset, end)}\n${footer}`,
  };
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `history_search`：在被摘掉的原文裡做不分大小寫的字面比對。
 *
 * @param events - 這次呼叫所屬的那份日誌的事件。
 * @param args - `query` 是要找的字串；`entry`／`segment` 把範圍限在一段；`limit` 是至多回幾筆。
 * @returns 每個命中的位置（可直接當 `history_read` 的 `offset`）與前後文。前後文照原文的行分行，每行縮兩格、行內連續空白併成一個、空行不印。
 */
export function historySearch(
  events: readonly SessionEvent[],
  args: {
    readonly query: string;
    readonly entry?: number;
    readonly segment?: number;
    readonly limit?: number;
  },
): RecallResult {
  if (args.query === '') return { ok: false, content: '"query" must not be empty.' };
  if (args.entry !== undefined && args.segment !== undefined) {
    return { ok: false, content: 'Pass at most one of "entry" or "segment".' };
  }
  const history = recallHistory(events);
  if (history.segments.length === 0) return { ok: false, content: unavailable(history) };
  let scope = history.segments;
  if (args.entry !== undefined || args.segment !== undefined) {
    const only = find(history, args);
    if (only === undefined) {
      const which =
        args.entry === undefined ? `segment ${args.segment}` : `index entry #${args.entry}`;
      return { ok: false, content: `No ${which}. Available: ${listing(history)}.` };
    }
    scope = [only];
  }
  const limit = Math.min(args.limit ?? HISTORY_SEARCH_DEFAULT_LIMIT, HISTORY_SEARCH_MAX_LIMIT);
  const pattern = new RegExp(escapeRegExp(args.query), 'giu');
  const hits: string[] = [];
  let matched = 0;
  for (const segment of scope) {
    for (const match of segment.text.matchAll(pattern)) {
      matched += 1;
      if (hits.length >= limit) continue;
      const start = Math.max(0, match.index - SNIPPET_RADIUS);
      const end = Math.min(segment.text.length, match.index + match[0].length + SNIPPET_RADIUS);
      // 換行留著：原文一行一筆（表格、清單、日誌）時，併成一行會分不出命中的那個字屬於哪一筆。
      const snippet = segment.text
        .slice(start, end)
        .replace(/[^\S\n]+/g, ' ')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .join('\n  ');
      hits.push(
        `- ${addressOf(segment)}, offset ${match.index}:\n  ${start > 0 ? '…' : ''}${snippet}${end < segment.text.length ? '…' : ''}`,
      );
    }
  }
  const quoted = JSON.stringify(args.query);
  const scanned = `${scope.length} summarized segment${scope.length === 1 ? '' : 's'}`;
  const gap = history.failure === undefined ? '' : `\n${unavailable(history)}`;
  if (matched === 0) {
    return {
      ok: true,
      content: `No matches for ${quoted} in ${scanned}. This is a literal, case-insensitive match: try a shorter or differently spelled string, or read an entry with ${HISTORY_READ_TOOL_NAME}.${gap}`,
    };
  }
  const shown = matched > hits.length ? `, showing the first ${hits.length}` : '';
  return {
    ok: true,
    content: `${matched} match${matched === 1 ? '' : 'es'} for ${quoted} in ${scanned}${shown}. Read around a match with ${HISTORY_READ_TOOL_NAME} (same entry or segment, offset from the match).\n${hits.join('\n')}${gap}`,
  };
}
