/**
 * 工具卡展開之後的結果（[#601](https://github.com/DemianLi/nexus-agent/issues/601)）：畫不畫參數、結果畫哪一段。
 *
 * - **結果就是 `ToolEntry.text`**：模型收到的那一段，放上線時原樣不截（#736、#923 拿掉傳輸上的 50KB 截斷）。
 *   太大的由 harness 的外溢層按 token 預算換成頭尾預覽，所以走到網頁的大小隨內容形狀而變，從幾十 KB 到一兩 MB 都有。
 *   純文字、自動換行、照 dsh 限高捲動（`ToolRow.module.css` 的 `max-height: 150px`）。
 * - **失敗時不畫**：`tool-finished` 失敗那種的 `text` 跟 `error` 是同一串字，紅字那一格已經畫了。
 * - **畫面上的行數與字元上限**（登記的偏離，#601 決定 4、#950）：dsh 只靠 CSS 限高，程式不截。但傳輸上的
 *   上限擋不住畫面：幾千行的短行會把渲染拖慢，一行夾大量空白的超長單行也會（527KB 的「字」加 127 個空白，
 *   點開凍結約 0.45 秒）。所以超過 {@link OUTPUT_MAX_LINES} 行、或超過 {@link OUTPUT_MAX_CHARS} 字元時
 *   取頭尾各半、中間一行講沒畫多少。這是渲染上的選擇，不動模型看到什麼。
 *   **那一行不寫「全文在會話日誌」**（#620 改寫 #605 的理由）：落盤預設開著（#607），但部署設定關得掉（#613），
 *   這一端分不出來；而且網頁上也打不開日誌，指過去沒有出口。外溢預覽自己帶的那行路徑通知
 *   （`@nexus/core` 的 `spill-policy`）是 harness 那一側的字，不在這裡管。
 * - **單檔工具與搜尋只畫結果**（dsh `GenericToolCard` 的 `singleFile`，以及 read／search 有專屬卡的那幾個）：
 *   參數就是收著那一行的路徑或樣式，展開再畫一次 JSON 沒有資訊量。其他工具參數、結果都畫。
 *   結果帶 `meta` 時，讀檔、搜尋、改檔由專屬卡取代這一段（#625，`lib/tool-result-card.ts`、`lib/tool-diff.ts`）；
 *   這裡管的是沒有 `meta` 的那些：失敗、舊日誌、超過上限、grep 的非 content 模式。
 *
 * @module
 */

import type { ToolEntry } from '@nexus/wire';

import { cappedRows, contentLines } from '@/lib/tool-diff';

/** 結果最多畫幾行，多的收在中間。 */
export const OUTPUT_MAX_LINES = 200;

/**
 * 結果最多畫幾個字元（UTF-16 單位），多的收在中間。行數上限管不到一行超長的結果，這道管它。
 * 20,000 來自 #950 的實測（headless Chrome、真的結果卡的 `<pre>`）：塞進去到畫完，一般文字與「字＋127 空白」
 * 到 100,000 字元都在兩格畫面（約 33ms）之內；最壞的是不含空白的連續中文與裸旗 emoji（`wrap-anywhere`
 * 每個字元都是斷行點、旗子還會字型回退），30,000 字元分別 67ms、118ms，20,000 字元分別 48ms、67ms。
 */
export const OUTPUT_MAX_CHARS = 20_000;

/** 展開後只畫結果、不畫參數的工具。 */
const OUTPUT_ONLY: ReadonlySet<string> = new Set([
  'ls',
  'read_file',
  'glob',
  'grep',
  'write_file',
  'edit_file',
  'delete',
]);

/** 展開之後畫不畫參數。 */
export function showsInput(name: string): boolean {
  return !OUTPUT_ONLY.has(name);
}

/**
 * 要畫的結果：`omitted` 是頭尾之間沒畫的行數，`omittedChars` 是行數上限之後又被字元上限從頭那段尾端、
 * 尾那段開頭削掉的字元數；兩個都是 0 表示整段都在 `head`。
 */
export interface ToolOutput {
  readonly head: string;
  readonly tail: string;
  readonly omitted: number;
  readonly omittedChars: number;
}

/** 這張卡的結果；沒有結果文字、或失敗（紅字已經畫了）時沒有。 */
export function toolOutput(entry: ToolEntry): ToolOutput | undefined {
  if (entry.text === undefined || entry.text === '') return undefined;
  if (entry.status === 'failed' && entry.error !== undefined) return undefined;
  return outputOf(entry.text);
}

/** 一段結果文字照 {@link OUTPUT_MAX_LINES}、{@link OUTPUT_MAX_CHARS} 切。子代理撞到上限時寫到一半的那段也走這裡（#608）。 */
export function outputOf(text: string): ToolOutput {
  const lines = contentLines(text);
  const { head, tail, hidden } = cappedRows(lines, OUTPUT_MAX_LINES);
  if (hidden === 0) return capChars({ head: text, tail: '', omitted: 0, omittedChars: 0 });
  return capChars({
    head: head.join('\n'),
    tail: tail.join('\n'),
    omitted: hidden,
    omittedChars: 0,
  });
}

/** 頭尾兩段加起來超過 {@link OUTPUT_MAX_CHARS} 時再削：沒有被行數切過的整段一刀兩半，切過的各留一半額度。 */
function capChars(output: ToolOutput): ToolOutput {
  const { head, tail, omitted } = output;
  if (head.length + tail.length <= OUTPUT_MAX_CHARS) return output;
  const headLimit = Math.ceil(OUTPUT_MAX_CHARS / 2);
  const tailLimit = OUTPUT_MAX_CHARS - headLimit;
  // 沒被行數切過時整段都在 `head`、`tail` 是空的，頭尾都從同一段取。
  const tailSource = omitted === 0 ? head : tail;
  const newHead = head.slice(0, capHeadEnd(head, headLimit));
  const newTail = tailSource.slice(capTailStart(tailSource, tailLimit));
  const omittedChars = head.length + tail.length - newHead.length - newTail.length;
  return { head: newHead, tail: newTail, omitted, omittedChars };
}

/** 頭那段留到哪裡（不含）：不剖開代理對。 */
function capHeadEnd(text: string, limit: number): number {
  if (text.length <= limit) return text.length;
  return isHighSurrogate(text.charCodeAt(limit - 1)) ? limit - 1 : limit;
}

/** 尾那段從哪裡開始留：不剖開代理對。 */
function capTailStart(text: string, limit: number): number {
  if (text.length <= limit) return 0;
  const start = text.length - limit;
  return isLowSurrogate(text.charCodeAt(start)) ? start + 1 : start;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** 頭尾之間那一行說明；什麼都沒收起來時沒有。 */
export function omittedLabel(output: ToolOutput): string | undefined {
  const { omitted, omittedChars } = output;
  if (omitted === 0 && omittedChars === 0) return undefined;
  if (omittedChars === 0) return `⋯ 中間 ${omitted} 行沒畫 ⋯`;
  if (omitted === 0) return `⋯ 中間 ${omittedChars} 字沒畫 ⋯`;
  return `⋯ 中間 ${omitted} 行與 ${omittedChars} 字沒畫 ⋯`;
}
