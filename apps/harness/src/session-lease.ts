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
 * ## 鎖檔在哪；只有 Linux 鎖得到
 *
 * 一份會話一把，鎖檔是會話目錄裡的 `session.lock`：每份會話（含每一個 subagent）各有自己的
 * 會話目錄（`@nexus/core` 的 `sessionDirectoryName`），root 不會跟自己的 subagent 搶同一把——flock 以 open file description
 * 為單位，同一個行程開兩次同一個檔也會互斥（實測：第二次回 `EAGAIN`）。v0.5.19 以前寫的舊兩檔用並排的 `<base>.lock`，
 * 續接遷移時另外拿那一把（`jsonl-session-store.ts` 檔頭）。
 *
 * - **只有 Linux 鎖得到。** 拿鎖的那一下在 spawner 裡（`kernel-file-lock.ts`），spawner 只在 Linux 出貨。
 *   **拿不到鎖的平台照常寫、講一聲**，也就是沒有租約。
 *
 * ## 退到不鎖的只有「這個平台沒有」，不是「出了錯」
 *
 * （開檔、flock、驗 inode、這三種分類的實作住在 `kernel-file-lock.ts`，home 鎖共用，#1503。）
 *
 * 失敗分三種，只有一種退：搶不到（`EAGAIN`／`EWOULDBLOCK`）是 {@link SessionAlreadyOwnedError}；
 * 不是 Linux、或找不到 spawner 是 {@link LeaseUnavailable}；
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
 * @param lock - 拿鎖的那一下；預設走 spawner。
 * @returns 握著的租約，或這個平台拿不到的理由。
 * @throws {@link SessionAlreadyOwnedError} 別人握著。
 * @throws 見 {@link lockFileExclusive}。
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
