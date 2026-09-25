/**
 * 工具卡展開之後的結果（[#601](https://github.com/DemianLi/nexus-agent/issues/601)）：畫不畫參數、結果畫哪一段。
 *
 * - **結果就是 `ToolEntry.text`**：模型收到的那一段，上限 50KB、頭尾各半由 harness 截（`tool-result-text.ts`）。
 *   純文字、自動換行、照 dsh 限高捲動（`ToolRow.module.css` 的 `max-height: 150px`）。
 * - **失敗時不畫**：`tool-finished` 失敗那種的 `text` 跟 `error` 是同一串字，紅字那一格已經畫了。
 * - **畫面上的行數上限**（登記的偏離，#601 決定 4）：dsh 只靠 CSS 限高，程式不截。但位元組上限擋不住幾千行的短行
 *   把渲染拖慢，所以超過 {@link OUTPUT_MAX_LINES} 行時取頭尾各半、中間一行講沒畫幾行。這是渲染上的選擇，
 *   不動模型看到什麼。
 *   **那一行不寫「全文在會話日誌」**（#620 改寫 #605 的理由）：落盤預設開著（#607），但部署設定關得掉（#613），
 *   這一端分不出來；而且網頁上也打不開日誌，指過去沒有出口。harness 截位元組時自己留的那句
 *   （`tool-result-text.ts`）是 harness 的字，不在這裡管。
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

/** 展開後只畫結果、不畫參數的工具。 */
const OUTPUT_ONLY: ReadonlySet<string> = new Set([
  'ls',
  'read_file',
  'glob',
  'grep',
  'write_file',
  'edit_file',
]);

/** 展開之後畫不畫參數。 */
export function showsInput(name: string): boolean {
  return !OUTPUT_ONLY.has(name);
}

/** 要畫的結果：`omitted` 是頭尾之間沒畫的行數，0 表示整段都在 `head`。 */
export interface ToolOutput {
  readonly head: string;
  readonly tail: string;
  readonly omitted: number;
}

/** 這張卡的結果；沒有結果文字、或失敗（紅字已經畫了）時沒有。 */
export function toolOutput(entry: ToolEntry): ToolOutput | undefined {
  if (entry.text === undefined || entry.text === '') return undefined;
  if (entry.status === 'failed' && entry.error !== undefined) return undefined;
  const lines = contentLines(entry.text);
  const { head, tail, hidden } = cappedRows(lines, OUTPUT_MAX_LINES);
  if (hidden === 0) return { head: entry.text, tail: '', omitted: 0 };
  return { head: head.join('\n'), tail: tail.join('\n'), omitted: hidden };
}
