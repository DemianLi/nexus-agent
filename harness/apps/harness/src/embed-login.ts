/**
 * 嵌入方換票（[#2370](https://github.com/DemianLi/nexus-agent/issues/2370)，地圖 #2365 第 4 點）：對方的後端用服務憑證打
 * `POST /embed/exchange`，替一位使用者換一張短效、只能用一次的登入票；元件拿票打 `POST /embed/session` 換嵌入專用的會話（`embed-session.ts`）。
 *
 * - **只在前台行程**：登入只在前台（`serve-run.ts` 的 `ServeListening`），對話行程不掛這條路由。
 * - **圍欄**：先過 `isTrustedWireRequest`（Host 不是 loopback 也不是 `--trusted-host` 指名的、`Sec-Fetch-Site: cross-site`、Origin 跟 Host 不同源，一律 403），同 wire 與指標。
 * - **服務憑證**：`Authorization: Bearer <憑證>`。拿請求帶的值與**每一個**嵌入方的憑證各比一次，比的是兩邊的 sha256（定長），
 *   不提早結束。缺標頭時拿一個空字串照樣比完。所以 401 的本文與耗時看不出缺憑證、憑證錯，或是哪一個嵌入方；請求本文裡也沒有嵌入方 id。
 * - **身分**：`{ subject }` 交給 {@link EmbedIdentityResolver}。產品用管理者寫的對應表（`embed-identities.ts`，#1827 D231），
 *   不在表上就拒。換到票的人只打得開自己開的嵌入版 thread（`embed-thread-owner.ts`）。
 * - **票**：32 位元組亂數，只放在記憶體（{@link EmbedTicketStore}）；重啟就作廢。過期的與用過的都刪掉，同時在手的票有上限。
 * - **稽核**：過了服務憑證的每一次都記（`embed-audit.ts`），記好才回應，寫不進去就 500、不發票。憑證錯的只計數合併、不等落盤；
 *   圍欄的 403 與 405 不記。
 *
 * 回應：發票 `200 { ticket, expiresAt }`；憑證不對 `401`；身分被拒 `403 { error: 'identity_rejected' }`；本文不對 `400`；
 * 票滿了 `503`；方法不對 `405`。都帶 `cache-control: no-store`。
 *
 * @module
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { EMBED_PATH_PREFIX } from '@nexus/wire';

import { sessionIdDigest } from './embed-audit.js';
import type { EmbedAudit } from './embed-audit.js';
import { json, plain, readJsonObject } from './embed-http.js';
import type { BodyRejection } from './embed-http.js';
import { isTrustedWireRequest } from './request-trust.js';

/** 換票的路徑（反向代理後面是 `/nexus/embed/exchange`）。 */
export const EMBED_EXCHANGE_PATH = `${EMBED_PATH_PREFIX}/exchange`;

/** 請求本文的上限（位元組）。 */
export const MAX_EXCHANGE_BODY_BYTES = 4096;
/** `subject` 與 `sessionId` 的長度上限（字元）。 */
export const MAX_FIELD_LENGTH = 256;
/** 同時在手（還沒兌換、還沒過期）的票的上限。 */
export const MAX_OUTSTANDING_TICKETS = 1024;

const TICKET_BYTES = 32;

/** 一個能換票的嵌入方。 */
export interface EmbedderCredential {
  readonly id: string;
  /** 服務憑證（檔案的內容，不含換行）。 */
  readonly credential: string;
}

/** 對方帳號對應到 nexus 身分的結果。 */
export type EmbedIdentity =
  | { readonly kind: 'accepted'; readonly userId: string }
  | { readonly kind: 'rejected'; readonly reason: string };

/** 對方帳號 → nexus 身分。產品的實作是管理者寫的對應表（`embed-identities.ts`）。 */
export interface EmbedIdentityResolver {
  /**
   * 對一位對方帳號作出決定。同步、不得拋錯。
   *
   * @param embedder - 過了服務憑證的嵌入方 id。
   * @param subject - 請求本文的 `subject`，已驗過非空且不超過 256 字元。
   * @returns `rejected.reason` 原樣寫進稽核紀錄，不得帶秘密。
   */
  resolve(embedder: string, subject: string): EmbedIdentity;
}

