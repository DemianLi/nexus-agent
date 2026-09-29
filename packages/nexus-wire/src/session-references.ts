/**
 * `@` 引用別的會話（[#713](https://github.com/DemianLi/nexus-agent/issues/713)）上線的形狀：引用文字的編碼、候選的列法。
 *
 * 照 dsh 的 `session-reference`（`packages/context/session-reference/src/{uri,config,types}.ts`，`477b4f4`）。選中的候選在輸入框裡是一段
 * 完整的引用文字 `@[標題](nexus-session:<base64url>)`（Q2：第一版不做標籤），送出、排隊、重新編輯都照原樣走，伺服器在
 * 準備那一步才把它換成 `@標題` 並附上那條會話的快照。
 *
 * ## 給 client 的約定
 *
 * 1. **`mention` 是伺服器編好的**：client 不必（也不該）自己編引用文字，照候選給的原樣插進輸入框。
 * 2. **候選的 `label` 是標題，沒有標題就是 id**；`mention` 裡的標題已經跳脫過 `\` 與 `]`。
 * 3. **`GET` 也要帶 `content-type: application/json`**，理由同 `THREADS_PATH`。
 *
 * ## 與 dsh 的偏離
 *
 * 1. **scheme 叫 `nexus-session:`**：dsh 的 `dsh-session:` 是它自己的品牌。編碼（`JSON.stringify(id)` 的 base64url、要求正規形式）一字不改。
 * 2. **候選少 `displayTitle`**：dsh 的 `displayTitle` 是「子代理標籤優先」，我們的子代理日誌沒有獨立標籤，兩者永遠相同，留著只會讓 client
 *    多判一次。子代理屬於哪條會話走 `parentSessionId`／`parentLabel`（Q4 要的）。
 * 3. **路徑掛在 thread 底下、走 `GET`**：同 {@link fileReferencesPath} 的理由。與它不同，**這條不為它建起 thread**：候選是冷讀，見 `session-reference-candidates.ts`。
 * 4. **沒接落盤就不提供**（{@link SessionReferenceListResult} 的 `available: false`）：dsh 對還活著的會話讀記憶體裡那一份，落盤與否都讀得到。我們的候選與快照都經
 *    `SessionStore` 冷讀（[#665](https://github.com/DemianLi/nexus-agent/issues/665)，demian 2026-09-29 拍板），沒接落盤就沒有可讀的存放處，活著的 thread 也不例外。
 *    **接了落盤的話，活著的 thread 落後磁碟最多一個批次窗口**（`windowMs`，預設 10 毫秒，清單上可調大）：剛講完的一句話在窗口內看不到。
 * 5. **CLI 的 run 目錄不列**：CLI 的 root id 一律叫 `cli`，引用只編 id，`cli` 指不到唯一的一份。
 *
 * 這個檔案**不依賴 Node**：web 也要在重編輯與泡泡上認這段文字。
 *
 * @module
 */

import type { ErrorResponse } from './protocol.js';

/** 一則訊息最多引用幾條不同的會話。 */
export const MAX_SESSION_REFERENCES = 3;
/** 候選最多回幾筆。 */
export const DEFAULT_SESSION_REFERENCE_CANDIDATE_LIMIT = 50;

/** 引用文字的 scheme。 */
export const SESSION_REFERENCE_SCHEME = 'nexus-session:';

/** 引用失敗的穩定代碼，網頁與日誌依它分流。七個全照 dsh（`config.ts`）；準備那一半（PR2）決定各自何時拋。 */
export type SessionReferenceErrorCode =
  | 'SESSION_REFERENCE_INVALID_CONFIG'
  | 'SESSION_REFERENCE_INVALID_REFERENCE'
  | 'SESSION_REFERENCE_SELF_REFERENCE'
  | 'SESSION_REFERENCE_TOO_MANY'
  | 'SESSION_REFERENCE_READ_FAILED'
  | 'SESSION_REFERENCE_BUDGET_EXCEEDED'
  | 'SESSION_REFERENCE_CANCELLED';

/** 帶穩定代碼的引用失敗。 */
export class SessionReferenceError extends Error {
  constructor(
    message: string,
    readonly code: SessionReferenceErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SessionReferenceError';
  }
}

