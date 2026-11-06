/**
 * 嵌入專用的會話（[#2370](https://github.com/DemianLi/nexus-agent/issues/2370)，地圖 #2365 第 4 點）：`<nexus-chat>` 拿嵌入方換到的
 * 登入票（`embed-login.ts`）打 `POST /embed/session`，換一顆**只放行 `/embed/` 底下路徑**的簽章 cookie。
 *
 * - **跟獨立頁面那顆 cookie 不能互換**：名字不同（`nexus-embed-` 對 `nexus-auth-`），版本前綴不同（`e1.` 對 `v1.`），
 *   簽章用的是從瀏覽器會話密鑰衍生出來的另一把子鑰。把一顆的值放到另一顆的名字底下，簽章就對不上。
 *   wire 路由的放行範圍由 `wire-handler.ts` 的 `admit` 判（`wire-principal.ts` 的 `principalMayReach`）。
 * - **cookie 的內容**：`{ version, authority, issuedAt, expiresAt, embedder, subject, userId, sessionIdSha256 }`，
 *   不帶票、不帶服務憑證。屬性同獨立頁面那顆：`Path=/`、`HttpOnly`、`SameSite=Strict`、不設 `Domain`。
 * - **兌換**：票只能兌換一次（`EmbedTicketStore.redeem`）。兌換時再問一次身分對應，對應被撤掉的票換不到 cookie。
 *   續期就是嵌入方再換一張票、元件再兌換一次：同一個 authority 的嵌入 cookie 同名，新的蓋掉舊的。
 * - **稽核**：票查得到的每一次都記（`embed-audit.ts`），記好才回應；寫不進去就 500、不設 cookie。票不存在、用過、
 *   本文不對的只計數合併。
 *
 * 回應：`200 { expiresAt, threadId? }` 加 `Set-Cookie`；`threadId` 是這一次登入最新開的那條嵌入對話，沒開過、還沒落盤、沒開會話日誌、或查不到就沒有；票不存在或用過 `401 { error: 'ticket_invalid' }`；票過期
 * `401 { error: 'ticket_expired' }`；對應被撤 `403 { error: 'identity_rejected' }`；本文不對 `400`；方法不對 `405`；
 * 圍欄沒過 `403`（純文字）。`expiresAt` 是 cookie 的到期時間，系統時間的毫秒時間戳。都帶 `cache-control: no-store`。
 *
 * @module
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { EMBED_PATH_PREFIX } from '@nexus/wire';

import { cookieValue, decodeBase64Url, encodeBase64Url, requestAuthority } from './browser-auth.js';
import type { EmbedAudit } from './embed-audit.js';
import { json, plain, readJsonObject } from './embed-http.js';
import type { EmbedIdentityResolver, EmbedTicketStore } from './embed-login.js';
import type { EmbedThreadOwner } from './embed-thread-owner.js';
import { isTrustedWireRequest } from './request-trust.js';
import type { EmbedPrincipal } from './wire-principal.js';

/** 兌換的路徑（代理後面是 `/nexus/embed/session`）。 */
export const EMBED_SESSION_PATH = `${EMBED_PATH_PREFIX}/session`;

/** 兌換本文的上限：`{ "ticket": "<43 字元>" }` 用不到這麼多。 */
export const MAX_SESSION_BODY_BYTES = 1024;

const COOKIE_PREFIX = 'nexus-embed-';
const COOKIE_VERSION_TAG = 'e1';
const COOKIE_PAYLOAD_VERSION = 1;
const KEY_LABEL = 'nexus-embed-session-v1';
const MAX_TICKET_LENGTH = 256;

interface EmbedCookiePayload {
  readonly version: typeof COOKIE_PAYLOAD_VERSION;
  readonly authority: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly embedder: string;
  readonly subject: string;
  readonly userId: string;
  readonly sessionIdSha256: string;
}

