/**
 * 一份會話的跨行程寫租約——照 dsh 的 `session-persistence-jsonl/src/lease.ts`
 * （本地 clone SHA `c291e7961a515f6d7af9304e7fd1d257929aef26`）。
 *
 * **仲裁者是 kernel**：對鎖檔拿一顆非阻塞的 `flock(2)`，握到把手關掉為止。行程死了 kernel
 * 就放鎖，所以當掉的持有者擋不住下一個；**刻意沒有逾期**——卡住但還活著的持有者不會被搶，
 * 搶了的話它醒來續寫就把日誌撕開。flock 鎖的是 inode 不是路徑，所以鎖到之後驗一次路徑上
 * 那個檔還是鎖到的那個，不是就重來（dsh 同條，上限三次）。釋放不刪鎖檔：留著的檔保住
 * 後來的人要驗的那個 inode。讀方不碰鎖。
 *
 * ## 和 dsh 不同的兩處
 *
 * - **一份會話一把，而且鎖檔跟日誌並排**（`<base>.lock`），不是 dsh 的「目錄裡一個
 *   `session.lock`」。dsh 的目錄就是一份會話；我們的 run 目錄裝著 root 與它每一個
 *   subagent。整個目錄一把的話，root 會跟**自己的** subagent 搶——flock 以 open file
 *   description 為單位，同一個行程開兩次同一個檔也會互斥（實測：第二次回 `EAGAIN`）。
 * - **只有 macOS 與 Linux 鎖得到。** 原生那一半是 dsh 自己出的預編譯 Node-API 模組
 *   `@deepseek-ai/node-addon-system`（平台二進位走 optionalDependencies，沒有 install
 *   script，所以 `onlyBuiltDependencies` 不必動）。它只出 darwin／linux；dsh 的 Windows 走
 *   另一條具名 semaphore，我們沒抄。**拿不到鎖的平台照常寫、講一聲**——這是一條偏離：
 *   dsh 在那些平台上有鎖，我們退到「沒有租約」，也就是這一刀之前的狀態。
 *
 * ## 退到不鎖的只有「這個平台沒有」，不是「出了錯」
 *
 * （開檔、flock、驗 inode、這四種分類的實作住在 `kernel-file-lock.ts`，home 鎖共用，#1503。）
 *
 * 失敗分四種，只有兩種退：搶不到（`EAGAIN`／`EWOULDBLOCK`）是 {@link SessionAlreadyOwnedError}；
 * 平台不支援、或原生模組載不起來（缺平台套件、libc 對不上）是 {@link LeaseUnavailable}；
 * **其餘一律往外拋**（`EACCES`、`EIO`……）。一個什麼錯都吞成「退到不鎖」的分類，會讓一次
 * 權限問題悄悄關掉整道租約——護欄還在，但沒在擋。
 *
 * @module
 */

import type { FileHandle } from 'node:fs/promises';
import { SessionAlreadyOwnedError } from '@nexus/core';
import { lockFileExclusive } from './kernel-file-lock.js';
import type { LockUnavailable, TryLock } from './kernel-file-lock.js';

export type { TryLock };

/** 這個平台拿不到鎖：照常寫，由呼叫端講一聲。 */
export type LeaseUnavailable = LockUnavailable;

/** 一顆握著的鎖。只由 {@link acquireSessionLease} 造；{@link release} 關掉 fd 就是放鎖。 */
export class SessionWriteLease {
  #released = false;
  readonly #handle: FileHandle;

  /** @param handle - 已經鎖到、而且驗過 inode 的那個 fd。 */
  constructor(handle: FileHandle) {
    this.#handle = handle;
  }

  /** 放鎖。鎖檔不刪（見模組說明）。呼叫第二次是 no-op。 */
  async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    await this.#handle.close();
  }
}

/**
 * 拿 `path` 那個鎖檔的寫租約。**不建目錄**：建目錄是呼叫端的事——續接那條路上一個打錯的
 * `--resume` 不該憑空長出目錄。
 *
 * @param path - 鎖檔路徑。
 * @param id - 它守的那份會話，錯誤訊息用。
 * @param lock - 拿鎖的那一下；預設是 dsh 的 `tryLockExclusive`。
 * @returns 握著的租約，或這個平台拿不到的理由。
 * @throws {@link SessionAlreadyOwnedError} 別人握著。
 * @throws 其餘任何開檔、stat、或 flock 的錯誤，原樣。
 */
export async function acquireSessionLease(
  path: string,
  id: string,
  lock?: TryLock,
): Promise<SessionWriteLease | LeaseUnavailable> {
  // 開檔、flock、驗 inode、最多三次、四種失敗的分類：和 home 鎖共用（`kernel-file-lock.ts`，#1503）。
  const outcome = await lockFileExclusive(path, lock);
  if ('held' in outcome) return new SessionWriteLease(outcome.held);
  if ('contended' in outcome) throw new SessionAlreadyOwnedError(id);
  return outcome;
}
