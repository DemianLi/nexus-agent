/**
 * 一份會話落盤的檔名，**只在這裡定義**（[#1857](https://github.com/DemianLi/nexus-agent/issues/1857)，#1594 拆刀 ①）。
 *
 * 檔名的規則跟版本目錄（`session-format.ts`）放在同一個格式層：持久化後端與離線讀方（eval 掃描、發版驗證、夾具產生器）都
 * import 這一份，不各自拼。
 *
 * 三組定義：
 *
 * - **寫方目前的佈局**（`sessionFilenames`／`parseSessionHeaderFilename`）：後端新建會話寫的佈局（今天就是舊兩檔）。
 *   新建會話改寫世代檔（#1594 ③）時換掉這一組。
 * - **舊兩檔佈局**（`legacyTwoFileSessionFilenames`／`parseLegacyTwoFileHeaderFilename`，#1872）：已出貨的版本寫的佈局，
 *   一份會話三個檔並排：`<base>.header.json`、`<base>.jsonl`、`<base>.lock`。檔名不帶格式版本，格式版本看 header 的
 *   `version`。已出貨的資料要永久讀得懂，所以這一組**不隨寫方換佈局而變**。綁這一組的是讀方（後端的讀取接縫、離線掃描）、
 *   `create` 的撞名檢查、續接拿的 `<base>.lock`，與夾具產生器（`scripts/session-format-fixtures/run-directory.ts`）：寫方那一組
 *   換掉之後，舊資料照樣認得、舊鎖照樣互斥。
 * - **每會話目錄與世代檔**（`sessionDirectoryName`、`generationLogFilename`／`parseGenerationLogFilename`）：
 *   單檔佈局，`<目錄>/<sessionDirectoryName(id)>/session.v<N>.jsonl`，header 在第一行，檔名帶格式版本。今天沒有程式建它：
 *   讀方認它、`create` 的撞名檢查看它、續接往挑中的世代檔追加；建新世代歸 #1594 ③。
 *
 * 舊兩檔的 `base` 由後端從 session id 算出來（`apps/harness` 的 `safeBaseName`），不歸這裡。
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

/**
 * 把一個字串編成一段安全的路徑：`[A-Za-z0-9._-]` 的碼元原樣，其餘（包括 `~` 本身）寫成 `~XXXX`（UTF-16 碼元、大寫 hex），
 * 所以不同的字串編出不同的一段；整段是 `.` 或 `..` 的另外編，免得變成路徑穿越。照碼元而不是照位元組，孤立的代理碼元也編得進去。
 *
 * **不截短**：編出來可能超過檔案系統的單段上限（255 位元組），讀方碰到 `ENAMETOOLONG` 要當成「不在」。**大小寫原樣保留**：
 * 不分大小寫的檔案系統上，只差大小寫的兩個字串落在同一個名字。
 *
 * @param raw - 要編的字串。
 * @throws `Error` 空字串。
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('空字串編不成路徑的一段');
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    const char = String.fromCharCode(code);
    out += /^[A-Za-z0-9._-]$/.test(char)
      ? char
      : `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

/**
 * 一份會話在單檔佈局裡的目錄名（不含上層目錄）：`encodeSegment(id)`。
 *
 * @param id - session id。
 * @throws `Error` 空字串（同 {@link encodeSegment}）。
 */
export function sessionDirectoryName(id: string): string {
  return encodeSegment(id);
}

/** 正規的世代檔名：`session.jsonl`（版本 0）或 `session.v<N>.jsonl`（N ≥ 1、沒有前導零）。 */
const CANONICAL_GENERATION_FILENAME = /^session(?:\.v([1-9][0-9]*))?\.jsonl$/u;

/**
 * 某個格式版本的世代檔名：版本 0 是 `session.jsonl`，其餘是 `session.v<N>.jsonl`。
 *
 * @param version - 非負的安全整數。
 * @throws `TypeError` 不是非負的安全整數。
 */
export function generationLogFilename(version: number): string {
  if (!Number.isSafeInteger(version) || version < 0 || Object.is(version, -0)) {
    throw new TypeError(`世代檔的版本要是非負的安全整數，拿到 ${String(version)}`);
  }
  return version === 0 ? 'session.jsonl' : `session.v${String(version)}.jsonl`;
}

/**
 * 由一個目錄項的檔名認回它的世代版本：暫存檔、大寫、前導零、`.v0` 與超出安全整數的都不認。
 *
 * @param filename - 會話目錄裡的一個檔名。
 * @returns 世代版本；不是正規的世代檔名就是 `undefined`。
 */
export function parseGenerationLogFilename(filename: string): number | undefined {
  const match = CANONICAL_GENERATION_FILENAME.exec(filename);
  if (match === null) return undefined;
  if (match[1] === undefined) return 0;
  const version = Number(match[1]);
  return Number.isSafeInteger(version) ? version : undefined;
}