function cookieName(authority: string): string {
  return COOKIE_PREFIX + encodeBase64Url(createHash('sha256').update(authority).digest());
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** 驗 cookie 時問的那一支：這組對應現在還在不在表上（`embed-identities.ts` 的 `EmbedIdentityTable.has`）。 */
export interface EmbedIdentityCheck {
  has(identity: {
    readonly embedder: string;
    readonly subject: string;
    readonly userId: string;
  }): boolean;
}

/**
 * 嵌入 cookie 的簽發與驗證。
 *
 * 密鑰是瀏覽器會話那一把（`browser-session-secret.ts`），進來之後先衍生出嵌入專用的子鑰，只用子鑰簽與驗。
 */
export class EmbedSessionCookies {
  readonly #key: Buffer;
  readonly #maxAgeMs: number;
  readonly #embedders: ReadonlySet<string>;
  readonly #identities: EmbedIdentityCheck;
  readonly #now: () => number;

  /**
   * @param secret - 瀏覽器會話密鑰（32 bytes）。
   * @param maxAgeSeconds - cookie 的絕對有效期（秒）。
   * @param embedders - 設定裡現在有的嵌入方 id：拿掉一個嵌入方重啟之後，它簽出去還沒到期的 cookie 也驗不過。
   * @param identities - 每次驗都問一次這組對應還在不在表上（多快看到表的變動見 `EmbedIdentityTable.has`）。
   * @param now - 現在幾點；測試換掉。
   */
  constructor(
    secret: Buffer,
    maxAgeSeconds: number,
    embedders: Iterable<string>,
    identities: EmbedIdentityCheck,
    now: () => number = Date.now,
  ) {
    this.#key = createHmac('sha256', secret).update(KEY_LABEL).digest();
    this.#maxAgeMs = maxAgeSeconds * 1000;
    this.#embedders = new Set(embedders);
    this.#identities = identities;
    this.#now = now;
  }

  #sign(body: string): Buffer {
    return createHmac('sha256', this.#key).update(body).digest();
  }

  /**
   * 簽一顆 cookie。
   *
   * @returns `Set-Cookie` 的值與到期時間（毫秒時間戳）。
   */
  issue(
    authority: string,
    identity: Omit<EmbedPrincipal, 'kind'>,
  ): { readonly setCookie: string; readonly expiresAt: number } {
    const issuedAt = this.#now();
    const expiresAt = issuedAt + this.#maxAgeMs;
    const payload: EmbedCookiePayload = {
      version: COOKIE_PAYLOAD_VERSION,
      authority,
      issuedAt,
      expiresAt,
      embedder: identity.embedder,
      subject: identity.subject,
      userId: identity.userId,
      sessionIdSha256: identity.sessionIdSha256,
    };
    const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
    const value = `${COOKIE_VERSION_TAG}.${body}.${encodeBase64Url(this.#sign(body))}`;
    const maxAge = Math.floor(this.#maxAgeMs / 1000);
    return {
      setCookie: `${cookieName(authority)}=${value}; Max-Age=${String(maxAge)}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=Strict`,
      expiresAt,
    };
  }

  /**
   * 驗一個請求帶的嵌入 cookie。
   *
   * @returns 子鑰簽的、authority 相符、還在有效期內、嵌入方還在設定裡、對應還在表上的 cookie 代表的身分；其他回 `undefined`。
   */
  authenticate(headers: Headers): EmbedPrincipal | undefined {
    const authority = requestAuthority(headers);
    const rawCookie = headers.get('cookie') ?? undefined;
    if (authority === undefined || rawCookie === undefined) return undefined;
    const value = cookieValue(rawCookie, cookieName(authority));
    if (value === undefined) return undefined;
    const payload = this.#decode(value);
    if (
      payload === undefined ||
      payload.authority !== authority ||
      !this.#embedders.has(payload.embedder)
    ) {
      return undefined;
    }
    const now = this.#now();
    if (
      payload.issuedAt > now ||
      payload.expiresAt <= now ||
      payload.expiresAt - payload.issuedAt > this.#maxAgeMs
    ) {
      return undefined;
    }
    if (!this.#identities.has(payload)) return undefined;
    return {
      kind: 'embed',
      embedder: payload.embedder,
      subject: payload.subject,
      userId: payload.userId,
      sessionIdSha256: payload.sessionIdSha256,
    };
  }

  #decode(value: string): EmbedCookiePayload | undefined {
    const parts = value.split('.');
    const [tag, body, encodedSignature] = parts;
    if (
      parts.length !== 3 ||
      tag !== COOKIE_VERSION_TAG ||
      body === undefined ||
      encodedSignature === undefined
    ) {
      return undefined;
    }
    const actual = decodeBase64Url(encodedSignature);
    const expected = this.#sign(body);
    if (
      actual === undefined ||
      actual.byteLength !== expected.byteLength ||
      !timingSafeEqual(actual, expected)
    ) {
      return undefined;
    }
    let decoded: unknown;
    try {
      const bytes = decodeBase64Url(body);
      if (bytes === undefined) return undefined;
      decoded = JSON.parse(bytes.toString('utf8'));
    } catch {
      // 簽章對但 body 不是 JSON：只可能是同一把子鑰簽出來的怪東西，當作沒認證。
      return undefined;
    }
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return undefined;
    const record = decoded as Record<string, unknown>;
    if (
      record.version !== COOKIE_PAYLOAD_VERSION ||
      typeof record.authority !== 'string' ||
      !Number.isSafeInteger(record.issuedAt) ||
      !Number.isSafeInteger(record.expiresAt) ||
      !isNonEmptyString(record.embedder) ||
      !isNonEmptyString(record.subject) ||
      !isNonEmptyString(record.userId) ||
      !isNonEmptyString(record.sessionIdSha256)
    ) {
      return undefined;
    }
    return record as unknown as EmbedCookiePayload;
  }
}

/** {@link createEmbedSession} 的選項。 */
export interface EmbedSessionOptions {
  readonly tickets: EmbedTicketStore;
  readonly cookies: EmbedSessionCookies;
  readonly identity: EmbedIdentityResolver;
  readonly audit: EmbedAudit;
  readonly trustedHosts?: readonly string[];
  /** 稽核寫不進去時的去處（伺服器日誌）。 */
  readonly warn?: (line: string) => void;
  /**
   * 這一次登入最新開的那條 thread（#2370，`embed-thread-owner.ts` 的 `latestThreadOfLogin`）：兌換成功時回給元件，讓它接著那一條。
   * 缺席（沒有落盤）就不給。查不到不擋兌換：講進伺服器日誌，回應裡沒有 `threadId`。
   */
  readonly latestThread?: (owner: EmbedThreadOwner) => Promise<string | undefined>;
}

/** 兌換的處理器。 */
export interface EmbedSession {
  /** 只會收到 {@link EMBED_SESSION_PATH} 的請求（`serve.ts` 的 `routeBySurface` 分）。 */
  handle(request: Request): Promise<Response>;
}

/** 組兌換的處理器，見檔頭。 */
export function createEmbedSession(options: EmbedSessionOptions): EmbedSession {
  const warn = options.warn ?? (() => undefined);

  async function audited(
    record: Parameters<EmbedAudit['recordRedeem']>[0],
    response: Response,
  ): Promise<Response> {
    try {
      await options.audit.recordRedeem(record);
    } catch (error) {
      warn(`[嵌入兌換] 稽核紀錄寫不進去，這一次不設 cookie：${String(error)}`);
      return plain(500, 'audit unavailable');
    }
    return response;
  }

  async function latestThreadOf(owner: EmbedThreadOwner): Promise<string | undefined> {
    try {
      return await options.latestThread?.(owner);
    } catch (error) {
      options.warn?.(
        `[嵌入換票] 找不到這一次登入開過的對話，兌換照常、不回 threadId：${String(error)}`,
      );
      return undefined;
    }
  }

  return {
    async handle(request) {
      if (!isTrustedWireRequest(request.headers, options.trustedHosts)) {
        return plain(403, 'untrusted host or origin');
      }
      if (request.method !== 'POST') return plain(405, 'method not allowed', { allow: 'POST' });
      const authority = requestAuthority(request.headers);
      const body = await readJsonObject(request, MAX_SESSION_BODY_BYTES);
      const ticket = body.ok ? body.record.ticket : undefined;
      if (
        authority === undefined ||
        !body.ok ||
        Object.keys(body.record).length !== 1 ||
        !isNonEmptyString(ticket) ||
        ticket.length > MAX_TICKET_LENGTH
      ) {
        options.audit.recordUnauthenticated('redeem');
        return json(400, { error: 'bad_request', reason: body.ok ? 'body_shape' : body.reason });
      }

      const redemption = options.tickets.redeem(ticket);
      if (redemption.kind === 'unknown') {
        options.audit.recordUnauthenticated('redeem');
        return json(401, { error: 'ticket_invalid' });
      }
      const { embedder, subject, userId, sessionIdSha256 } = redemption.grant;
      const base = { embedder, subject, userId, sessionIdSha256 };
      if (redemption.kind === 'expired') {
        return audited(
          { outcome: 'ticket_expired', ...base },
          json(401, { error: 'ticket_expired' }),
        );
      }
      const identity = options.identity.resolve(embedder, subject);
      if (identity.kind === 'rejected' || identity.userId !== userId) {
        return audited(
          {
            outcome: 'identity_rejected',
            ...base,
            reason: identity.kind === 'rejected' ? identity.reason : 'user_changed',
          },
          json(403, { error: 'identity_rejected' }),
        );
      }
      const threadId = await latestThreadOf({
        userId,
        embedder,
        loginSessionSha256: sessionIdSha256,
      });
      const cookie = options.cookies.issue(authority, base);
      return audited(
        {
          outcome: 'redeemed',
          ...base,
          cookieExpiresAt: new Date(cookie.expiresAt).toISOString(),
        },
        json(
          200,
          { expiresAt: cookie.expiresAt, ...(threadId !== undefined && { threadId }) },
          { 'set-cookie': cookie.setCookie },
        ),
      );
    },
  };
}
