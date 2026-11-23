/**
 * 工具卡怎麼呈現（規格 §4.2 列 14）：參數那一半。哪顆工具用哪種畫法、叫什麼標題在 `features/tool/tools.ts` 那張表，
 * 每一種畫法知道的事在 `features/tool/adapters.ts`；這裡把它們組成標題、收合那一行摘要與展開的參數，查不到的工具走通用卡。
 *
 * **這一份只管參數，不管輸出**：結果文字（`ToolEntry.text`）怎麼畫在 `shared/lib/tool-output.ts`，寫檔／改檔的 diff 在
 * `shared/lib/tool-diff.ts`（[#601](https://github.com/DemianLi/nexus-agent/issues/601)），讀檔卡與搜尋卡在
 * `features/tool/result-card.ts`（[#625](https://github.com/DemianLi/nexus-agent/issues/625)），選哪一種檢視在 adapter 的 `result`。
 *
 * **`execute` 還沒有終端卡**：dsh 有（`terminal-card-model.ts`，解析結果結尾的 exit code），但今天產品路徑上的
 * backend 都沒有 shell，基座不註冊 `execute`（`harness/apps/harness/src/base-tools.ts`）。sandbox backend 註冊它的那天要補
 * 終端卡；絆索在 harness：`harness/apps/harness/src/execute-not-bound.test.ts` 經產品組裝量模型實際綁到的工具，`execute` 一出現就紅
 * （#666，原本這裡有一組讀 harness 原始碼的，已搬走）。
 *
 * 新增工具與畫法的做法見 `features/tool/tools.ts` 檔頭。
 *
 * @module
 */

import type { ToolVariant } from '@/features/tool/adapter';
import { isKnown, rowOf, titleOf } from '@/features/tool/tools';

export type { ToolVariant };

export function classifyTool(name: string): ToolVariant {
  return rowOf(name).adapter.variant;
}

/** 這個工具名在表上有沒有明寫（`view.test.ts` 用它確認每個實際工具都在表上）。 */
export function isKnownTool(name: string): boolean {
  return isKnown(name);
}

/** 工具卡的標題（規則見 `tools.ts` 的 `titleOf`）。 */
export function toolTitle(name: string): string {
  return titleOf(name);
}

function parseArgs(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    // 參數不是 JSON（串流中途截斷、壞 JSON #281）：摘要與內容退回原字串。
    return undefined;
  }
}

/**
 * 收合那一行摘要最多留幾個字元。那一格靠 CSS 省略號截成一行，寬螢幕也只排得下一兩百字，
 * 但整串字都進了 DOM：一個 527KB 的單行參數就是 527KB 的文字要排版（#958）。
 */
export const SUMMARY_MAX_CHARS = 500;

/** 摘要用的第一行：多半是參數裡挑出來的字串，或失敗的錯誤文字；超過 {@link SUMMARY_MAX_CHARS} 的尾巴換成「…」。 */
function firstLine(text: string): string {
  const newline = text.indexOf('\n');
  const line = newline === -1 ? text : text.slice(0, newline);
  if (line.length <= SUMMARY_MAX_CHARS) return line;
  const end = isHighSurrogate(line.charCodeAt(SUMMARY_MAX_CHARS - 1))
    ? SUMMARY_MAX_CHARS - 1
    : SUMMARY_MAX_CHARS;
  return `${line.slice(0, end)}…`;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** 收合時那一行的摘要。表上有專屬摘要的先用它（`copy_file` 寫成「來源 → 目的」）；其餘照類別挑欄位，挑不到就拿第一個字串值，再不行就是參數原文的第一行。 */
export function toolSummary(name: string, input: string): string {
  const parsed = parseArgs(input);
  if (typeof parsed !== 'object' || parsed === null) return firstLine(input);
  const args = parsed as Record<string, unknown>;
  const row = rowOf(name);
  // 專屬摘要缺料時（例如 `copy_file` 少一個路徑）退到下面的通用挑法。
  const own = row.summary?.(args);
  if (own !== undefined) return firstLine(own);
  for (const key of row.adapter.summaryKeys) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') return firstLine(value);
  }
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value !== '') return firstLine(value);
  }
  return firstLine(input);
}

/**
 * 展開後參數最多畫幾個字元，多的收在中間（#958）。參數是 JSON 時整串字串值是一行（換行被跳脫成 `\\n`），
 * 位元組或行數的上限擋不住畫面。20,000 來自實測（headless Chrome、`serve` 假模型，527KB 的單筆參數，
 * 切開的兩塊畫純文字）：參數很小時點開約 49ms 是底；上限 10,000、20,000 時各種形狀都貼著底，最壞的不含空白連續中文
 * 20,000 時 79ms、沒有長任務；40,000 時同一形狀 385ms，80,000 時 800ms。跟結果的 `OUTPUT_MAX_CHARS` 同一個值。
 */
export const INPUT_MAX_CHARS = 20_000;

/** 展開後的參數：adapter 有專屬畫法的（`code` 類是那段程式、`bash` 類是那行指令）用它，其他是排好的 JSON（照 dsh `formatToolBody`）。 */
export function toolInputBody(
  name: string,
  input: string,
): { readonly text: string; readonly lang: string } | undefined {
  if (input === '') return undefined;
  const parsed = parseArgs(input);
  if (parsed === undefined) return { text: input, lang: 'text' };
  if (typeof parsed === 'object' && parsed !== null) {
    const own = rowOf(name).adapter.inputBody?.(parsed as Record<string, unknown>);
    if (own !== undefined) return own;
  }
  return { text: JSON.stringify(parsed, null, 2), lang: 'json' };
}

export { firstLine };
