/**
 * markdown 表格的數字欄（[#1330](https://github.com/DemianLi/nexus-agent/issues/1330)）：一欄裡有字的資料格全是數字時，
 * 畫面整欄套 `tabular-nums` 並靠右（`render.tsx` 的 `md-num`），位數對得齊、好比大小。
 *
 * **怎樣算數字**（{@link isNumericCell}）：
 * - 可以有正負號（`+`、`-`、U+2212 `−`）、千分位逗號（三位一組）、小數點、結尾一個 `%`。
 * - **貨幣符號算**：前綴 `$`、`NT$`、`US$`、`€`、`£`、`¥`、`￥`，符號後可以空一格。金額欄是查資料時最常見的數字欄，
 *   而符號在前、數字靠右照樣對得齊。
 * - **單位不算**（`12 天`、`3.5 GB`、`120 萬`）：單位常常一欄裡不一樣（MB 與 GB 混著），靠右對齊反而誤導大小；
 *   帶單位的欄維持原樣。
 * - 全形數字、日期（`2026-09-01`）、版本號不算。
 *
 * **怎樣算整欄**（{@link numericColumns}）：表頭不看；空格與佔位符（`-`、`—`、`–`、`N/A`）跳過，不讓一欄變成
 * 非數字；剩下的至少一格、而且全部是數字才算。只有表頭沒有資料列的表格每欄都不算。
 *
 * @module
 */

const NUMBER = /^[+\-−]?(?:NT\$|US\$|[$€£¥￥])?\s?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?%?$/u;

const PLACEHOLDERS = new Set(['', '-', '—', '–', 'N/A', 'n/a']);

/** 這一格（去掉頭尾空白後）是不是一個數字。 */
export function isNumericCell(text: string): boolean {
  const value = text.trim();
  return /\d/u.test(value) && NUMBER.test(value);
}

/**
 * 每一欄是不是數字欄。
 *
 * @param rows - 資料列（不含表頭）每一格的純文字；列比欄短的，少的格子當空。
 * @param columns - 欄數（表頭定的）。
 */
export function numericColumns(rows: readonly (readonly string[])[], columns: number): boolean[] {
  return Array.from({ length: columns }, (_, index) => {
    let numbers = 0;
    for (const row of rows) {
      const value = (row[index] ?? '').trim();
      if (PLACEHOLDERS.has(value)) continue;
      if (!isNumericCell(value)) return false;
      numbers += 1;
    }
    return numbers > 0;
  });
}
