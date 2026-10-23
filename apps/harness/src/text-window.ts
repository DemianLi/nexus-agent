/**
 * 逐 chunk 掃一份文字，建出一頁（[#1530](https://github.com/DemianLi/nexus-agent/issues/1530)）：選到的行、總行數、有沒有被位元組
 * 上限截掉，全程只留下那一頁，不論檔案多大。
 *
 * 照 dsh 的 `buildWindow`（`packages/fs/tool-fs/src/read-render.ts:111-144`，master `687f282e`）：
 *
 * - **單行緩衝只留 `maxLineLength + 1` 個字元**：多一個字元就足以證明這一行超長，所以沒有換行的巨行也不會讓記憶體失控。
 *   選到的行截到 `maxLineLength`，後面接 `... (line truncated to N chars)`。
 * - 選到的行累計超過 `maxBytes` 就停止收集、標 `cappedByBytes`，但**照樣掃到檔尾**拿精確的總行數。位元組算法同 `lineByteSize`：
 *   每行（截斷後、含後綴）的 UTF-8 位元組，非第一行再加一個換行。
 * - chunk 的邊界沒有意義：換行可以在任何地方。
 *
 * **行尾的 `\r` 去掉**（{@link WindowParams.stripCarriageReturn}，`read_file` 裡才開；照 dsh `read-render.ts:91-93` 的 `stripCarriageReturn`，
 * [#1563](https://github.com/DemianLi/nexus-agent/issues/1563) N0335）：`edit` 現在對行尾做正規化（`contained-backend.ts`），模型照讀到的內容寫
 * `old_string` 就對得上，不必再為了它保留 `\r`。判行長在去掉之後（`maxLineLength` 個字元的 CRLF 行不會被標截斷，#1776）。不在 `read_file` 裡的
 * 呼叫（摘要器、`agent-instructions` 的 `discover`、直接呼叫）維持基座的切片語意，`\r` 原樣。**開頭的 BOM 仍保留**（`utf8-stream.ts`）。
 *
 * 另外多回三樣 dsh 的 `WindowResult` 沒有、基座的 `read` 語意要的東西：換行的個數（`Line offset N exceeds file length (M lines)` 的 M 是
 * 換行數加 1）、檔案是不是以換行結尾（頁到檔尾時結尾那個換行要留著，與基座切片一致）、有沒有看過非空白字元（基座對空檔與全空白的檔回
 * 一句提醒，要在掃描途中記，不能事後 `trim` 整份）。
 *
 * @module
 */

/** 要建的頁。 */
export interface WindowParams {
  /** 從第幾行起，0 起算（同基座的 `offset`）。 */
  readonly offset: number;
  /** 最多幾行。 */
  readonly limit: number;
  /** 一行最多幾個字元；`Infinity` 是不截行。 */
  readonly maxLineLength: number;
  /** 選到的行累計最多幾個位元組；`Infinity` 是不設上限。 */
  readonly maxBytes: number;
  /** 行尾的 `\r` 去掉（CRLF 檔的每一行）；省略是不去掉，維持基座的切片語意。 */
  readonly stripCarriageReturn?: boolean;
}

/** {@link scanWindow} 的結果。 */
export interface WindowScan {
  /** 選到的行（已截斷，不含換行）。 */
  readonly lines: readonly string[];
  /** 因為位元組上限少收了行（`limit` 與檔尾都還沒到）。 */
  readonly cappedByBytes: boolean;
  /** 整份文字有幾個 `\n`。 */
  readonly newlines: number;
  /** 總行數：最後一行後面的換行不算一行，同基座的編號與 dsh。 */
  readonly totalLines: number;
  /** 文字非空、而且最後一個字元是 `\n`。 */
  readonly endsWithNewline: boolean;
  /** 有沒有任何一個 `trim()` 不會去掉的字元。 */
  readonly hasNonBlank: boolean;
}

/** 中止時丟的錯；呼叫端認 `name`。 */
export class ScanAborted extends Error {
  constructor() {
    super('read aborted');
    this.name = 'ScanAborted';
  }
}

/** `trim()` 去掉的字元之外的任何一個。 */
const NON_BLANK = /\S/u;

/**
 * 掃一份文字，建出一頁。
 *
 * @param chunks - 解碼過的文字片段，依檔案順序；片段的邊界沒有意義。
 * @param params - 要建的頁。
 * @param options.onChunk - 每一片掃之前叫一次（給版本雜湊餵整份文字）。
 * @param options.signal - 中止就丟 {@link ScanAborted}。
 */
