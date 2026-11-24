/**
 * 表格格子裡的中文：短值整格不斷行、長描述給最小寬度（[#1332](https://github.com/DemianLi/nexus-agent/issues/1332)）。
 *
 * 中文字與字之間都能換行，所以中文欄的最小寬度只有一個字。表格比框寬時瀏覽器照最小寬度排，「王小明」就被拆成一字一行，
 * 長描述被擠成一行兩三個字。這裡分兩種（`render.tsx` 掛 class，樣式在 `styles/markdown.css`）：
 *
 * - **短值**（`md-cjk-short`）：含中日文字、不超過 {@link CJK_SHORT_MAX} 個字（人名、部門、狀態）→ 整格不斷行。
 * - **長描述**（`md-cjk-prose`）：含中日文字、超過的 → 給最小寬度，照常換行，一行約八九個字。
 * - **其他不管**：沒有中日文字的（數字、英文、網址）維持 #1330 的 `break-word`。
 *
 * 字數照 code point 算、連續空白當一格；看的是整格的字（`plain-text.ts` 的 `inlineText`），不分中英。
 *
 * @module
 */

/** 幾個字以內算短值。 */
export const CJK_SHORT_MAX = 6;

export type CjkCellFit = 'short' | 'prose';

/** 漢字與日文假名：字與字之間都能換行的那幾種。 */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** 這一格是短中文值、長中文描述，還是都不是（`undefined`）。 */
export function cjkCellFit(text: string): CjkCellFit | undefined {
  const value = text.trim().replace(/\s+/gu, ' ');
  if (!CJK.test(value)) return undefined;
  return [...value].length <= CJK_SHORT_MAX ? 'short' : 'prose';
}
