/**
 * 續接一份已存會話之前，兩個入口（CLI 的 `--resume`、serve 碰到一條以前寫過的 thread）
 * 共用的檢查。
 *
 * 只有一條：**它屬於哪個目錄**。沙箱模式要配 `--workspace` 那條沒有搬過來——CLI 那句話
 * 引著 `--resume` 與 USAGE，serve 兩個都沒有，各寫各的比較誠實。
 *
 * @module
 */

import type { StoredSessionHeader } from '@nexus/core';

/**
 * 續接的那份會話屬於另一個目錄——照 dsh 的 `ApiSessionCwdConflict`
 * （`packages/api/session-controller/src/agent.ts`，SHA `c291e79`）。
 *
 * dsh 的會話**按目錄歸屬**：header 的 `cwd` 是建立當下的事實，採用一份已存會話之前先比，
 * 對不上就拒；**沒記 `cwd` 的也拒**，不猜。這是 [#251](https://github.com/DemianLi/nexus-agent/issues/251)
 * 「組合一致」那一件的全部：dsh 在 preset 那一格的規則是「照存的組回來」，而我們沒有 preset
 * ——每個旗標每次都是明著的請求，「照存的組回來」表達不出來，「不符就拒」又會是一條偏離，
 * 所以只抄得到 `cwd` 這一格。
 *
 * 我們這側還多一個後果：`--workspace`、`--plugins` 都照 cwd 解析，換了目錄接回來，同一串
 * 旗標指到的就不是同一個地方。serve 那條另有一個理由：會話根按目錄分（`projectKey`），而
 * 那個目錄名是有損的，兩個不同的目錄可能落在同一格——header 的 `cwd` 是唯一分得開的東西。
 */
export class ResumeCwdConflictError extends Error {
  override readonly name = 'ResumeCwdConflictError';

  /**
   * @param entry - 哪個入口在接（`--resume`、`serve`），訊息開頭講的就是它。
   * @param sessionId - 要續接的那份會話。
   * @param requestedCwd - 這一次的工作目錄。
   * @param existingCwd - header 記的那個，沒記就是 `undefined`。
   */
  constructor(
    readonly entry: string,
    readonly sessionId: string,
    readonly requestedCwd: string,
    readonly existingCwd: string | undefined,
  ) {
    super(
      existingCwd === undefined
        ? `${entry} 接不回來：會話 "${sessionId}" 沒記下它屬於哪個目錄，不能接到 ${requestedCwd}。`
        : `${entry} 接不回來：會話 "${sessionId}" 屬於 ${existingCwd}，不是 ${requestedCwd}。` +
            `回到那個目錄再接。`,
    );
  }
}

/**
 * header 記的目錄就是這一次的，否則拋。
 *
 * @param entry - 哪個入口在接。
 * @param sessionId - 那份會話。
 * @param header - 讀回來的 header，原樣。
 * @param cwd - 這一次的工作目錄。
 * @throws {@link ResumeCwdConflictError} 對不上，或沒記。
 */
export function assertSameCwd(
  entry: string,
  sessionId: string,
  header: StoredSessionHeader,
  cwd: string,
): void {
  if (header.cwd !== cwd) throw new ResumeCwdConflictError(entry, sessionId, cwd, header.cwd);
}
