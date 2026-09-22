/**
 * 續接一份已存會話之前，兩個入口（CLI 的 `--resume`、serve 碰到一條以前寫過的 thread）
 * 共用的檢查。
 *
 * 兩條，而且**它們對「沒記」的處置相反**，所以是兩個函式不是一個：
 *
 * - {@link assertSameCwd}：**它屬於哪個目錄**。沒記也拒——不猜。
 * - {@link assertSameWorkspaceRoot}：**它跑在哪個工作區根底下**（[#504](https://github.com/DemianLi/nexus-agent/issues/504)）。
 *   **沒記就放行**——13 以前的日誌每一份都沒有那一格，那是常態不是異常。
 *
 * 揉成一個入口會把這個不對稱藏起來，所以刻意不揉。兩個入口（CLI 的 `--resume`、serve）
 * **兩條都要叫，而且目錄那條先**：目錄不對的話，日誌裡記的是哪一格都不該拿來判。
 *
 * 沙箱模式要配 `--workspace` 那條沒有搬過來——CLI 那句話引著 `--resume` 與 USAGE，serve
 * 兩個都沒有，各寫各的比較誠實。
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
 * 我們這側還多一個後果：`--workspace`、`--patch` 都照 cwd 解析，換了目錄接回來，同一串
 * 旗標指到的就不是同一個地方。**反過來不成立**——同一個目錄底下換一個 `--workspace`，這一格
 * 一模一樣，那一半由 {@link assertSameWorkspaceRoot} 擋（[#504](https://github.com/DemianLi/nexus-agent/issues/504)）。serve 那條另有一個理由：會話根按目錄分（`projectKey`），而
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

/**
 * 續接的那份會話跑在另一個工作區根底下（[#504](https://github.com/DemianLi/nexus-agent/issues/504)）。
 *
 * **`cwd` 那一格分不出這件事**：`--workspace` 照 cwd 解析（`cli.ts` 的 `resolveWorkspaceRoot`），
 * 所以「同一個目錄、不同的 `--workspace`」在 {@link assertSameCwd} 底下是通的，而那一次接回來，
 * 一顆重播的 `deliverables/presented` 記的路徑會指到**另一個工作區裡的同名檔**，畫面上跟讀對了
 * 一模一樣。
 *
 * dsh 沒有這個分岔：它的會話 `cwd` **就是**工作區根，所以它的 header 不需要第二格。兩處出處
 * （`ddefc45`）：`packages/sandbox/sandbox-policy/src/index.ts:83`「Calling session; its immutable
 * cwd becomes the workspace boundary.」與 `:168` 的
 * `resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot)`；
 * `packages/deliverables/workspace-changes/src/index.ts:58-61` 的 `eligible` 直接回 `header.cwd`。
 * （#504 的 triage 把這兩行引成 `packages/core/sandbox-policy/…`，`ddefc45` 上沒有那個路徑；
 * 行號與內容對得上，錯的只有套件位置。）
 */
export class ResumeWorkspaceConflictError extends Error {
  override readonly name = 'ResumeWorkspaceConflictError';

  /**
   * @param entry - 哪個入口在接（`--resume`、`serve`），訊息開頭講的就是它。
   * @param sessionId - 要續接的那份會話。
   * @param requestedRoot - 這一次 `--workspace` 解析出來的根。
   * @param existingRoot - header 記的那個。
   */
  constructor(
    readonly entry: string,
    readonly sessionId: string,
    readonly requestedRoot: string,
    readonly existingRoot: string,
  ) {
    super(
      `${entry} 接不回來：會話 "${sessionId}" 跑在工作區 ${existingRoot} 底下，` +
        `不是 ${requestedRoot}。那份日誌記下的檔案路徑錨在前者，接到後者上讀到的會是` +
        `另一個工作區裡的同名檔。用 --workspace ${existingRoot} 再接。`,
    );
  }
}

/**
 * header 記的工作區根就是這一次的，否則拋。**四格全部寫出來**：
 *
 * | header 的 `workspaceRoot` | 這一次 | 處置 |
 * | --- | --- | --- |
 * | 沒記 | 有無皆可 | **放行**——13 以前的日誌每一份都沒有這一格，那是常態 |
 * | 有記 | 這次沒給 `--workspace` | **放行**（理由見下） |
 * | 有記 | 跟這次不同 | **拒**，訊息指名兩個根 |
 * | 有記 | 跟這次相同 | 放行 |
 *
 * **第二列放行的理由不是「別的守衛管了」。** `serve.ts` 那條沙箱模式檢查看的是日誌裡有沒有
 * `sandbox/mode`，而 sandbox-policy 那顆 plugin 被一份 patch 關掉時，上一次確實跑在
 * `--workspace` 底下卻一顆都沒寫——那條不會響。真正的理由是**沒給 `--workspace` 就沒有根**，
 * 而交付那兩條讀檔路由在沒有根的時候**每一次讀都拒**：`wire-handler.ts` 的
 * `locateRequested` 在 `state.workspaceRoot === undefined` 時回 `no-anchor`，而
 * `no-anchor` 對到 404。讀不到檔，就沒有讀錯檔這回事。
 *
 * **不 `realpath`，直接 `!==`**——同旁邊的 {@link assertSameCwd}。兩道守衛同形才不會有一天
 * 一邊認得符號連結、另一邊不認得。經過符號連結到達同一個目錄會被誤拒，那是保守的方向，
 * 跟 #452「沒錨就拒，不猜」同一個態度。
 *
 * **header 那一格沒有經過驗證，而這裡不承重。** `jsonl-session-store.ts` 的 `parseHeader` 是
 * 直接 cast（`cwd` 今天也一樣沒驗），所以磁碟上那一格可能是 `42`、`null` 或空字串。下面三行
 * 對每一種畸形值都是 fail-closed：只有 `undefined` 走得到放行，其餘一律進逐字比較而拋。
 * 真要加驗證，得先決定「壞檔」與「沒記」怎麼分，那是一道還沒有人回答的新題。
 *
 * @param entry - 哪個入口在接。
 * @param sessionId - 那份會話。
 * @param header - 讀回來的 header，原樣。
 * @param workspaceRoot - 這一次 `--workspace` 解析出來的根，沒給就是 `undefined`。
 * @throws {@link ResumeWorkspaceConflictError} 兩邊都有、而且不同。
 */
export function assertSameWorkspaceRoot(
  entry: string,
  sessionId: string,
  header: StoredSessionHeader,
  workspaceRoot: string | undefined,
): void {
  if (header.workspaceRoot === undefined) return;
  if (workspaceRoot === undefined) return;
  if (header.workspaceRoot !== workspaceRoot) {
    throw new ResumeWorkspaceConflictError(entry, sessionId, workspaceRoot, header.workspaceRoot);
  }
}
