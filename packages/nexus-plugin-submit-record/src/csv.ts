/**
 * CSV 的兩件小事：切一行、組一行。**RFC 4180**，不是「用逗號 split」。
 *
 * 為什麼要真的實作而不是 split：欄名與值都由人打進來（`ask_user_question` 的自由作答），
 * 逗號、雙引號、換行三個字元隨時會出現。用 split 的失敗方式是**寫出去讀不回來**——
 * 而這條路的驗收句正是「讀檔驗內容」，所以那種壞法會直接讓驗收假綠：寫的時候沒人擋，
 * 讀的時候欄位對錯一格。
 *
 * **只做單行**。整份檔案的解析不做，因為這個工具只需要**表頭那一行**（拿來對欄名），
 * 其餘每一列原樣搬過去，一個字元都不動。
 *
 * @module
 */

/** 需要引號的三個字元。`\r` 也算——CRLF 的檔案切行時會留下它。 */
const NEEDS_QUOTES = /[",\r\n]/;

/**
 * 把一個欄位值變成 CSV 欄位。
 *
 * @param value - 原值。
 * @returns 必要時加引號並把內部的 `"` 變成 `""`。
 */
export function quoteCsvField(value: string): string {
  return NEEDS_QUOTES.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/**
 * 組一列。
 *
 * @param values - 依欄序的值。
 * @returns 一行 CSV，**不含行尾換行**。
 */
export function formatCsvRow(values: readonly string[]): string {
  return values.map(quoteCsvField).join(',');
}

/**
 * 切一行成欄位。
 *
 * **不處理跨行的引號欄位**：呼叫端只拿它切表頭，而表頭跨行是我們自己寫不出來的形狀
 * （欄名來自模型的 JSON 鍵）。真的遇到別人寫的那種檔案時，這裡會把它切成看起來合理
 * 但實際錯的欄名，然後在對欄名那一步被擋下來——**失敗方向是拒絕，不是靜靜寫歪**。
 *
 * @param line - 一行，不含行尾換行。
 * @returns 依序的欄位值。
 */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char !== '"') {
        field += char;
      } else if (line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = false;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}
