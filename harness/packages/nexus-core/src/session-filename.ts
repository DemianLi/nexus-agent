/**
 * 一份會話落盤的檔名，**只在這裡定義**（[#1857](https://github.com/DemianLi/nexus-agent/issues/1857)，#1594 拆刀 ①）。
 *
 * 檔名的規則跟版本目錄（`session-format.ts`）放在同一個格式層：持久化後端與離線讀方（eval 掃描、發版驗證、夾具產生器）都
 * import 這一份，不各自拼。
 *
 * 兩組定義：
 *
 * - **每會話目錄與世代檔**（`sessionDirectoryName`、`generationLogFilename`／`parseGenerationLogFilename`、
 *   {@link SESSION_LOCK_FILENAME}）：寫方的佈局（#1594 ③），`<目錄>/<sessionDirectoryName(id)>/session.v<N>.jsonl`，
 *   header 在第一行，檔名帶格式版本；寫租約是同一個目錄裡的 `session.lock`。
 * - **舊兩檔佈局**（`legacyTwoFileSessionFilenames`／`parseLegacyTwoFileHeaderFilename`，#1872）：v0.5.19 以前的版本寫的佈局，
 *   一份會話三個檔並排：`<base>.header.json`、`<base>.jsonl`、`<base>.lock`。檔名不帶格式版本，格式版本看 header 的
 *   `version`。已出貨的資料要永久讀得懂，所以這一組不隨寫方換佈局而變。綁這一組的是讀方（後端的讀取接縫、離線掃描）、
 *   `create` 的撞名檢查、遷移時拿的 `<base>.lock`、寫在舊路徑的墓碑，與夾具產生器（`scripts/session-format-fixtures/run-directory.ts`）。
 *   舊路徑的 header 版本到了 {@link FIRST_GENERATION_FORMAT_VERSION} 就是墓碑，不是一份舊兩檔會話。
 *
 * 舊兩檔的 `base` 由後端從 session id 算出來（`apps/harness` 的 `safeBaseName`），不歸這裡。
 *
 * @module
 */

import { createHash } from 'node:crypto';

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

/**
 * 寫方改寫世代檔的第一個格式版本。舊兩檔的寫方最後寫的是它的前一版，所以舊路徑的 header 版本不小於它的，是寫方留下的墓碑
 * （#1594 ③）：讀方照它旁邊的會話目錄讀，v0.5.19 以前的版本讀到它會以「格式太新」拒讀。
 */
export const FIRST_GENERATION_FORMAT_VERSION = 52;

/** 會話目錄裡寫租約的鎖檔名。 */
export const SESSION_LOCK_FILENAME = 'session.lock';

/**
 * 把一個字串編成一段安全的路徑：`[A-Za-z0-9._-]` 的碼元原樣，其餘（包括 `~` 本身）寫成 `~XXXX`（UTF-16 碼元、大寫 hex），
 * 所以不同的字串編出不同的一段；整段是 `.` 或 `..` 的另外編，免得變成路徑穿越。照碼元而不是照位元組，孤立的代理碼元也編得進去。
 *
 * **不截短**：編出來可能超過檔案系統的單段上限（255 位元組）；截短歸 {@link sessionDirectoryName}。**大小寫原樣保留**：
 * 不分大小寫的檔案系統上，只差大小寫的兩個字串落在同一個名字。輸出裡的 `~` 後面一定接四位十六進位，所以產生不出單獨一個 `~`。
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

/** 目錄名超過這個字元數就截短並綴摘要，門檻同後端舊兩檔的 `safeBaseName`。 */
const MAX_DIRECTORY_NAME_LENGTH = 120;
/** 截短後保留的前綴長度。 */
const TRUNCATED_PREFIX_LENGTH = 96;
/** 摘要取幾個十六進位字元。 */
const DIGEST_LENGTH = 12;
/** 空 id 的目錄名。{@link encodeSegment} 產生不出單獨一個 `~`，所以不會跟任何非空 id 撞名。 */
const EMPTY_ID_DIRECTORY_NAME = '~';

/**
 * 一份會話在單檔佈局裡的目錄名（不含上層目錄）。
 *
 * - 一般情形是 `encodeSegment(id)`。
 * - 編出來超過 {@link MAX_DIRECTORY_NAME_LENGTH} 字元的，取前 {@link TRUNCATED_PREFIX_LENGTH} 字元、接 `-`、再接完整 id 的
 *   SHA-256 前 {@link DIGEST_LENGTH} 位十六進位。`encodeSegment` 的輸出全是 ASCII：不截短的不超過 120 位元組，截短後固定
 *   109 位元組，都在 255 位元組的單段上限內。
 * - 空 id 對到 `~`。
 *
 * 兩種撞名：
 *
 * - 不分大小寫的檔案系統上，大小寫撞名只發生在至少一方沒截短的組合上：長 id 的摘要算在原始 id 上，只差大小寫的兩個長 id
 *   各自一個目錄。
 * - 短 id 可以刻意取成某個長 id 截短後的名字，兩者落在同一個目錄名。兩份都在單檔佈局時，後建的那一份報撞名、不覆寫；一份在
 *   舊兩檔、一份在單檔佈局時，`create` 擋不到，見 [#2132](https://github.com/DemianLi/nexus-agent/issues/2132)。
 *
 * @param id - session id。
 */
export function sessionDirectoryName(id: string): string {
  if (id.length === 0) return EMPTY_ID_DIRECTORY_NAME;
  const encoded = encodeSegment(id);
  if (encoded.length <= MAX_DIRECTORY_NAME_LENGTH) return encoded;
  const digest = createHash('sha256').update(id).digest('hex').slice(0, DIGEST_LENGTH);
  return `${encoded.slice(0, TRUNCATED_PREFIX_LENGTH)}-${digest}`;
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