export async function scanWindow(
  chunks: AsyncIterable<string> | Iterable<string>,
  params: WindowParams,
  options: { readonly onChunk?: (chunk: string) => void; readonly signal?: AbortSignal } = {},
): Promise<WindowScan> {
  const { offset, limit, maxLineLength, maxBytes, stripCarriageReturn = false } = params;
  // 多留一個字元就足以證明這一行超長。
  const lineBufferCap = maxLineLength + 1;
  const lines: string[] = [];
  let cappedByBytes = false;
  let outputBytes = 0;
  let newlines = 0;
  let totalLines = 0;
  let hasNonBlank = false;
  let lastChar = '';
  /** 這一行有沒有任何字元（最後一行沒有換行收尾時，靠它決定要不要算一行）。 */
  let lineHasChars = false;
  let buffer = '';
  /** 這一行有沒有因為緩衝滿了而丟掉字元（丟掉了就一定超長，不必再看緩衝尾巴是不是 `\r`）。 */
  let lineDropped = false;
  /** 這一行要不要收進頁裡：行號在 offset 之後、頁還沒滿、沒被位元組上限截掉。 */
  let collecting = limit > 0 && offset <= 0;

  const append = (segment: string): void => {
    if (segment.length === 0) return;
    lineHasChars = true;
    if (!collecting) return;
    if (buffer.length >= lineBufferCap) {
      lineDropped = true;
      return;
    }
    buffer += segment;
    if (buffer.length > lineBufferCap) {
      buffer = buffer.slice(0, lineBufferCap);
      lineDropped = true;
    }
  };

  const endLine = (): void => {
    totalLines += 1;
    if (collecting) {
      // 去 `\r` 在判長度之前（#1776，照 dsh 先去掉才判）：CRLF 檔裡剛好 `maxLineLength` 個字元的行不該被標截斷。
      // 緩衝丟過字元的一行一定超長，那時緩衝尾巴是不是 `\r` 不作數。不去 `\r` 的呼叫（基座切片語意）判長度時仍不算它。
      const crlf = buffer.endsWith('\r');
      const line = stripCarriageReturn && crlf && !lineDropped ? buffer.slice(0, -1) : buffer;
      const contentLength = line.length - (crlf && !stripCarriageReturn ? 1 : 0);
      const text =
        lineDropped || contentLength > maxLineLength
          ? `${line.substring(0, maxLineLength)}... (line truncated to ${maxLineLength} chars)`
          : line;
      const bytes = Buffer.byteLength(text, 'utf8') + (lines.length > 0 ? 1 : 0);
      if (outputBytes + bytes > maxBytes) {
        cappedByBytes = true;
      } else {
        outputBytes += bytes;
        lines.push(text);
      }
    }
    buffer = '';
    lineDropped = false;
    lineHasChars = false;
    collecting = !cappedByBytes && totalLines >= offset && lines.length < limit;
  };

  for await (const chunk of chunks) {
    if (options.signal?.aborted === true) throw new ScanAborted();
    if (chunk.length === 0) continue;
    options.onChunk?.(chunk);
    if (!hasNonBlank && NON_BLANK.test(chunk)) hasNonBlank = true;
    lastChar = chunk.charAt(chunk.length - 1);
    let start = 0;
    for (let at = chunk.indexOf('\n', start); at !== -1; at = chunk.indexOf('\n', start)) {
      append(chunk.slice(start, at));
      endLine();
      newlines += 1;
      start = at + 1;
    }
    append(chunk.slice(start));
  }
  if (options.signal?.aborted === true) throw new ScanAborted();
  if (lineHasChars) endLine();
  return {
    lines,
    cappedByBytes,
    newlines,
    totalLines,
    endsWithNewline: lastChar === '\n',
    hasNonBlank,
  };
}

/** {@link pageOf} 的結果。 */
export type PageOutcome =
  /** 空檔或全是空白：基座回一句提醒，不回內容。 */
  | { readonly kind: 'blank' }
  /** `offset` 超出檔案：`splitLength` 是換行數加 1，基座錯誤句子裡的「N lines」。 */
  | { readonly kind: 'beyond'; readonly splitLength: number }
  | {
      readonly kind: 'page';
      /** 選到的行用 `\n` 接起來；頁到檔尾、檔案以換行結尾時結尾的換行留著（同基座的切片）。 */
      readonly content: string;
      readonly extent: {
        readonly offset: number;
        readonly shown: number;
        readonly total: number;
        readonly cappedByBytes: boolean;
      };
    };

/**
 * 把 {@link scanWindow} 的結果組成基座 `read` 的語意：先判空（基座對空檔與全空白的檔回提醒，在判 offset 之前），再判 offset 超出
 * （`lines.length` 是 `split('\n')` 的長度，也就是換行數加 1），最後才是那一頁。
 *
 * 頁到了檔尾、而且檔案以換行結尾：結尾那個換行留著——基座的 `lines.slice(offset, offset + limit).join('\n')` 在 `limit` 夠大時含最後那個
 * 空字串，所以結果以 `\n` 收尾。位元組上限截掉的那一頁沒有。
 */
export function pageOf(scan: WindowScan, params: WindowParams): PageOutcome {
  if (!scan.hasNonBlank) return { kind: 'blank' };
  const splitLength = scan.newlines + 1;
  if (params.offset >= splitLength) return { kind: 'beyond', splitLength };
  const remaining = scan.totalLines - params.offset;
  const keepFinalNewline =
    !scan.cappedByBytes &&
    scan.endsWithNewline &&
    scan.lines.length > 0 &&
    params.limit > remaining;
  return {
    kind: 'page',
    content: `${scan.lines.join('\n')}${keepFinalNewline ? '\n' : ''}`,
    extent: {
      offset: params.offset,
      shown: scan.lines.length,
      total: scan.totalLines,
      cappedByBytes: scan.cappedByBytes,
    },
  };
}
