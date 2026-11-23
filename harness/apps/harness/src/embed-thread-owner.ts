/**
 * 嵌入版 thread 的擁有者（[#2370](https://github.com/DemianLi/nexus-agent/issues/2370)，#1827 D231 Q3）：嵌入身分只打得開自己開的 thread。
 *
 * - **誰開就歸誰**：嵌入身分開的新 thread，header 記下 `owner` 與 `embedOrigin`（`session-store.ts` 的 54 那段）。
 *   主機擁有者從嵌入路徑開的不記，那種 thread 沒有擁有者。
 * - **怎麼比**：使用者代號與嵌入方都要對上；對應表允許兩個嵌入方對到同一個使用者代號，
 *   從不同嵌入方進來看到的歷史是分開的。
 * - **主機擁有者**打得開任何一條；**沒有擁有者的**嵌入身分一律打不開。
 *
 * @module
 */

import type { SessionStore, StoredSessionHeader } from '@nexus/core';

import { listVisibleThreads } from './session-list.js';
import type { WirePrincipal } from './wire-principal.js';

/** 一條嵌入版 thread 的擁有者，兩格 header（`owner`、`embedOrigin`）攤平。 */
export interface EmbedThreadOwner {
  readonly userId: string;
  readonly embedder: string;
  /** 開它的那一次登入；只拿來找「這一次登入最新的那一條」，不參與能不能開。 */
  readonly loginSessionSha256: string;
}

/** 這個身分開新 thread 時要記的擁有者；主機擁有者回 `undefined`。 */
export function ownerToRecord(principal: WirePrincipal): EmbedThreadOwner | undefined {
  return principal.kind === 'embed'
    ? {
        userId: principal.userId,
        embedder: principal.embedder,
        loginSessionSha256: principal.sessionIdSha256,
      }
    : undefined;
}

/** header 記的擁有者；沒記回 `undefined`。 */
export function ownerOfHeader(header: StoredSessionHeader): EmbedThreadOwner | undefined {
  return header.owner === undefined || header.embedOrigin === undefined
    ? undefined
    : {
        userId: header.owner.userId,
        embedder: header.embedOrigin.embedder,
        loginSessionSha256: header.embedOrigin.loginSessionSha256,
      };
}

/** 寫進 header 的兩格（`attachSessionPersistence` 的 `rootOwner`）。 */
export function headerFieldsOf(owner: EmbedThreadOwner): {
  readonly owner: { readonly userId: string };
  readonly embedOrigin: { readonly embedder: string; readonly loginSessionSha256: string };
} {
  return {
    owner: { userId: owner.userId },
    embedOrigin: { embedder: owner.embedder, loginSessionSha256: owner.loginSessionSha256 },
  };
}

/** 這個身分打不打得開擁有者是 `owner` 的嵌入版 thread。 */
export function mayOpenEmbedThread(
  principal: WirePrincipal,
  owner: EmbedThreadOwner | undefined,
): boolean {
  if (principal.kind === 'owner') return true;
  return (
    owner !== undefined &&
    owner.userId === principal.userId &&
    owner.embedder === principal.embedder
  );
}

/**
 * 這一次登入最新開的那一條（#2370）：落盤的 thread 裡，列表列得出來（`session-list.ts` 的 `isListedThread`）、擁有者與嵌入方對上、
 * 而且是同一次登入開的，取 `createdAt` 最晚的；同一毫秒取 id 大的，結果才固定。
 *
 * @returns thread id；這一次登入還沒開過（或開了還沒落盤）回 `undefined`。
 * @throws 存放處讀不到。
 */
export async function latestThreadOfLogin(
  store: SessionStore,
  cwd: string,
  owner: EmbedThreadOwner,
): Promise<string | undefined> {
  const { items } = await listVisibleThreads(store, cwd);
  let latest: StoredSessionHeader | undefined;
  for (const { header } of items) {
    const recorded = ownerOfHeader(header);
    if (
      recorded === undefined ||
      recorded.userId !== owner.userId ||
      recorded.embedder !== owner.embedder ||
      recorded.loginSessionSha256 !== owner.loginSessionSha256
    ) {
      continue;
    }
    if (
      latest === undefined ||
      header.createdAt > latest.createdAt ||
      (header.createdAt === latest.createdAt && header.id > latest.id)
    ) {
      latest = header;
    }
  }
  return latest?.id;
}