function utf8ToBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function base64UrlToUtf8(payload: string): string {
  const padded = payload.replace(/-/gu, '+').replace(/_/gu, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/**
 * 把任意會話 id 編成一個正規的、可逆的引用網址。
 *
 * @param sessionId - 不透明的會話 id。
 * @returns `nexus-session:` 開頭的網址。
 */
export function encodeSessionReferenceUri(sessionId: string): string {
  return `${SESSION_REFERENCE_SCHEME}${utf8ToBase64Url(JSON.stringify(sessionId))}`;
}

function invalidUri(uri: string, cause?: unknown): SessionReferenceError {
  return new SessionReferenceError(
    `invalid session reference URI ${JSON.stringify(uri)}`,
    'SESSION_REFERENCE_INVALID_REFERENCE',
    cause === undefined ? undefined : { cause },
  );
}

/**
 * 解一個引用網址並確認它是正規形式（重新編一次要一字不差）。
 *
 * @param uri - 完整的網址。
 * @returns 會話 id。
 * @throws {@link SessionReferenceError} `SESSION_REFERENCE_INVALID_REFERENCE`。
 */
export function decodeSessionReferenceUri(uri: string): string {
  if (!uri.startsWith(SESSION_REFERENCE_SCHEME)) throw invalidUri(uri);
  const payload = uri.slice(SESSION_REFERENCE_SCHEME.length);
  if (!/^[A-Za-z0-9_-]+$/u.test(payload)) throw invalidUri(uri);
  try {
    const parsed: unknown = JSON.parse(base64UrlToUtf8(payload));
    if (typeof parsed !== 'string') throw new TypeError('decoded session id is not a string');
    if (encodeSessionReferenceUri(parsed) !== uri) throw new TypeError('URI is not canonical');
    return parsed;
  } catch (error: unknown) {
    throw invalidUri(uri, error);
  }
}

/** 一段引用：會話 id 與顯示用的標題。 */
export interface SessionReferenceInput {
  readonly sessionId: string;
  readonly label?: string;
}

function escapeLabel(label: string): string {
  return label.replace(/[\\\]]/gu, (match) => `\\${match}`);
}

function unescapeLabel(label: string): string {
  return label.replace(/\\(.)/gu, '$1');
}

/**
 * 編一段插進輸入框的引用文字 `@[標題](nexus-session:…)`。
 *
 * @param reference - 會話 id 與標題；沒給標題就用 id。
 * @returns 標題裡的 `\` 與 `]` 已跳脫的引用文字。
 */
export function formatSessionReferenceMention(reference: SessionReferenceInput): string {
  const label = escapeLabel(reference.label ?? reference.sessionId);
  return `@[${label}](${encodeSessionReferenceUri(reference.sessionId)})`;
}

/** {@link parseSessionReferenceText} 的結果。 */
export interface ParsedSessionReferenceText {
  /** 每一段引用換成好讀的 `@標題` 之後的文字。 */
  readonly text: string;
  /** 照出現先後的引用，還沒去重。 */
  readonly references: readonly { readonly sessionId: string; readonly label: string }[];
}

/**
 * 從一段文字裡取出引用。明寫的 `@[標題](網址)` 網址壞了就整個拒絕；光禿禿的網址只在後面接著 base64url 形狀的內容時才當引用，
 * 之後照樣要求是正規形式。
 *
 * @param text - 使用者送出的文字。
 * @returns 換成 `@標題` 的文字與依出現先後的引用。
 * @throws {@link SessionReferenceError} `SESSION_REFERENCE_INVALID_REFERENCE`。
 */
export function parseSessionReferenceText(text: string): ParsedSessionReferenceText {
  const references: { sessionId: string; label: string }[] = [];
  const pattern =
    /@\[((?:\\.|[^\\\]])*)\]\((nexus-session:[^\s)]*)\)|(nexus-session:[A-Za-z0-9_-]+)/gu;
  const rendered = text.replace(
    pattern,
    (
      _match,
      rawLabel: string | undefined,
      markdownUri: string | undefined,
      bareUri: string | undefined,
    ) => {
      const uri = markdownUri ?? bareUri;
      if (uri === undefined) throw invalidUri('');
      const sessionId = decodeSessionReferenceUri(uri);
      const label = rawLabel === undefined ? sessionId : unescapeLabel(rawLabel);
      references.push({ sessionId, label });
      return `@${label}`;
    },
  );
  return { text: rendered, references };
}

/** 一個候選：可以引用的一條會話。 */
export interface SessionReferenceCandidate {
  readonly sessionId: string;
  /** 標題；沒有標題就是 id。 */
  readonly label: string;
  /** 建立當下的工作目錄。 */
  readonly cwd?: string;
  /** 跟這台 server 的工作目錄相同。 */
  readonly sameWorkspace: boolean;
  /** 建立當下的 Unix 毫秒。 */
  readonly createdAt: number;
  /** 最後一則人話的時間，沒有就是建立時間。 */
  readonly updatedAt: number;
  /** 子代理屬於哪條會話，主會話沒有這一格。 */
  readonly parentSessionId?: string;
  /** 那條會話的標題，讀不到就是它的 id。 */
  readonly parentLabel?: string;
  /** 伺服器編好的引用文字，原樣插進輸入框。 */
  readonly mention: string;
}

/**
 * 列候選的結果。
 *
 * **`available: false` 是「這台 server 沒接落盤」，不是空清單**：web 據它整個不列會話那兩段，跟 query 無關。
 */
export type SessionReferenceListResult =
  | { readonly available: false }
  | { readonly available: true; readonly candidates: readonly SessionReferenceCandidate[] };

/** {@link sessionReferencesPath} 的回應封包。 */
export type SessionReferenceListResponse =
  { readonly type: 'success'; readonly result: SessionReferenceListResult } | ErrorResponse;

/**
 * 列候選的路徑，`GET`，帶 `?query=`（`@` 後面那一段；省略就是空的）。
 *
 * 回應同 {@link SessionReferenceListResponse}。**不為它建起 thread**：候選是冷讀。
 *
 * @param threadId - 這一條 thread 的 id；候選裡不含它自己。
 * @returns 路徑。
 */
export function sessionReferencesPath(threadId: string): string {
  return `/threads/${encodeURIComponent(threadId)}/session-references`;
}
