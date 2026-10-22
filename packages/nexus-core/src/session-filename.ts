/**
 * 一份會話落盤的檔名，**只在這裡定義**（[#1857](https://github.com/DemianLi/nexus-agent/issues/1857)，#1594 拆刀 ①）。
 *
 * 照 dsh `packages/session/session-format/src/filename.ts:14-31`（`sessionFormatLogFilename`／
 * `parseSessionFormatLogFilename`，SHA `687f282e`）：檔名的規則跟版本目錄放在同一個格式層，持久化後端與離線讀方都 import
 * 這一份，不各自拼。這裡跟著版本目錄（`session-format.ts`）放在 `@nexus/core`，位置等價。
 *
 * 一份會話三個檔並排：`<base>.header.json`、`<base>.jsonl`、`<base>.lock`。`base` 由後端從 session id 算出來
 * （`apps/harness` 的 `safeBaseName`），不歸這裡。
 *
 * **兩檔佈局是過渡**：dsh 是一個會話目錄、header 在日誌第一行、檔名帶世代版本。寫方切到世代檔（#1594 ③）時換掉這一份，
 * 讀方因為都經過這裡，不必跟著逐處改。
 *
 * @module
 */

const HEADER_SUFFIX = '.header.json';
const LOG_SUFFIX = '.jsonl';
const LOCK_SUFFIX = '.lock';

/** 一份會話的三個檔名（不含目錄）。 */
export interface SessionFilenames {
  /** header：一個 JSON 物件，「這份會話存在」的提交點。 */
  readonly header: string;
  /** 日誌本文：一行一筆事件。 */
  readonly log: string;
  /** 寫租約的鎖檔。 */
  readonly lock: string;
}

/**
 * 由檔名基底給出一份會話的三個檔名。
 *
 * @param base - 檔名基底（後端的 `safeBaseName` 算出來的）。
 */
export function sessionFilenames(base: string): SessionFilenames {
  return {
    header: `${base}${HEADER_SUFFIX}`,
    log: `${base}${LOG_SUFFIX}`,
    lock: `${base}${LOCK_SUFFIX}`,
  };
}

/**
 * 由一個目錄項的檔名認回它的會話基底。**不是 header 檔就是 `undefined`**：日誌本文、鎖檔、當機殘留的暫存檔
 * （`<base>.header.json.<hex>.tmp`）都不認，所以走目錄的讀方一份會話只會碰到一次。
 *
 * @param filename - 目錄裡的一個檔名（不含目錄）。
 */
export function parseSessionHeaderFilename(filename: string): string | undefined {
  return filename.endsWith(HEADER_SUFFIX) ? filename.slice(0, -HEADER_SUFFIX.length) : undefined;
}
