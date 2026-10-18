/**
 * 一把供應商金鑰長什麼樣才算能用（[#1541](https://github.com/DemianLi/nexus-agent/issues/1541)）。
 *
 * 照 dsh `packages/llm/llm/src/api-key.ts`（判準與兩種理由）與 `packages/llm/llm/src/index.ts` 的 `assertUsableApiKey`
 * （拒收、訊息不回顯金鑰），對讀版本 `687f282e`（alpha.5 的 `1517a4db` 兩處一致）。
 *
 * **為什麼要在送出之前擋。** 金鑰會被放進 HTTP 標頭。標頭放不下的字元（全形字元、零寬空白、中間的換行）在 `fetch` 建標頭時才拋
 * `TypeError`，分類器落到 `UNKNOWN`；更糟的是中間有換行時，那句 `TypeError` 的訊息裡就是整把金鑰，接著寫進 `turn/failed`、會話日誌與網頁。
 * 放得下但供應商不認的（前導空白、中間空白、Latin-1）只會換來一個看不出原因的 401。所以在轉接器取金鑰的那一刻先判，
 * 受管檔、`.env`、shell export 三種來源都過同一道。
 *
 * @module
 */

import type { CredentialOrigin, ResolvedCredential } from './credentials.js';

/** 失敗分類碼。不在 `@nexus/core` 的 `DEFAULT_STREAM_RETRYABLE_CODES` 裡：同一把壞金鑰重打幾次都一樣。 */
export const INVALID_CREDENTIAL_CODE = 'INVALID_CREDENTIAL';

/**
 * HTTP 標頭原樣帶得過去、而且所有已知供應商的金鑰都在其中的字元：可列印 ASCII，**不含空白**。
 * Latin-1 是刻意排除的（標頭帶得動，但沒有供應商核發這種金鑰；放行只是把一句本機講得清楚的拒絕換成一個看不懂的 401）。
 */
const LEGAL_API_KEY = /^[\x21-\x7E]+$/u;

/** 為什麼一把金鑰不能用。 */
export type ApiKeyRejection = 'empty' | 'illegalCharacters';

/** 對一把金鑰的判決。 */
export type ApiKeyCheck =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: ApiKeyRejection };

/**
 * 判一把**已經給了**的金鑰，先修掉頭尾空白。
 *
 * 修頭尾是靜靜的：頭尾多出來的空白只有一種讀法；其他的毛病都要講。「沒給」不在這支函式的範圍（呼叫端先決定有沒有值）。
 *
 * @param raw - 金鑰原樣（設定檔、受管檔、`.env`、環境變數裡的字串）。
 * @returns 修過的金鑰，或為什麼不能用。
 */
export function normalizeApiKey(raw: string): ApiKeyCheck {
  const value = raw.trim();
  if (value.length === 0) return { ok: false, reason: 'empty' };
  if (!LEGAL_API_KEY.test(value)) return { ok: false, reason: 'illegalCharacters' };
  return { ok: true, value };
}

/**
 * 金鑰不能用。認 `name`（跨多層 `cause` 的辨識沿用 `classifyTurnFailure` 的寫法），不認訊息。
 *
 * **訊息不含金鑰的任何片段**：只指名是哪一把（環境變數名）與來源層。
 */
export class InvalidCredentialError extends Error {
  /** 失敗分類碼，見 {@link INVALID_CREDENTIAL_CODE}。 */
  readonly code = INVALID_CREDENTIAL_CODE;

  constructor(message: string) {
    super(message);
    this.name = 'InvalidCredentialError';
  }
}

/** 來源層的說法，給訊息用：受管檔與 `.env` 寫出路徑，啟動環境就叫啟動環境。 */
function describeOrigin(source: CredentialOrigin, path: string | undefined): string {
  switch (source) {
    case 'file':
      return `受管憑證檔${path === undefined ? '' : ` ${path}`}`;
    case 'env':
      return '啟動環境';
    case 'project-env':
      return path === undefined ? '目前資料夾的 .env' : `.env（${path}）`;
    case 'user-env':
      return path === undefined ? 'harness home 的 .env' : `.env（${path}）`;
  }
}

/**
 * 收下一把解析到的金鑰，或拒收。
 *
 * @param name - 環境變數形狀的名字（例如 `NVIDIA_API_KEY`），訊息指名它。
 * @param hit - 憑證服務解析到的那一筆。
 * @returns 修過頭尾空白、可以放進標頭的金鑰。
 * @throws {@link InvalidCredentialError}：空白，或含有標頭放不下的字元。訊息只講名字與來源層，不含值的任何片段。
 */
export function assertUsableApiKey(name: string, hit: ResolvedCredential): string {
  const checked = normalizeApiKey(hit.value);
  if (checked.ok) return checked.value;
  const origin = describeOrigin(hit.source, hit.path);
  throw new InvalidCredentialError(
    checked.reason === 'empty'
      ? `${name}（來自${origin}）是空白的。請把它改成金鑰本身，或把那一行拿掉。`
      : `${name}（來自${origin}）含有 HTTP 標頭放不下的字元（空白、換行、非 ASCII 字元都不行）。` +
          '請把它改成只有金鑰本身；YAML 的值不要用 | 區塊或折行寫，貼金鑰時也留意別帶到全形字元。',
  );
}
