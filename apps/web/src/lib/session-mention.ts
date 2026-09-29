/*
 * `@` 引用別的會話（[#713](https://github.com/DemianLi/nexus-agent/issues/713)）在畫面上的規則：選單的列、
 * 選了之後草稿變成什麼、送出之後的泡泡怎麼畫。
 *
 * 引用文字的編碼與候選的形狀是 `@nexus/wire` 的（`session-references.ts`），這裡只管畫面：
 *
 * - **插進草稿的字是伺服器編好的 `mention`，原樣插**（Q2：第一版不做標籤）。選定就是「換掉 `@` 那一段、補一個空白」，
 *   沒有往下鑽。送出、排隊、重新編輯都照原樣走，所以草稿與編輯框裡看到的是完整的 `@[標題](nexus-session:…)`。
 * - **還沒被領走的話仍是原文**（`inbox` 的 `items`、`nextStep`）：停靠列的預覽、待送插話泡泡要顯示時走
 *   {@link mentionDisplayText}，把引用換成 `@標題`，不然畫面上會露出一長串 base64。被領走之後伺服器已經換成 `@標題`，
 *   並帶 `references`（{@link referenceSegments}）。
 * - **能不能點**看清單（Q3）：清單只列這台 server 同工作目錄、切得過去的主會話，所以「在清單上」就是「同專案的主會話」。
 *   別的專案、子代理、清單上還沒有的，只顯示、不能點。
 */

import { parseSessionReferenceText } from '@nexus/wire';
import type { SessionReferenceCandidate, WireSessionReference } from '@nexus/wire';

import type { MentionHit } from '@/lib/file-mention';

/** 選單上的一列會話或子代理。 */
export interface SessionMentionRow {
  readonly source: 'session' | 'subagent';
  readonly candidate: SessionReferenceCandidate;
  /** 標題（沒有標題時伺服器已經退成 id）。 */
  readonly name: string;
  /** 補在標題後面的小字：別的專案寫目錄名，子代理寫它屬於哪條會話。沒有就不畫。 */
  readonly hint?: string;
}

/** 路徑的最後一段；`/` 結尾也算。 */
function directoryName(cwd: string): string {
  const parts = cwd.split(/[\\/]/u).filter((part) => part !== '');
  return parts.at(-1) ?? cwd;
}

/**
 * 候選換成選單上的列，照伺服器給的先後（同工作區的已排在前）。有 `parentSessionId` 的是子代理（Q4），列上寫它屬於
 * 哪條會話——**用 `parentLabel`，不畫 id**。別的專案的主會話後面加目錄名，同專案的什麼都不加。
 */
export function sessionRows(
  candidates: readonly SessionReferenceCandidate[],
): readonly SessionMentionRow[] {
  return candidates.map((candidate) => {
    if (candidate.parentSessionId !== undefined) {
      const owner = candidate.parentLabel ?? candidate.parentSessionId;
      return { source: 'subagent', candidate, name: candidate.label, hint: `屬於 ${owner}` };
    }
    const hint =
      !candidate.sameWorkspace && candidate.cwd !== undefined
        ? directoryName(candidate.cwd)
        : undefined;
    return {
      source: 'session',
      candidate,
      name: candidate.label,
      ...(hint === undefined ? {} : { hint }),
    };
  });
}

export interface SessionMentionPick {
  readonly draft: string;
  readonly caret: number;
}

/** 選了一條會話：`@` 那一段換成伺服器編好的引用文字，後面補一個空白。 */
export function applySessionPick(
  draft: string,
  hit: MentionHit,
  candidate: SessionReferenceCandidate,
): SessionMentionPick {
  const token = `${candidate.mention} `;
  const before = draft.slice(0, hit.start);
  return { draft: before + token + draft.slice(hit.end), caret: before.length + token.length };
}

/**
 * 顯示用的文字：引用換成 `@標題`。引用長得不對（伺服器會拒絕的那種）就照原文畫——畫面不替它下判斷。
 *
 * 只給**不需要原文**的地方用（預覽、標籤、泡泡）。編輯框永遠拿原文。
 */
export function mentionDisplayText(text: string): string {
  if (!text.includes('nexus-session:')) return text;
  try {
    return parseSessionReferenceText(text).text;
  } catch {
    return text;
  }
}

export type TextSegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'reference'; readonly text: string; readonly reference: WireSessionReference };

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * 把被領走的人話切成一般文字與引用。`text` 裡每一段引用是 `@<label>`（`references` 去了重、照先後）。
 *
 * 同一個標題出現幾次就切幾段；一個標題是另一個的開頭時，長的先比（不然 `@foo bar` 會被切成 `@foo` 加 ` bar`）。
 * 沒有引用、或文字裡找不到，就整段是一般文字。
 */
export function referenceSegments(
  text: string,
  references: readonly WireSessionReference[] | undefined,
): readonly TextSegment[] {
  if (references === undefined || references.length === 0) return [{ kind: 'text', text }];
  const byLabel = new Map<string, WireSessionReference>();
  for (const reference of references) {
    if (reference.label !== '' && !byLabel.has(reference.label)) {
      byLabel.set(reference.label, reference);
    }
  }
  if (byLabel.size === 0) return [{ kind: 'text', text }];
  const labels = [...byLabel.keys()].sort((left, right) => right.length - left.length);
  const pattern = new RegExp(`@(${labels.map(escapeRegExp).join('|')})`, 'gu');
  const segments: TextSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const reference = byLabel.get(match[1] ?? '');
    if (reference === undefined) continue;
    if (match.index > last) segments.push({ kind: 'text', text: text.slice(last, match.index) });
    segments.push({ kind: 'reference', text: match[0], reference });
    last = match.index + match[0].length;
  }
  if (last < text.length) segments.push({ kind: 'text', text: text.slice(last) });
  return segments.length === 0 ? [{ kind: 'text', text }] : segments;
}
