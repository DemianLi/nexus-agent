/**
 * 側欄按內容搜以前的會話（[#760](https://github.com/DemianLi/nexus-agent/issues/760)，後端是 #631 的 `searchThreads`）。
 * 照 dsh（`477b4f4`，MIT，Copyright (c) DeepSeek）的 `ui-workspace`：
 *
 * - **查詢**照 `WorkspaceBrowser.tsx` 的 `sanitizeSearchQuery`：拿掉 NUL、最多 500 個 UTF-16 單位、不切開代理對；去頭尾後是
 *   空的就不問。線上的三種不合法都在送出前擋掉。
 * - **打完停 250ms 才問**（`SEARCH_DEBOUNCE_MS`），下一個字一到就取消上一次。
 * - **合併**照 `tree.ts` 的 `deriveSearchResults`：標題對得上的在前（由新到舊），只有內容對得上的照伺服器排的順序接在後面；
 *   兩邊都有的那一列掛上片段。內容命中但不在清單上（空白、別條空白、清單上沒有）的不列。合起來最多
 *   {@link THREAD_SEARCH_RESULT_LIMIT} 列，多的由 `hasMore` 講。
 * - **被拒或失敗就退回只比標題**，照 `WorkspaceBrowser.tsx:1114-1121`：那時的畫面就是 #610 的樣子，**不套 20 列的上限**
 *   （`filterThreads`）。被拒不記住：`rejected` 分不出是沒開、不合法還是搜尋失敗。
 *
 * 版面（分組、片段、標亮）是 web 的 UI/UX，不照 dsh：dsh 搜尋時換成一份不分組的清單，我們保留 #610 的分組，退回只比標題時
 * 才跟 #610 一模一樣。dsh 的片段不標亮，我們標。
 *
 * @module
 */

import { THREAD_SEARCH_QUERY_MAX_LENGTH, THREAD_SEARCH_RESULT_LIMIT } from '@nexus/wire';
import type { ThreadSearchItem, ThreadSummary } from '@nexus/wire';

import { filterThreads } from '@/lib/thread-groups';

/** 最後一個字之後等多久才問伺服器，同 dsh。 */
export const SEARCH_DEBOUNCE_MS = 250;

/** 搜尋框的字：拿掉 NUL、截在線上的長度上限，截的地方不切開一對代理字元。 */
export function sanitizeSearchQuery(value: string): string {
  const withoutNul = value.replaceAll('\0', '');
  if (withoutNul.length <= THREAD_SEARCH_QUERY_MAX_LENGTH) return withoutNul;
  let end = THREAD_SEARCH_QUERY_MAX_LENGTH;
  const last = withoutNul.charCodeAt(end - 1);
  const next = withoutNul.charCodeAt(end);
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  return withoutNul.slice(0, end);
}

/** 伺服器回來的內容命中。 */
export interface ContentMatches {
  readonly items: readonly ThreadSearchItem[];
  readonly hasMore: boolean;
}

export interface ThreadSearchView {
  /** 要畫的列，順序見檔頭。 */
  readonly items: readonly ThreadSummary[];
  /** 有內容命中的列的片段。 */
  readonly snippets: ReadonlyMap<string, string>;
  readonly hasMore: boolean;
}

/**
 * 搜尋框有字時要畫哪些列。
 *
 * @param visible - 側欄上看得到的列（已經藏過別條空白的），由新到舊。
 * @param content - 伺服器的內容命中；`undefined` 是沒有（還沒回來、沒開、失敗），只比標題。
 */
export function mergeThreadSearch(
  visible: readonly ThreadSummary[],
  query: string,
  content: ContentMatches | undefined,
): ThreadSearchView {
  const local = filterThreads(visible, query);
  if (content === undefined) return { items: local, snippets: new Map(), hasMore: false };
  const byId = new Map(visible.map((item) => [item.threadId, item]));
  const ordered = [...local];
  const included = new Set(local.map((item) => item.threadId));
  const snippets = new Map<string, string>();
  for (const hit of content.items) {
    const item = byId.get(hit.threadId);
    if (item === undefined || item.blank) continue;
    if (!snippets.has(hit.threadId)) snippets.set(hit.threadId, hit.snippet);
    if (included.has(hit.threadId)) continue;
    included.add(hit.threadId);
    ordered.push(item);
  }
  return {
    items: ordered.slice(0, THREAD_SEARCH_RESULT_LIMIT),
    snippets,
    hasMore: content.hasMore || ordered.length > THREAD_SEARCH_RESULT_LIMIT,
  };
}

/** 一段字切成命中與沒命中的幾塊；`hit` 為 true 的那幾塊要標亮。 */
export interface HighlightPart {
  readonly text: string;
  readonly hit: boolean;
}

/**
 * 把查詢在片段裡標出來。伺服器比的是子字串、英文不分大小寫、連續的空白算一個（`THREAD_SEARCH_PATH`），這裡照同一個規矩找，
 * 直接在原字串上配，不拿轉過小寫的位置去切（有些字轉小寫之後長度會變）。
 */
export function highlightMatches(text: string, query: string): readonly HighlightPart[] {
  const words = query
    .trim()
    .split(/\s+/u)
    .filter((word) => word !== '');
  if (words.length === 0) return [{ text, hit: false }];
  const pattern = new RegExp(
    words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('\\s+'),
    'giu',
  );
  const parts: HighlightPart[] = [];
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    if (match[0] === '') continue;
    if (match.index > at) parts.push({ text: text.slice(at, match.index), hit: false });
    parts.push({ text: match[0], hit: true });
    at = match.index + match[0].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return parts;
}
