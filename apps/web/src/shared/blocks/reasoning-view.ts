/**
 * 推理列要的幾個判斷（[#527](https://github.com/DemianLi/nexus-agent/issues/527)）。資料由 `@nexus/wire` 的
 * `AiEntry.reasoning` 帶來，即時與重新整理後同形狀（#562）；這裡只決定畫什麼。
 *
 * @module
 */

import type { AiEntry } from '@nexus/wire';

/** 這則要不要畫推理列：沒有推理、或推理只有空白，都當作沒有。 */
export function visibleReasoning(entry: AiEntry): string | undefined {
  const { reasoning } = entry;
  return reasoning === undefined || reasoning.trim() === '' ? undefined : reasoning;
}

/**
 * 推理還在長：這則還在吐字、正文還沒開始（只有空白不算開始）。正文一開始，推理就算講完了。
 *
 * 推理與正文在線上可能交錯（#527 量過 `text → reasoning → text`），交錯時正文已經開始，這裡照樣算講完。
 */
export function reasoningRunning(entry: AiEntry): boolean {
  return entry.streaming && entry.text.trim() === '';
}

/**
 * 收合時那一行（同 dsh 的 `ReasoningRow`）：串流中是最新一行，講完是第一行；拿掉 `**`。
 *
 * 跟 dsh 差一點：跳過空行。推理常以換行開頭，照 dsh 取第一行會得到空字串，摘要就是空的。
 *
 * 每來一顆 chunk 算一次，所以只找頭尾那一行，不切整串。
 */
export function reasoningSummary(text: string, running: boolean): string {
  let line: string;
  if (running) {
    const visible = text.trimEnd();
    line = visible.slice(visible.lastIndexOf('\n') + 1);
  } else {
    const visible = text.trimStart();
    const newline = visible.indexOf('\n');
    line = newline === -1 ? visible : visible.slice(0, newline);
  }
  return line.trim().replaceAll('**', '');
}
