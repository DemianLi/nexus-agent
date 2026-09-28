/*
 * 輸入框的 `@` 引用（[#653](https://github.com/DemianLi/nexus-agent/issues/653)）：觸發、選了之後怎麼改草稿、每一列寫什麼。
 * 照 dsh（`477b4f4`，MIT，Copyright (c) DeepSeek）：
 *
 * - 觸發照 `packages/context/file-reference/src/grammar.ts` 的 `activeAtToken`：`@` 只在字首或空白後面才算，
 *   所以 `a@b`、`user@host`、`(@x`、全形 `＠` 都不開。`@"` 開頭的引號形式可以跨空白。
 *   **先判 `@` 再判 `/`**（`ui-input-trigger/src/core/detect.ts`），`@/` 因此不會叫出斜線選單。
 * - 插入的文字照同檔的 `formatFileMention`：資料夾補結尾的 `/`；有空白就用 `@"…"`；路徑裡有雙引號或控制字元
 *   寫不回草稿，那一列不列。我們的路徑以 `/` 開頭（`@nexus/wire` 的 `file-references.ts`），所以是 `@/src/a.ts`。
 * - 選了之後照 `ui-reference/src/client/index.ts` 的 `onPick`：檔案、或資料夾按 Enter 是「選定」；資料夾按 Tab 是
 *   「往下鑽」，換上 `@/dir/`、選單留著。dsh 選定之後是一顆 chip，我們第一版不做 chip（#653 Q7），換成純文字加一個
 *   空白。引號形式的資料夾選定時把引號收掉，往下鑽時留著開口，讓下一層還打得進去（同 dsh）。
 * - 每一列照 `fileCandidate`：名字（資料夾加 `/`）加上父目錄，工作區根的東西沒有父目錄可寫。dsh 往下鑽之後在上方畫
 *   麵包屑、列裡就不再寫父目錄；我們第一版不畫麵包屑，父目錄一律寫。
 */

import type { FileReferenceCandidate } from '@nexus/wire';

export interface MentionHit {
  /** `@` 或 `@"` 之後、游標之前的那一段。 */
  readonly query: string;
  /** 使用者打的是 `@"`。 */
  readonly quoted: boolean;
  /** `@` 的位置。 */
  readonly start: number;
  /** 游標。 */
  readonly end: number;
}

/** 游標所在的 `@` 片段；沒有就是 null。 */
export function detectMention(draft: string, caret: number): MentionHit | null {
  const before = draft.slice(0, caret);
  const quoted = /(?:^|\s)(@"([^"]*))$/u.exec(before);
  if (quoted?.[1] !== undefined && quoted[2] !== undefined) {
    return { query: quoted[2], quoted: true, start: caret - quoted[1].length, end: caret };
  }
  const plain = /(?:^|\s)(@(\S*))$/u.exec(before);
  if (plain?.[1] === undefined || plain[2] === undefined) return null;
  return { query: plain[2], quoted: false, start: caret - plain[1].length, end: caret };
}

/**
 * 選了這一個之後插進草稿的字（不含結尾的空白）。寫不回草稿的回 `undefined`。
 *
 * @param keepOpen - 往下鑽：引號形式的資料夾留著開口。
 */
export function formatMention(
  candidate: FileReferenceCandidate,
  preserveQuote: boolean,
  keepOpen: boolean,
): string | undefined {
  const path = candidate.kind === 'directory' ? `${candidate.path}/` : candidate.path;
  // `\p{Cc}` 正好是 dsh 寫的 U+0000–U+001F 與 U+007F–U+009F 兩段。
  if (/[\p{Cc}"]/u.test(path)) return undefined;
  if (!preserveQuote && !/\s/u.test(path)) return `@${path}`;
  return keepOpen && candidate.kind === 'directory' ? `@"${path}` : `@"${path}"`;
}

export interface MentionPick {
  readonly draft: string;
  readonly caret: number;
  /** 選單還開著：往下鑽。 */
  readonly drill: boolean;
}

/**
 * 選了之後草稿變成什麼。
 *
 * @param action - `pick` 是選定（Enter、點一下、檔案按 Tab）；`drill` 是資料夾按 Tab 往下鑽。
 */
export function applyMentionPick(
  draft: string,
  hit: MentionHit,
  candidate: FileReferenceCandidate,
  action: 'pick' | 'drill',
): MentionPick | undefined {
  const drill = action === 'drill' && candidate.kind === 'directory';
  const mention = formatMention(candidate, hit.quoted, drill);
  if (mention === undefined) return undefined;
  const token = drill ? mention : `${mention} `;
  const before = draft.slice(0, hit.start);
  return {
    draft: before + token + draft.slice(hit.end),
    caret: before.length + token.length,
    drill,
  };
}

/** 選單上的一列。 */
export interface MentionRow {
  readonly candidate: FileReferenceCandidate;
  /** 名字；資料夾加 `/`。 */
  readonly name: string;
  /** 父目錄；工作區根的東西沒有。 */
  readonly parent?: string;
}

/** 候選換成選單上的列；寫不回草稿的不列。 */
export function mentionRows(
  candidates: readonly FileReferenceCandidate[],
  quoted: boolean,
): readonly MentionRow[] {
  return candidates.flatMap((candidate) => {
    if (formatMention(candidate, quoted, false) === undefined) return [];
    const slash = candidate.path.lastIndexOf('/');
    const name = `${candidate.path.slice(slash + 1)}${candidate.kind === 'directory' ? '/' : ''}`;
    const parent = slash <= 0 ? undefined : candidate.path.slice(0, slash);
    return [{ candidate, name, ...(parent === undefined ? {} : { parent }) }];
  });
}
