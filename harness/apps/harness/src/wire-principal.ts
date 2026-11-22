/**
 * wire 請求是誰發的（[#2370](https://github.com/DemianLi/nexus-agent/issues/2370)）。身分只由 serve 驗過簽章的 cookie、
 * 或對話行程的 socket 決定；請求不能自報身分，本文與其他標頭都沒有指定身分的欄位。
 *
 * - `owner`：serve 的擁有者。獨立頁面的會話 cookie（`browser-auth.ts`）與對話行程的 socket（`peer-socket-auth.ts`）都是它，
 *   看得到全部。
 * - `embed`：嵌入方替一位使用者換到的會話（`embed-session.ts`），**只放行 `/embed/` 底下的路徑**，
 *   其餘一律當作沒認證：wire 路由由 `wire-handler.ts` 的 `admit` 判，獨立頁面的靜態檔只認 `browser-auth.ts` 那顆。
 *
 * @module
 */

import { withoutEmbedPrefix } from './embed-profile.js';

/** serve 的擁有者。 */
export interface OwnerPrincipal {
  readonly kind: 'owner';
}

/** 嵌入方替一位使用者換到的會話。 */
export interface EmbedPrincipal {
  readonly kind: 'embed';
  /** 換票的嵌入方 id。 */
  readonly embedder: string;
  /** 對方帳號。 */
  readonly subject: string;
  /** 對應到的 nexus 使用者代號。 */
  readonly userId: string;
  /** 對方登入 session id 的 sha256 hex。 */
  readonly sessionIdSha256: string;
}

export type WirePrincipal = OwnerPrincipal | EmbedPrincipal;

export const OWNER_PRINCIPAL: OwnerPrincipal = Object.freeze({ kind: 'owner' });

/**
 * 這個身分可不可以打這條路徑。
 *
 * @param pathname - 請求的 pathname（不帶 query）。
 */
export function principalMayReach(principal: WirePrincipal, pathname: string): boolean {
  return principal.kind === 'owner' || withoutEmbedPrefix(pathname) !== undefined;
}
