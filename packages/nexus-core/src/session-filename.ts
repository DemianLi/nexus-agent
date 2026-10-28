/**
 * 一份會話落盤的檔名，**只在這裡定義**（[#1857](https://github.com/DemianLi/nexus-agent/issues/1857)，#1594 拆刀 ①）。
 *
 * 檔名的規則跟版本目錄（`session-format.ts`）放在同一個格式層：持久化後端與離線讀方（eval 掃描、發版驗證、夾具產生器）都
 * import 這一份，不各自拼。
 *
 * 兩組定義：
 *
 * - **寫方目前的佈局**（`sessionFilenames`／`parseSessionHeaderFilename`）：後端今天寫、讀的佈局（今天就是舊兩檔）。
 *   寫方切到世代檔（#1594 ③）時換掉這一組，讀方的檔名因為都經過這裡，不必逐處改。
 * - **舊兩檔佈局**（`legacyTwoFileSessionFilenames`／`parseLegacyTwoFileHeaderFilename`，#1872）：已出貨的版本寫的佈局，
 *   一份會話三個檔並排：`<base>.header.json`、`<base>.jsonl`、`<base>.lock`。檔名不帶格式版本，格式版本看 header 的
 *   `version`。已出貨的資料要永久讀得懂，所以這一組**不隨寫方換佈局而變**。今天綁這一組的是夾具產生器
 *   （`scripts/session-format-fixtures/run-directory.ts`）；#1594 ② 認舊佈局的讀方也要綁這一組。
 *
 * `base` 由後端從 session id 算出來（`apps/harness` 的 `safeBaseName`），不歸這裡。
 *
 * @module
 */

const LEGACY_HEADER_SUFFIX = '.header.json';
const LEGACY_LOG_SUFFIX = '.jsonl';
const LEGACY_LOCK_SUFFIX = '.lock';

/** 舊兩檔佈局裡一份會話的三個檔名（不含目錄）。 */
export interface LegacyTwoFileSessionFilenames {
  /** header：一個 JSON 物件，「這份會話存在」的提交點。 */
  readonly header: string;
  /** 日誌本文：一行一筆事件。 */
  readonly log: string;
  /** 寫租約的鎖檔。 */
  readonly lock: string;
}

/**
 * 由檔名基底給出舊兩檔佈局裡一份會話的三個檔名。
 *
 * @param base - 檔名基底（後端的 `safeBaseName` 算出來的）。
 */
export function legacyTwoFileSessionFilenames(base: string): LegacyTwoFileSessionFilenames {
  return {
    header: `${base}${LEGACY_HEADER_SUFFIX}`,
    log: `${base}${LEGACY_LOG_SUFFIX}`,
    lock: `${base}${LEGACY_LOCK_SUFFIX}`,
  };
}

/**
 * 由一個目錄項的檔名認回它在舊兩檔佈局裡的會話基底。**不是 header 檔就是 `undefined`**：日誌本文、鎖檔、當機殘留的暫存檔
 * （`<base>.header.json.<hex>.tmp`）都不認，所以走目錄的讀方一份會話只會碰到一次。
 *
 * @param filename - 目錄裡的一個檔名（不含目錄）。
 */
export function parseLegacyTwoFileHeaderFilename(filename: string): string | undefined {
  return filename.endsWith(LEGACY_HEADER_SUFFIX)
    ? filename.slice(0, -LEGACY_HEADER_SUFFIX.length)
    : undefined;
}

/** 寫方目前的佈局裡一份會話的三個檔名（不含目錄）。 */
export type SessionFilenames = LegacyTwoFileSessionFilenames;

/**
 * 由檔名基底給出寫方目前的佈局裡一份會話的三個檔名。
 *
 * @param base - 檔名基底（後端的 `safeBaseName` 算出來的）。
 */
export function sessionFilenames(base: string): SessionFilenames {
  return legacyTwoFileSessionFilenames(base);
}

/**
 * 由一個目錄項的檔名認回它在寫方目前的佈局裡的會話基底。不是 header 檔就是 `undefined`，規則同
 * {@link parseLegacyTwoFileHeaderFilename}。
 *
 * @param filename - 目錄裡的一個檔名（不含目錄）。
 */
export function parseSessionHeaderFilename(filename: string): string | undefined {
  return parseLegacyTwoFileHeaderFilename(filename);
}