/** 一張票代表的登入。 */
export interface EmbedGrant {
  /** 過了服務憑證的嵌入方 id。 */
  readonly embedder: string;
  /** 對方帳號。 */
  readonly subject: string;
  /** nexus 身分（{@link EmbedIdentityResolver} 給的）。 */
  readonly userId: string;
  /** 對方登入 session id 的 sha256 hex（`sessionIdDigest`）。 */
  readonly sessionIdSha256: string;
  /** 到期時間，系統時間的毫秒時間戳；回給對方看的，兌換時判到期用的是單調時鐘。 */
  readonly expiresAt: number;
}

/** {@link EmbedTicketStore.redeem} 的結果。 */
export type TicketRedemption =
  | { readonly kind: 'redeemed'; readonly grant: EmbedGrant }
  /** 查到了但已過期；這張票也一併刪掉。 */
  | { readonly kind: 'expired'; readonly grant: EmbedGrant }
  /** 沒有這張、用過了，或過期之後已經被清掉。 */
  | { readonly kind: 'unknown' };

interface StoredTicket {
  readonly grant: EmbedGrant;
  /** 單調時鐘上的到期點。 */
  readonly deadline: number;
}

/**
 * 登入票：只在記憶體，只能兌換一次。
 *
 * 到期用單調時鐘判，系統時間被往回或往前調都不影響；回給對方的 `expiresAt` 才用系統時間。票的有效期固定、單調時鐘不倒退，
 * 所以 `Map` 的插入順序就是到期順序：清過期的只要從頭清到第一張還沒過期的。
 * 兌換是同步的「查到就刪」，兩個請求同時兌換同一張票時只有先執行到的那一個拿到。
 */
export class EmbedTicketStore {
  readonly #tickets = new Map<string, StoredTicket>();
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #monotonicNow: () => number;
  readonly #wallNow: () => number;

  /**
   * @param ttlMs - 票的有效期（毫秒）。
   * @param max - 同時在手的上限。
   * @param monotonicNow - 單調時鐘（毫秒）；測試換掉。
   * @param wallNow - 系統時間，只用來算回給對方的 `expiresAt`；測試換掉。
   */
  constructor(
    ttlMs: number,
    max: number = MAX_OUTSTANDING_TICKETS,
    monotonicNow: () => number = () => performance.now(),
    wallNow: () => number = Date.now,
  ) {
    this.#ttlMs = ttlMs;
    this.#max = max;
    this.#monotonicNow = monotonicNow;
    this.#wallNow = wallNow;
  }

  /** 在手的票數（含已過期還沒清的）。 */
  get size(): number {
    return this.#tickets.size;
  }

