/**
 * 把一條超長的行切成畫面上的幾段（[#555](https://github.com/DemianLi/nexus-agent/issues/555)）。
 *
 * `content-visibility` 只能跳過整塊，切不進一行：一行只能整行排版，成本跟著字元數走（單行 199 萬字、夾 5142 個
 * 裸 🏳，換行模式卡 1873ms）。所以超過 {@link LONG_LINE_CHARS} 字的行在畫面上切成約 {@link SEGMENT_CHARS} 字一段，
 * 每段各自一個 `content-visibility: auto` 的 inline-block，只有畫面裡的段才排版（同一條行切成 4000 字一段之後
 * 是 35ms；1000／16000 字一段是 65／21ms，差別不大）。
 *
 * **段是 inline-block，不是區塊**：實測區塊的段在複製時每段之間多一個換行，inline-block 不會（2026-09-23，
 * headless Chrome 的選取文字）。**段與段之間不加任何字元**，接起來就是原行。
 *
 * **切點**：換行模式下，一段的最後一列會提早結束（下一段從新的一列開始），所以切點盡量落在空白或標點後面，
 * 看起來只是一次提早換行；往回找 {@link LOOKBACK_CHARS} 字找不到（minified 的內容）才硬切。**不切在一個字素
 * 的中間**（代理對、組合字元、VS16、ZWJ 序列、旗子）——切開的話，一個 emoji 會畫成兩半。
 *
 * **不換行時一列最寬 2²⁵ px**（Chrome：單行 500 萬個 ASCII 字，捲到最右邊只看得到第 4,644,453 個字），所以超過
 * {@link ROW_CHARS} 字的行在不換行模式下每 {@link ROW_CHARS} 字折一列，見 {@link rowsOf}。
 *
 * @module
 */

/** 超過幾個字（UTF-16 code unit）才切。 */
export const LONG_LINE_CHARS = 4000;

/** 一段大約幾個字。 */
export const SEGMENT_CHARS = 4000;

/** 找空白或標點時，從段尾往回最多找幾個字。 */
export const LOOKBACK_CHARS = 200;

/** 不換行時一列最多幾個字：100 萬個全形字約 1440 萬 px，離 2²⁵ px 還有餘裕。 */
export const ROW_CHARS = 1_000_000;

/** 切在它後面看起來像一次正常的換行。 */
const SOFT_BREAK = /[\s,;:.!?)\]}>，。；：、！？）】」』]/u;

/** 往前後各看幾個字來找字素邊界：一個字素（例如家庭 emoji 加膚色）遠短於這個數。 */
const GRAPHEME_WINDOW = 64;

let graphemes: Intl.Segmenter | undefined;

/** 離 `at` 最近、不超過它、又大於 `floor` 的字素邊界；沒有就往後找第一個。 */
function graphemeBoundary(text: string, at: number, floor: number): number {
  graphemes ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const from = Math.max(floor, at - GRAPHEME_WINDOW);
  const slice = text.slice(from, at + GRAPHEME_WINDOW);
  let before = -1;
  let after = -1;
  for (const { index } of graphemes.segment(slice)) {
    const boundary = from + index;
    if (boundary <= floor) continue;
    if (boundary <= at) before = boundary;
    else {
      after = boundary;
      break;
    }
  }
  if (before !== -1) return before;
  return after !== -1 ? after : Math.min(text.length, at + GRAPHEME_WINDOW);
}

/** 下一段在哪裡結束。 */
function cutAfter(text: string, start: number): number {
  const end = start + SEGMENT_CHARS;
  if (end >= text.length) return text.length;
  for (let at = end; at > end - LOOKBACK_CHARS; at--) {
    if (SOFT_BREAK.test(text[at - 1]!)) return graphemeBoundary(text, at, start);
  }
  return graphemeBoundary(text, end, start);
}

/**
 * 一行在畫面上的段。不超過 {@link LONG_LINE_CHARS} 字的行原樣一段；接起來永遠等於原行。
 */
export function segmentsOf(text: string): string[] {
  if (text.length <= LONG_LINE_CHARS) return [text];
  const segments: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = cutAfter(text, start);
    segments.push(text.slice(start, end));
    start = end;
  }
  return segments;
}

/**
 * 一段文字在等寬字型下佔幾欄：全形（CJK、全形符號、韓文）與代理對（emoji、CJK 擴充）算 2，其他算 1。
 *
 * 只拿來估畫面外的尺寸（`styles/preview.css` 的 `--cols`）：用字數估的話，中文的寬度與換行後的列數都只估到
 * 一半，捲過去時捲軸會跳。不求精確——畫過一次之後就是真的尺寸。
 */
export function columnsOf(text: string): number {
  let columns = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      columns += 2;
      i += 1;
    } else if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
    ) {
      columns += 2;
    } else columns += 1;
  }
  return columns;
}

/**
 * 把段分成不換行模式下的列，每列不超過 {@link ROW_CHARS} 字（一段本身比它長時那一段自己一列）。只有一列時
 * 回一個元素的陣列。
 */
export function rowsOf(segments: readonly string[]): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let chars = 0;
  for (const segment of segments) {
    if (row.length > 0 && chars + segment.length > ROW_CHARS) {
      rows.push(row);
      row = [];
      chars = 0;
    }
    row.push(segment);
    chars += segment.length;
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

/** 一段，連同它的欄數（`styles/preview.css` 的 `--cols`）。 */
export interface Segment {
  readonly text: string;
  readonly columns: number;
}

/** 一行在畫面上的列與段，每段帶著欄數（{@link segmentsOf}＋{@link rowsOf}＋{@link columnsOf}）。 */
export function layoutOf(text: string): readonly (readonly Segment[])[] {
  return rowsOf(segmentsOf(text)).map((row) =>
    row.map((segment) => ({ text: segment, columns: columnsOf(segment) })),
  );
}
