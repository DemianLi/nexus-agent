/**
 * 對一個鎖檔拿非阻塞的 kernel 排他鎖——會話寫租約（`session-lease.ts`）與 home 鎖（`home-lock.ts`）共用的那一段
 * （[#1503](https://github.com/DemianLi/nexus-agent/issues/1503)）。
 *
 * 開檔、對 fd 拿非阻塞 `flock(2)`、**鎖到之後驗一次路徑上那個檔還是鎖到的那個**（flock 鎖的是 inode 不是路徑，檔在中間被刪了又建就重來，
 * 最多三次）。握到把手關掉為止；行程死了 kernel 放鎖。**刻意沒有逾期**，卡住但活著的持有者不會被搶。釋放不刪鎖檔。
 *
 * 這裡只管「拿到沒有」，不管拿不到的時候丟什麼錯、怎麼講：那是呼叫端的語言（`SessionAlreadyOwnedError`、
 * `HomeInUseError`）。從 `session-lease.ts` 原樣抽出，行為不變——開檔方式（`'w'`、`0600`）、失敗的四種分類、
 * 退到不鎖的條件都沒動。
 *
 * ## 失敗分四種，只有兩種退
 *
 * 搶不到（`EAGAIN`／`EWOULDBLOCK`，或三次都撞上被換掉的 inode）是 `contended`；不是 Linux、或找不到
 * spawner 是 `unavailable`；**其餘一律往外拋**（`EACCES`、`EIO`……）。一個什麼錯都吞成
 * 「退到不鎖」的分類，會讓一次權限問題悄悄關掉整道鎖——護欄還在，但沒在擋。
 *
 * ## 拿鎖的那一下在 spawner 裡
 *
 * Node 沒有 flock。fd 傳給 `nexus-sandbox-spawner --flock`，它拿了鎖就結束：鎖屬於 open file description，
 * 由兩邊共用，所以留在這裡的把手上，釋放與行程死掉時的行為跟在本行程呼叫 `flock(2)` 一樣。
 * spawner 只在 Linux 出貨（#2253），其他平台是 `unavailable`。
 *
 * **`contended` 只來自 spawner 的結束碼。** `spawn` 本身在行程數到頂時也丟 `EAGAIN`，那不是別人握著鎖，
 * 所以起不了 spawner 的錯一律包成 `ERR_FLOCK_SPAWN` 往外拋。
 *
 * @module
 */

import { spawn } from 'node:child_process';
import { open, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { constants } from 'node:os';

import { findSpawnerBinary } from './tool-launcher.js';

/** 對一個已開的 fd 拿非阻塞的排他鎖。預設是 {@link spawnerFlock}；測試換得掉。 */
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
  // 不是 Linux，或這棵樹裡沒有 spawner。
  'ERR_FLOCK_UNSUPPORTED_PLATFORM',
]);

/** `--flock` 的結束碼，同 `native/sandbox-spawner/src/main.rs`。 */
const FLOCK_CONTENDED = 10;
const FLOCK_FAILED = 11;

function codeOf(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

function lockError(message: string, code: string, cause?: unknown): Error {
  return Object.assign(new Error(message, { cause }), { code });
}

/** errno 的數字換回 `EACCES` 這種名字；不認得的留數字。 */
function errnoName(value: number): string {
  const found = Object.entries(constants.errno).find(([, number]) => number === value);
  return found?.[0] ?? `errno ${String(value)}`;
}

/**
 * 經 spawner 拿鎖。
 *
 * @param binary - spawner 的路徑；`undefined` 是這裡拿不到鎖。
 * @param start - 起行程的那一下；測試換得掉。
 */
export function spawnerFlock(binary: string | undefined, start: typeof spawn = spawn): TryLock {
  return (fd) =>
    new Promise<void>((resolve, reject) => {
      if (binary === undefined) {
        reject(lockError('找不到 spawner', 'ERR_FLOCK_UNSUPPORTED_PLATFORM'));
        return;
      }
      const child = start(binary, ['--flock'], { stdio: ['ignore', 'pipe', 'ignore', fd] });
      let stdout = '';
      child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.once('error', (error: Error) => {
        reject(
          codeOf(error) === 'ENOENT'
            ? lockError(`spawner 不存在：${binary}`, 'ERR_FLOCK_UNSUPPORTED_PLATFORM', error)
            : lockError(`起不了 spawner：${error.message}`, 'ERR_FLOCK_SPAWN', error),
        );
      });
      child.once('close', (status, signal) => {
        if (status === 0) resolve();
        else if (status === FLOCK_CONTENDED) reject(lockError('鎖被別人握著', 'EWOULDBLOCK'));
        else if (status === FLOCK_FAILED) {
          const name = errnoName(Number(stdout.trim()));
          reject(lockError(`flock 失敗：${name}`, name));
        } else {
          reject(
            lockError(
              `spawner 拿鎖時異常結束：${signal ?? String(status)}`,
              'ERR_FLOCK_HELPER_FAILED',
            ),
          );
        }
      });
    });
}

/** 產品的那一支：不是 Linux 就沒有 spawner。 */
function productLock(): TryLock {
  return spawnerFlock(process.platform === 'linux' ? findSpawnerBinary() : undefined);
}

/**
 * 開 `path` 並對它拿排他鎖。**不建目錄**：建目錄是呼叫端的事。
 *
 * @param path - 鎖檔路徑。
 * @param lock - 拿鎖的那一下；預設是 {@link spawnerFlock}。
 * @returns 握著的把手、別人握著、或這個平台拿不到。
 * @throws 其餘任何開檔、stat、或 flock 的錯誤，原樣。
 */
export async function lockFileExclusive(
  path: string,
  lock: TryLock = productLock(),
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