  #prune(at: number): void {
    for (const [ticket, stored] of this.#tickets) {
      if (stored.deadline > at) return;
      this.#tickets.delete(ticket);
    }
  }

  /**
   * 發一張票。
   *
   * @returns 票與到期時間（系統時間的毫秒時間戳）；在手的票滿了回 `undefined`。
   */
  issue(
    grant: Omit<EmbedGrant, 'expiresAt'>,
  ): { readonly ticket: string; readonly expiresAt: number } | undefined {
    const at = this.#monotonicNow();
    this.#prune(at);
    if (this.#tickets.size >= this.#max) return undefined;
    const ticket = randomBytes(TICKET_BYTES).toString('base64url');
    const expiresAt = this.#wallNow() + this.#ttlMs;
    this.#tickets.set(ticket, { grant: { ...grant, expiresAt }, deadline: at + this.#ttlMs });
    return { ticket, expiresAt };
  }

  /** 兌換一張票。查到就刪，不論有沒有過期；先查再清，過期的才分得出來。 */
  redeem(ticket: string): TicketRedemption {
    const at = this.#monotonicNow();
    const stored = this.#tickets.get(ticket);
    if (stored !== undefined) this.#tickets.delete(ticket);
    this.#prune(at);
    if (stored === undefined) return { kind: 'unknown' };
    return stored.deadline > at
      ? { kind: 'redeemed', grant: stored.grant }
      : { kind: 'expired', grant: stored.grant };
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * 找出這把憑證屬於哪一個嵌入方。每一個都比、不提早結束；比的是 sha256，長度固定。
 *
 * @param presented - 請求帶的憑證；缺標頭時是空字串。
 */
function matchEmbedder(
  presented: string,
  embedders: readonly { readonly id: string; readonly digest: Buffer }[],
): string | undefined {
  const actual = digest(presented);
  let matched: string | undefined;
  for (const embedder of embedders) {
    if (timingSafeEqual(actual, embedder.digest) && presented.length > 0) matched = embedder.id;
  }
  return matched;
}

/** `Authorization: Bearer <值>` 的值；不是這個形狀回空字串。 */
function bearerOf(headers: Headers): string {
  const value = headers.get('authorization') ?? '';
  const match = /^Bearer ([^\s]+)$/u.exec(value);
  return match?.[1] ?? '';
}

function isField(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_FIELD_LENGTH;
}

/** 解析 `{ subject, sessionId }`；不對回原因。 */
async function parseExchangeBody(
  request: Request,
): Promise<
  | { readonly ok: true; readonly subject: string; readonly sessionId: string }
  | { readonly ok: false; readonly reason: BodyRejection; readonly subject?: string }
> {
  const body = await readJsonObject(request, MAX_EXCHANGE_BODY_BYTES);
  if (!body.ok) return body;
  const { record } = body;
  const subject = isField(record.subject) ? record.subject : undefined;
  if (subject === undefined || !isField(record.sessionId) || Object.keys(record).length !== 2) {
    return { ok: false, reason: 'body_shape', ...(subject !== undefined && { subject }) };
  }
  return { ok: true, subject, sessionId: record.sessionId };
}

/** {@link createEmbedLogin} 的選項。 */
export interface EmbedLoginOptions {
  readonly embedders: readonly EmbedderCredential[];
  readonly identity: EmbedIdentityResolver;
  readonly tickets: EmbedTicketStore;
  readonly audit: EmbedAudit;
  readonly trustedHosts?: readonly string[];
  /** 稽核寫不進去時的去處（伺服器日誌）。 */
  readonly warn?: (line: string) => void;
}

/** 換票的處理器。 */
export interface EmbedLogin {
  /** 只會收到 {@link EMBED_EXCHANGE_PATH} 的請求（`serve-run.ts` 的 `routeBySurface` 分）。 */
  handle(request: Request): Promise<Response>;
}

/** 組換票的處理器，見檔頭。 */
export function createEmbedLogin(options: EmbedLoginOptions): EmbedLogin {
  const embedders = options.embedders.map((embedder) => ({
    id: embedder.id,
    digest: digest(embedder.credential),
  }));
  const warn = options.warn ?? (() => undefined);

  async function audited(
    record: Parameters<EmbedAudit['recordExchange']>[0],
    response: Response,
  ): Promise<Response> {
    try {
      await options.audit.recordExchange(record);
    } catch (error) {
      warn(`[嵌入換票] 稽核紀錄寫不進去，這一次不發票：${String(error)}`);
      return plain(500, 'audit unavailable');
    }
    return response;
  }

  return {
    async handle(request) {
      if (!isTrustedWireRequest(request.headers, options.trustedHosts)) {
        return plain(403, 'untrusted host or origin');
      }
      if (request.method !== 'POST') return plain(405, 'method not allowed', { allow: 'POST' });

      const embedder = matchEmbedder(bearerOf(request.headers), embedders);
      if (embedder === undefined) {
        options.audit.recordUnauthenticated();
        return plain(401, 'unauthorized');
      }

      const body = await parseExchangeBody(request);
      if (!body.ok) {
        return audited(
          {
            outcome: 'bad_request',
            embedder,
            reason: body.reason,
            ...(body.subject !== undefined && { subject: body.subject }),
          },
          json(400, { error: 'bad_request', reason: body.reason }),
        );
      }
      const sessionIdSha256 = sessionIdDigest(body.sessionId);
      const base = { embedder, subject: body.subject, sessionIdSha256 };

      const identity = options.identity.resolve(embedder, body.subject);
      if (identity.kind === 'rejected') {
        return audited(
          { outcome: 'identity_rejected', ...base, reason: identity.reason },
          json(403, { error: 'identity_rejected' }),
        );
      }

      const grant = { ...base, userId: identity.userId };
      const issued = options.tickets.issue(grant);
      if (issued === undefined) {
        return audited(
          { outcome: 'capacity', ...base, userId: identity.userId },
          json(503, { error: 'capacity' }),
        );
      }
      const response = await audited(
        { outcome: 'issued', ...base, userId: identity.userId },
        json(200, { ticket: issued.ticket, expiresAt: issued.expiresAt }),
      );
      // 記不進去：剛發的票作廢，不留一張沒有紀錄的票。
      if (response.status !== 200) options.tickets.redeem(issued.ticket);
      return response;
    },
  };
}
