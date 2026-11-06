/**
 * per-thread 下前台轉給對話行程的身分（[#2341](https://github.com/DemianLi/nexus-agent/issues/2341)）。
 *
 * 登入只在前台：前台驗過 cookie 之後，把驗出來的身分放進 {@link PRINCIPAL_HEADER} 往下傳，對話行程照它做嵌入版的擁有者檢查。
 * **信任邊界**：
 *
 * - 前台轉送前一律刪掉客戶端帶來的同名標頭（`front-forward.ts`），只放自己驗出來的那一份；主機擁有者不帶這個標頭。
 * - 只有對話行程的 socket（`peer-socket-auth.ts`，目錄 0700）讀這個標頭。前台的入口（TCP 與 `--unix-socket`，single 與
 *   per-thread 都一樣）走 `browser-auth.ts`／嵌入 cookie，從不讀它。
 * - 解不開、欄位不齊或多出欄位就當沒認證（401），不退回主機擁有者。
 *
 * @module
 */

import type { EmbedPrincipal, WirePrincipal } from './wire-principal.js';
import { OWNER_PRINCIPAL } from './wire-principal.js';

/** 前台放身分的內部標頭。 */
export const PRINCIPAL_HEADER = 'x-nexus-principal';

/** 對話行程在拒絕嵌入身分時帶的內部回應標頭，值是拒絕的原因；前台據此記 `access` 稽核、轉給客戶端前刪掉。 */
export const EMBED_REFUSED_HEADER = 'x-nexus-embed-refused';

const EMBED_FIELDS = ['embedder', 'subject', 'userId', 'sessionIdSha256'] as const;

/** 前台要加的標頭：嵌入身分帶一份，主機擁有者不帶。 */
export function principalHeaders(principal: WirePrincipal): Record<string, string> {
  if (principal.kind === 'owner') return {};
  const value: EmbedPrincipal = {
    kind: 'embed',
    embedder: principal.embedder,
    subject: principal.subject,
    userId: principal.userId,
    sessionIdSha256: principal.sessionIdSha256,
  };
  return { [PRINCIPAL_HEADER]: encodeURIComponent(JSON.stringify(value)) };
}

/**
 * 對話行程這一側：讀前台放的身分。沒有這個標頭是主機擁有者；有但解不開回 `undefined`。
 */
export function forwardedPrincipal(headers: Headers): WirePrincipal | undefined {
  const raw = headers.get(PRINCIPAL_HEADER);
  if (raw === null) return OWNER_PRINCIPAL;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(raw));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.kind !== 'embed') return undefined;
  if (Object.keys(record).length !== EMBED_FIELDS.length + 1) return undefined;
  for (const field of EMBED_FIELDS) {
    if (typeof record[field] !== 'string' || record[field] === '') return undefined;
  }
  return {
    kind: 'embed',
    embedder: record.embedder as string,
    subject: record.subject as string,
    userId: record.userId as string,
    sessionIdSha256: record.sessionIdSha256 as string,
  };
}
