/**
 * 對一個鎖檔拿非阻塞的 kernel 排他鎖——會話寫租約（`session-lease.ts`）與 home 鎖（`home-lock.ts`）共用的那一段
 * （[#1503](https://github.com/DemianLi/nexus-agent/issues/1503)）。
 *
 * 照 dsh 的 `session-persistence-jsonl/src/lease.ts`（`:90-115` POSIX 分支，SHA `1517a4db`）：開檔、對 fd 拿非阻塞
 * `flock(2)`、**鎖到之後驗一次路徑上那個檔還是鎖到的那個**（flock 鎖的是 inode 不是路徑，檔在中間被刪了又建就重來，
 * 最多三次）。握到把手關掉為止；行程死了 kernel 放鎖。**刻意沒有逾期**，卡住但活著的持有者不會被搶。釋放不刪鎖檔。
 *
 * 這裡只管「拿到沒有」，不管拿不到的時候丟什麼錯、怎麼講：那是呼叫端的語言（`SessionAlreadyOwnedError`、
 * `HomeInUseError`）。從 `session-lease.ts` 原樣抽出，行為不變——開檔方式（`'w'`、`0600`）、失敗的四種分類、
 * 退到不鎖的條件都沒動。
 *
 * ## 失敗分四種，只有兩種退
 *
 * 搶不到（`EAGAIN`／`EWOULDBLOCK`，或三次都撞上被換掉的 inode）是 `contended`；平台不支援、或原生模組載不起來
 * （缺平台套件、libc 對不上）是 `unavailable`；**其餘一律往外拋**（`EACCES`、`EIO`……）。一個什麼錯都吞成
 * 「退到不鎖」的分類，會讓一次權限問題悄悄關掉整道鎖——護欄還在，但沒在擋。
 *
 * @module
 */

import { open, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock';

/** 對一個已開的 fd 拿非阻塞的排他鎖。預設是 dsh 那顆；測試換得掉。 */
export type TryLock = (fd: number) => Promise<void>;

/** 這個平台拿不到鎖：照常往下走，由呼叫端講一聲。 */
export interface LockUnavailable {
  readonly unavailable: string;
}

/** 拿到了：把手握著的就是鎖，關掉它就是放鎖。 */
export interface LockHeld {
  readonly held: FileHandle;
}

/** 別人握著。 */
export interface LockContended {
  readonly contended: true;
}

/** 認得出來的「這個平台沒有」。其餘的錯不在這裡。 */
const UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  // dsh 的 loader 在非 linux／darwin 上拋的。
  'ERR_FLOCK_UNSUPPORTED_PLATFORM',
  // 平台套件沒裝上（optionalDependencies 本來就可能沒裝）。
  'MODULE_NOT_FOUND',
  'ERR_MODULE_NOT_FOUND',
  // 二進位在，但這個行程載不起來（例如 glibc／musl 對不上）。
  'ERR_DLOPEN_FAILED',
]);

function codeOf(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

/**
 * 開 `path` 並對它拿排他鎖。**不建目錄**：建目錄是呼叫端的事。
 *
 * @param path - 鎖檔路徑。
 * @param lock - 拿鎖的那一下；預設是 dsh 的 `tryLockExclusive`。
 * @returns 握著的把手、別人握著、或這個平台拿不到。
 * @throws 其餘任何開檔、stat、或 flock 的錯誤，原樣。
 */
export async function lockFileExclusive(
  path: string,
  lock: TryLock = tryLockExclusive,
): Promise<LockHeld | LockContended | LockUnavailable> {
  // 有界的重試：鎖到的 inode 若已被換掉（刪了又建），重開路徑上現在那一個；平常一圈就好。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const handle = await open(path, 'w', 0o600);
    try {
      try {
        await lock(handle.fd);
      } catch (error: unknown) {
        const code = codeOf(error);
        if (code === 'EAGAIN' || code === 'EWOULDBLOCK') {
          await handle.close();
          return { contended: true };
        }
        if (typeof code === 'string' && UNAVAILABLE_CODES.has(code)) {
          await handle.close();
          return { unavailable: error instanceof Error ? error.message : String(error) };
        }
        throw error;
      }
      const held = await handle.stat({ bigint: true });
      const current = await stat(path, { bigint: true }).catch((error: unknown) => {
        if (codeOf(error) === 'ENOENT') return undefined;
        throw error;
      });
      if (current !== undefined && current.ino === held.ino && current.dev === held.dev) {
        return { held: handle };
      }
    } catch (error: unknown) {
      await handle.close();
      throw error;
    }
    // 鎖到的已經不是路徑上那個檔：對現在站在那裡的重來。
    await handle.close();
  }
  return { contended: true };
}
