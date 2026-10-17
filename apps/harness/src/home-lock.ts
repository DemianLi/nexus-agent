/**
 * home 鎖：同一個 harness home 只能起一個 serve，第二個在寫任何檔之前就拒絕
 * （[#1503](https://github.com/DemianLi/nexus-agent/issues/1503)）。
 *
 * 釘選與封存（`thread-organization.ts`）、插件快照（`plugin-snapshot.ts`）、瀏覽器會話密鑰這些 home 層的檔都假設
 * 「只有一個 serve 在寫」。以前這只是 `docs/operations.md` 上的一句提醒：兩台各自把整份集合寫成檔，後寫的蓋掉先寫的；
 * 綁 port 失敗的第二台也早在綁 port 之前就換掉了跑著那台的 `plugin-snapshot.json`。現在拿不到鎖就起不來，
 * **而且是在碰 home 底下任何檔之前**。
 *
 * ## 做法：kernel 鎖，握一整個行程
 *
 * 對 `<home>/serve.lock` 拿非阻塞的 `flock(2)`（`kernel-file-lock.ts`，與會話寫租約共用），握到行程結束：
 * 行程不管怎麼死（`kill -9`、當機、致命退出），kernel 都放鎖，不留要人手動清的殘骸。正常收尾由 `close()`
 * 在**最後一步**放，排在寫入都收完之後（見 `serve.ts`）。致命退出（#1501）是同一條：`close()` 走完才放，卡住的
 * `close()` 撐不過 2 秒上限，行程一結束 kernel 就放。致命退出後**立刻重啟**的新行程，在舊行程還沒結束的那一小段時間
 * 會撞上這把鎖（舊行程確實還握著、還在寫）；舊行程一結束就拿得到。
 *
 * **鎖檔是空的，不寫 PID**（Q2 (a)，同 dsh 的鎖檔不帶內容）：PID 只是拿到鎖那一刻的事實，`lsof <鎖檔>` 查的是
 * kernel 現在的答案，不會被 PID 回收誤導。也因此開檔方式能和會話租約共用（`'w'` 會把內容截掉）。
 *
 * ## 偏離（照 AGENTS.md「技術實現標準」登記）
 *
 * - **偏離 1（基座表達不出來）**：dsh 的行程級獨佔是 Desktop 的 Electron `requestSingleInstanceLock()`
 *   （`apps/desktop/src/single-instance.ts:16-26`，在碰 profile 之前拿、握一整個行程、拿不到就 `quit()`；
 *   `apps/desktop/README.md:118` 寫明 "before any profile access"）。serve 是純 Node 行程，沒有這個 API。退到最接近的
 *   實作：dsh 自己會話租約那顆 `flock`（`@deepseek-ai/node-addon-system/flock`）對 home 底下一個鎖檔取排他鎖。語意對齊
 *   Electron 那把：碰 home 之前拿、整個行程握著、拿不到就不啟動。**不抄**「把後來的啟動轉給持有者」：serve 沒有視窗可以
 *   拉，持有者的網址帶 token，不能印給另一個行程。
 * - **偏離 2（產品需求超出 dsh 的射程）**：dsh 的 CLI／web 對同一個 `$DSH_HOME` 不擋第二個行程，只在文件上定拓撲
 *   （「只有一個活動寫入方」）。nexus 是一台主機多人共用、由管理者用系統帳號起 serve，誤用同一個 home 的機會比個人桌面
 *   高，而且蓋掉的是封存這種會影響模型請求的狀態。所以把 dsh 只寫在文件上的拓撲，在 serve 這個入口變成硬檢查。
 *   **只擋 serve 對 serve**：一次性 CLI 與 `plugin-change` 照 dsh 共用 home（#1412 寫入口的前提）。
 * - **平台拿不到 flock 時照常起來**（Q1 (a)）：同 `session-lease.ts` 已登記的偏離，兩道鎖退化的條件一致。呼叫端講一聲。
 *   `EACCES` 這類其餘錯誤原樣往外拋，不吞成「退到不鎖」。
 *
 * @module
 */

import { mkdir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { lockFileExclusive } from './kernel-file-lock.js';
import type { LockUnavailable, TryLock } from './kernel-file-lock.js';

/** 鎖檔在 home 底下的名字。 */
export const HOME_LOCK_FILE_NAME = 'serve.lock';

/** 這個 home 已經有另一個 serve 握著鎖。訊息講出哪個 home、鎖檔在哪、怎麼查是誰。 */
export class HomeInUseError extends Error {
  override readonly name = 'HomeInUseError';

  constructor(
    readonly home: string,
    readonly lockPath: string,
  ) {
    super(
      `這個 home（${home}）已經有另一個 serve 在用：鎖檔 ${lockPath} 被別的行程握著，` +
        `第二個 serve 會把先寫的檔案蓋掉，所以不起來。` +
        `要並行就各給一個 ${HARNESS_HOME_ENV}；要查是誰握著，執行 lsof ${lockPath}`,
    );
  }
}

/** 一顆握著的 home 鎖。只由 {@link acquireHomeLock} 造；{@link release} 關掉 fd 就是放鎖。 */
export class HomeLock {
  #released = false;
  readonly #handle: FileHandle;

  /** @param handle - 已經鎖到、而且驗過 inode 的那個 fd。 */
  constructor(handle: FileHandle) {
    this.#handle = handle;
  }

  /** 放鎖。鎖檔不刪（保住後來的人要驗的那個 inode）。呼叫第二次是 no-op。 */
  async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    await this.#handle.close();
  }
}

/**
 * 拿 `home` 的 serve 鎖。要排在 serve 碰 home 底下任何檔之前。
 *
 * 先建 `home`（`0700`，同 `prepareJournal` 建 home 的權限），鎖檔 `0600`。
 *
 * @param home - 已解析的 harness home。
 * @param lock - 拿鎖的那一下；預設是 dsh 的 `tryLockExclusive`。測試換得掉。
 * @returns 握著的鎖，或這個平台拿不到的理由（呼叫端講一聲、照常起來）。
 * @throws {@link HomeInUseError} 別的行程握著。
 * @throws 其餘任何建目錄、開檔、flock 的錯誤，原樣。
 */
export async function acquireHomeLock(
  home: string,
  lock?: TryLock,
): Promise<HomeLock | LockUnavailable> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const lockPath = join(home, HOME_LOCK_FILE_NAME);
  const outcome = await lockFileExclusive(lockPath, lock);
  if ('held' in outcome) return new HomeLock(outcome.held);
  if ('contended' in outcome) throw new HomeInUseError(home, lockPath);
  return outcome;
}
