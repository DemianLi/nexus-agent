/**
 * `el.signIn(ticket)` 的那一下（[#2370](https://github.com/DemianLi/nexus-agent/issues/2370)）：拿宿主系統後端換來的登入票打
 * `POST /embed/session`，serve 設一顆只打得到嵌入路由的 cookie。回應的形狀與每一種失敗見 serve 的 `apps/harness/src/embed-session.ts` 檔頭。
 *
 * 票只當參數收，不放進屬性，也不記在任何地方：留在 DOM 或 storage 裡，宿主頁上的任何腳本都讀得到。
 *
 * @module
 */

import { EMBED_PATH_PREFIX } from '@nexus/wire';

/** serve 回的失敗碼，宿主頁照它決定下一步；其餘的失敗（票不是非空字串、網路斷了、serve 沒開換票、回應看不懂）一律是 `sign_in_failed`。 */
export type NexusSignInErrorCode =
  'ticket_invalid' | 'ticket_expired' | 'identity_rejected' | 'sign_in_failed';

const SERVER_CODES: ReadonlySet<string> = new Set([
  'ticket_invalid',
  'ticket_expired',
  'identity_rejected',
]);

/** `signIn` reject 的錯誤。 */
export class NexusSignInError extends Error {
  override readonly name = 'NexusSignInError';

  constructor(
    readonly code: NexusSignInErrorCode,
    message: string,
    /** HTTP 狀態碼；請求沒有送到就沒有。 */
    readonly status?: number,
  ) {
    super(message);
  }
}

/** 兌換成功。 */
export interface RedeemedTicket {
  /** cookie 的到期時間，系統時間的毫秒時間戳。 */
  readonly expiresAt: number;
  /** 這一次登入最新開的那條嵌入對話；沒有就沒有這一格。 */
  readonly threadId?: string;
}

async function errorCode(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    const code = (body as { error?: unknown } | null)?.error;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 兌換一張登入票。
 *
 * @param agentBaseUrl - agent 的位置，`agentBaseUrl()` 算出來的那個（例如 `/nexus`，掛在根路徑是空字串）。
 * @throws {@link NexusSignInError} 兌換不成。`ticket` 不是非空字串時是 `sign_in_failed`，不發請求。
 */
export async function redeemTicket(
  agentBaseUrl: string,
  ticket: unknown,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<RedeemedTicket> {
  if (typeof ticket !== 'string' || ticket === '') {
    throw new NexusSignInError('sign_in_failed', '<nexus-chat> 的 signIn(ticket) 要給非空字串');
  }
  let response: Response;
  try {
    response = await fetch(`${agentBaseUrl}${EMBED_PATH_PREFIX}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket }),
      credentials: 'same-origin',
    });
  } catch (error) {
    throw new NexusSignInError('sign_in_failed', `兌換請求沒有送到：${String(error)}`);
  }
  if (!response.ok) {
    const code = await errorCode(response);
    throw new NexusSignInError(
      code !== undefined && SERVER_CODES.has(code)
        ? (code as NexusSignInErrorCode)
        : 'sign_in_failed',
      `兌換被拒：HTTP ${String(response.status)}${code === undefined ? '' : ` ${code}`}`,
      response.status,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const expiresAt = (body as { expiresAt?: unknown } | null | undefined)?.expiresAt;
  const threadId = (body as { threadId?: unknown } | null | undefined)?.threadId;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    throw new NexusSignInError(
      'sign_in_failed',
      '兌換的回應看不懂：沒有 expiresAt',
      response.status,
    );
  }
  return typeof threadId === 'string' && threadId !== '' ? { expiresAt, threadId } : { expiresAt };
}
