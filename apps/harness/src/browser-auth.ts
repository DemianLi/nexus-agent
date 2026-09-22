/**
 * 瀏覽器會話認證：行程啟動 token 換一顆簽章、綁 authority 的 cookie
 * （[#424](https://github.com/DemianLi/nexus-agent/issues/424)）。
 *
 * **防的是同一台機器上的其他使用者與行程**，跟 `request-trust.ts` 那道 Host／Origin 圍欄防的
 * DNS rebinding 是兩件事：圍欄不建立身分，curl 帶一個 loopback 的 Host 就過得去；過了圍欄之後，
 * wire 的每一條路由都能以 serve 擁有者的身分操作 agent。部署主機是多人共用的（demian 2026-09-19），
 * 所以 #387 登記的重開條件已經觸發。
 *
 * **逐項照 dsh** `packages/client/connection/src/browser-auth.ts`（`ddefc45`），只把 node:http 的
 * req／res 換成 fetch 的 `Request`／`Response`：
 *
 * - **啟動 token**：每個行程一個，32 bytes 隨機值、base64url，不落盤。只有 `GET /?token=…` 而且
 *   query 裡剛好一個 token 才收；API 路徑與 `Authorization` 標頭都不收。
 * - **換到的 cookie**：值是 `v1.<body>.<HMAC-SHA256>`，body 是 `{ version, authority, issuedAt, expiresAt }`；
 *   名字是前綴加上 `sha256(authority)`——cookie 不分 port，所以同一台機器不同 port 上的 serve 各有
 *   各的名字、不會互相蓋掉；屬性 `Max-Age`、`Path=/`、`Expires`、`HttpOnly`、`SameSite=Strict`，
 *   loopback 的 HTTP 所以刻意不設 `Secure`，也不設 `Domain`（host-only）。
 * - **驗證**：authority 取 `Host` 正規化；只讀名字剛好相符的那一顆；簽章用 `timingSafeEqual` 比；
 *   authority 要相同；`issuedAt <= now < expiresAt`，而且期間不超過這一版的上限。
 * - **換完 303 到乾淨的 `/`**，帶 `cache-control: no-store` 與 `referrer-policy: no-referrer`；
 *   舊的 token 配上有效的 cookie 也只轉回乾淨的 `/`；其他一律同一種最小的 401。
 *
 * ## 偏離（照 AGENTS.md 的偏離規則登記）
 *
 * - ~~**有效期寫死 30 天，不能設定。**~~ **這一條沒了**
 *   （[#529](https://github.com/DemianLi/nexus-agent/issues/529)）：有效期現在由
 *   `#settings/browser-session` 那一列講，預設仍是 dsh 的 30。剩下的偏離只在**載體**上
 *   ——dsh 的擁有者是一個套件，我們退到 package-internal specifier，理由逐條在
 *   [`./settings/thread-title.ts`](./settings/thread-title.ts) 的檔頭。
 * - **不自動開瀏覽器。** dsh 的 `dsh-web-app` 印出並打開一次帶 token 的網址（SSH 底下只印）。我們本來
 *   就沒有開瀏覽器這一段；而在多人主機上，負責開瀏覽器的子行程會把網址放在命令列參數裡，別的
 *   使用者用 `ps` 就看得到 token。
 * - **token 跟著這個物件，不跟著「根 context」。** dsh 用一個 `WeakMap` 讓 Connection 熱重載時保留
 *   同一個 token；我們沒有熱重載，一次 `runServe` 建一個，行程內重啟 serve（測試）等於換一個 token。
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { DEFAULT_BROWSER_SESSION_MAX_AGE_DAYS } from './settings/browser-session.js';

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
const TOKEN_BYTES = 32;
const TOKEN_QUERY = 'token';
const COOKIE_PREFIX = 'nexus-auth-';
const COOKIE_PAYLOAD_VERSION = 1;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;
const UNAUTHORIZED_TEXT =
  'nexus-agent 需要登入：請在瀏覽器開 serve 啟動時印出的那個網址（帶 ?token=）。\n';

interface BrowserCookiePayload {
  readonly version: typeof COOKIE_PAYLOAD_VERSION;
  readonly authority: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

/** 只收 canonical 的 base64url，同 dsh 的 `decodeBase64Url`。 */
function decodeBase64Url(value: string): Buffer | undefined {
  if (!BASE64URL_PATTERN.test(value)) return undefined;
  const decoded = Buffer.from(value, 'base64url');
  return encodeBase64Url(decoded) === value ? decoded : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 正規化過的請求 authority：cookie 名字與簽章裡的 audience 都用它。 */
function requestAuthority(headers: Headers): string | undefined {
  const host = headers.get('host') ?? undefined;
  if (host === undefined) return undefined;
  try {
    return new URL(`http://${host}`).host;
  } catch {
    // Host 解析不了：沒有 authority，當作沒認證。
    return undefined;
  }
}

function tokenMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return (
    actualBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function cookieName(authority: string): string {
  return COOKIE_PREFIX + encodeBase64Url(createHash('sha256').update(authority).digest());
}

/** 只找自己產生的那一顆，不實作一般的 Cookie 解碼。 */
function cookieValue(headerValue: string, name: string): string | undefined {
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=');
    if (at === -1 || segment.slice(0, at).trim() !== name) continue;
    return segment.slice(at + 1).trim();
  }
  return undefined;
}

function sessionCookie(
  name: string,
  value: string,
  expiresAt: number,
  maxAgeSeconds: number,
): string {
  return `${name}=${value}; Max-Age=${String(maxAgeSeconds)}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=Strict`;
}

function signature(secret: Buffer, body: string): Buffer {
  return createHmac('sha256', secret).update(body).digest();
}

function encodeCookie(payload: BrowserCookiePayload, secret: Buffer): string {
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `v1.${body}.${encodeBase64Url(signature(secret, body))}`;
}

function decodeCookie(value: string, secret: Buffer): BrowserCookiePayload | undefined {
  const parts = value.split('.');
  const [version, body, encodedSignature] = parts;
  if (
    parts.length !== 3 ||
    version !== 'v1' ||
    body === undefined ||
    encodedSignature === undefined
  ) {
    return undefined;
  }
  const actualSignature = decodeBase64Url(encodedSignature);
  if (actualSignature === undefined) return undefined;
  const expectedSignature = signature(secret, body);
  if (
    actualSignature.byteLength !== expectedSignature.byteLength ||
    !timingSafeEqual(actualSignature, expectedSignature)
  ) {
    return undefined;
  }
  let decoded: unknown;
  try {
    const bodyBytes = decodeBase64Url(body);
    if (bodyBytes === undefined) return undefined;
    decoded = JSON.parse(bodyBytes.toString('utf8'));
  } catch {
    // 簽章對但 body 不是 JSON：只可能是同一把密鑰簽出來的怪東西，當作沒認證。
    return undefined;
  }
  if (
    !isRecord(decoded) ||
    decoded.version !== COOKIE_PAYLOAD_VERSION ||
    typeof decoded.authority !== 'string' ||
    !Number.isSafeInteger(decoded.issuedAt) ||
    !Number.isSafeInteger(decoded.expiresAt)
  ) {
    return undefined;
  }
  return decoded as unknown as BrowserCookiePayload;
}

function redirectToCleanRoot(setCookie?: string): Response {
  const headers = new Headers({
    'cache-control': 'no-store',
    location: '/',
    'referrer-policy': 'no-referrer',
  });
  if (setCookie !== undefined) headers.set('set-cookie', setCookie);
  return new Response(null, { status: 303, headers });
}

/**
 * 行程 token 的交換，與簽章 cookie 的驗證。
 *
 * 密鑰由呼叫端載入（`browser-session-secret.ts`）後交進來，之後每個請求都在記憶體裡同步驗。
 */
export class BrowserAuth {
  private readonly launchToken: string;
  private readonly maxAgeMilliseconds: number;

  /**
   * @param secret - 32 bytes 的簽章密鑰。
   * @param maxAgeDays - cookie 的絕對有效期（天）。**產品路徑上由 `serve.ts` 明著傳**，值來自
   *   `#settings/browser-session` 那一列；省略是給手搭的測試用的，拿到的是同一個 schema 的預設值
   *   （[#529](https://github.com/DemianLi/nexus-agent/issues/529)）。
   * @throws 有效期換算成毫秒後超出安全整數範圍。
   */
  constructor(
    private readonly secret: Buffer,
    maxAgeDays: number = DEFAULT_BROWSER_SESSION_MAX_AGE_DAYS,
  ) {
    this.launchToken = encodeBase64Url(randomBytes(TOKEN_BYTES));
    this.maxAgeMilliseconds = maxAgeDays * DAY_MILLISECONDS;
    if (
      !Number.isSafeInteger(this.maxAgeMilliseconds) ||
      !Number.isSafeInteger(Date.now() + this.maxAgeMilliseconds)
    ) {
      throw new Error('瀏覽器會話：cookie 有效期超出安全的時間戳範圍。');
    }
  }

  /**
   * 在一般的根網址上帶這個行程的 token。
   *
   * @param baseUrl - 瀏覽器要開的來源（不帶憑證）。
   * @returns 路徑是 `/`、query 只有 token 的網址。**這個值是敏感輸出**：印一次，別處不重複。
   */
  authenticatedUrl(baseUrl: string): string {
    const url = new URL(baseUrl);
    url.pathname = '/';
    url.search = '';
    url.hash = '';
    url.searchParams.set(TOKEN_QUERY, this.launchToken);
    return url.href;
  }

  /**
   * 認證一個 index 請求（`/` 或 `/index.html`）。
   *
   * @param request - 那個請求。
   * @returns `undefined` 表示呼叫端可以給 index；否則是要原樣回給瀏覽器的回應（換 cookie 的 303，
   *   或同一種最小的 401）。
   */
  authorizeIndex(request: Request): Response | undefined {
    const url = new URL(request.url);
    const tokens = url.searchParams.getAll(TOKEN_QUERY);
    if (tokens.length > 0) {
      const authority = requestAuthority(request.headers);
      if (
        request.method === 'GET' &&
        url.pathname === '/' &&
        tokens.length === 1 &&
        authority !== undefined &&
        tokenMatches(tokens.join(''), this.launchToken)
      ) {
        const issuedAt = Date.now();
        const expiresAt = issuedAt + this.maxAgeMilliseconds;
        const value = encodeCookie(
          { version: COOKIE_PAYLOAD_VERSION, authority, issuedAt, expiresAt },
          this.secret,
        );
        return redirectToCleanRoot(
          sessionCookie(
            cookieName(authority),
            value,
            expiresAt,
            Math.floor(this.maxAgeMilliseconds / 1000),
          ),
        );
      }
      if (
        request.method === 'GET' &&
        url.pathname === '/' &&
        this.isAuthenticated(request.headers)
      ) {
        return redirectToCleanRoot();
      }
      return this.unauthorized(request);
    }
    if (this.isAuthenticated(request.headers)) return undefined;
    return this.unauthorized(request);
  }

  /**
   * 驗一個請求帶的 cookie。
   *
   * @param headers - 請求標頭（讀 `Host` 與 `Cookie`）。
   * @returns 只有這把密鑰簽的、authority 相符、還在有效期內的 cookie 才是 true。
   */
  isAuthenticated(headers: Headers): boolean {
    const authority = requestAuthority(headers);
    const rawCookie = headers.get('cookie') ?? undefined;
    if (authority === undefined || rawCookie === undefined) return false;
    const value = cookieValue(rawCookie, cookieName(authority));
    if (value === undefined) return false;
    const payload = decodeCookie(value, this.secret);
    if (payload === undefined || payload.authority !== authority) return false;
    const now = Date.now();
    return (
      payload.issuedAt <= now &&
      payload.expiresAt > now &&
      payload.expiresAt > payload.issuedAt &&
      payload.expiresAt - payload.issuedAt <= this.maxAgeMilliseconds
    );
  }

  private unauthorized(request: Request): Response {
    return new Response(request.method === 'HEAD' ? null : UNAUTHORIZED_TEXT, {
      status: 401,
      headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
    });
  }
}
