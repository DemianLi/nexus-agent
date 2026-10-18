/**
 * 工作區檔案的原子取代與逐目標鎖（[#1531](https://github.com/DemianLi/nexus-agent/issues/1531)）。
 *
 * 基座 `FilesystemBackend` 的 `write`／`edit` 都是就地覆寫：`open(O_WRONLY|O_TRUNC)` 在開檔那一刻就把原檔清成
 * 0 位元組，新內容是之後才寫的。寫到一半被 `kill -9`、斷電、磁碟寫滿，使用者打開的是被截成一半的檔；兩個平行的
 * `edit_file` 各自整份讀、各自寫回，後寫的蓋掉先寫的；工作區裡指向根外的硬連結會被寫穿（`O_TRUNC` 開的是同一個 inode）。
 *
 * 這裡的做法照 dsh `packages/fs/fs-local`（`687f282e`）的 POSIX 那一支：
 *
 * - {@link writeFileAtomic} = `src/fsio.ts:573-670` 的 `writeFileAtomic`：目標同一個目錄底下建私有暫存目錄
 *   （`.<basename>.<pid>.<uuid>.tmpdir`，`0700`），暫存檔 `wx`、`0600`，`writeFile`、`sync`，有既有 mode 就補回去，
 *   `rename` 發佈，清暫存目錄；失敗時清理並把**原錯誤**往外拋；發佈之後清不掉暫存目錄不算寫入失敗。
 *   **不 fsync 父目錄**——dsh 這一支沒做（它在會話日誌物化才 fsync 目錄），這裡同。
 * - {@link withTargetLock} = `src/index.ts:104-130` 的 `locks` 與 `withLock`：以目標為鍵的 FIFO 鎖，
 *   讀、判斷、寫在同一把鎖裡，平行的 `edit` 才不會丟修改。**dsh 的鎖掛在實例上，但一個 app 只有一個 provider，
 *   所以實際上是行程層級；這裡每條 thread 一個 backend 實例，多人共用的 serve 好幾條 thread 會指向同一個工作區，
 *   所以鎖放在模組層才跟它等價。**
 *
 * ## 偏離 dsh（AGENTS.md「技術實現標準」，#1531 卡上登記）
 *
 * 1. **理由 1（基座表達不出來）：`createIfAbsent` 的 hard link 發佈不做。** 那個意圖要從「先讀後改」的政策傳到寫入這一層，
 *    基座的 `write(filePath, content)` 沒有參數可以帶它（`packages/nexus-core/src/observation.ts` 的偏離一已登記同一個
 *    限制）。退到：一律用 `rename` 原子取代，`createIfAbsent` 仍由 observation 在呼叫前擋。
 * 2. **理由 2（產品只部署 POSIX）：不做 Windows 那一支（DACL、`ReplaceFile`）。**
 *
 * 新檔權限是暫存檔的 `0600`（照 dsh，#1531 Q1 (a)）；取代既有檔時補回原檔的 mode，所以 `0640` 仍是 `0640`。
 * 擁有者則是 serve 行程的使用者（`rename` 換了 inode），原檔若屬於別的使用者就不再保留。
 *
 * @module
 */

import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** 測試接縫：釘暫存名、在各個檢查點觀察或注入失敗（照 dsh 的 `FsIoInternals`）。 */
export interface AtomicWriteInternals {
  /** 暫存目錄名；省略即 `.<basename>.<pid>.<uuid>.tmpdir`。 */
  readonly tempDirName?: (absolutePath: string) => string;
  /** 暫存檔名；省略即 `<basename>.tmp`。 */
  readonly tempName?: (absolutePath: string) => string;
  /** 內容寫進暫存檔之後、`sync` 之前。丟錯就是「寫到一半失敗」。 */
  readonly afterWrite?: (info: { stagingDir: string; tempPath: string }) => void | Promise<void>;
  /** `sync` 之後、發佈之前。 */
  readonly inspectTemp?: (info: { stagingDir: string; tempPath: string }) => void | Promise<void>;
  /** 清暫存目錄；省略即遞迴強制刪除。 */
  readonly removeStagingDir?: (path: string) => Promise<void>;
  /** `edit` 讀完原檔、算好新內容、寫入之前（鎖之內）。測試用它停住第一個 `edit` 來排出平行的交錯。 */
  readonly afterEditRead?: (absolutePath: string) => void | Promise<void>;
}

/** 失敗時的收尾：暫存目錄清不掉，錯誤訊息要兩個原因都在。 */
async function removeStagingDirOrThrow(
  stagingDir: string,
  failure: unknown,
  remove: (path: string) => Promise<void>,
): Promise<never> {
  try {
    await remove(stagingDir);
  } catch (cleanupError: unknown) {
    throw new Error(
      `${messageOf(failure)}（暫存目錄 ${stagingDir} 也清不掉：${messageOf(cleanupError)}）`,
      { cause: failure },
    );
  }
  throw failure;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 經同目錄的私有暫存檔原子取代一個檔。
 *
 * @param absolutePath - 目的地；缺的父目錄會建。
 * @param content - 要寫的整份內容；字串以 UTF-8 寫，位元組原樣寫。
 * @param mode - 既有目的地的 POSIX mode（補回去）；新檔給 `undefined`，留暫存檔的 `0600`。
 * @param internals - 測試接縫。
 * @throws 原錯誤；暫存目錄也清不掉時訊息帶兩個原因。
 */
export async function writeFileAtomic(
  absolutePath: string,
  content: string | Uint8Array,
  mode: number | undefined,
  internals: AtomicWriteInternals = {},
): Promise<void> {
  const directory = dirname(absolutePath);
  await mkdir(directory, { recursive: true });

  const stagingDirName =
    internals.tempDirName?.(absolutePath) ??
    `.${basename(absolutePath)}.${process.pid}.${randomUUID()}.tmpdir`;
  const stagingDir = join(directory, stagingDirName);
  const tempPath = join(
    stagingDir,
    internals.tempName?.(absolutePath) ?? `${basename(absolutePath)}.tmp`,
  );
  const removeStagingDir =
    internals.removeStagingDir ?? ((path: string) => rm(path, { recursive: true, force: true }));
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let stagingCreated = false;
  try {
    await mkdir(stagingDir, { mode: 0o700 });
    stagingCreated = true;
    await chmod(stagingDir, 0o700);

    handle = await open(tempPath, 'wx', 0o600);
    await handle.chmod(0o600);
    if (typeof content === 'string') await handle.writeFile(content, { encoding: 'utf8' });
    else await handle.writeFile(content);
    await internals.afterWrite?.({ stagingDir, tempPath });
    await handle.sync();
    await internals.inspectTemp?.({ stagingDir, tempPath });
    if (mode !== undefined) await handle.chmod(mode);
    await handle.close();
    handle = undefined;

    await rename(tempPath, absolutePath);
    try {
      await removeStagingDir(stagingDir);
    } catch {
      // 目標已經發佈；留下的只有 0700 的空暫存目錄，不能把這次寫入變成失敗（同 dsh）。
    }
  } catch (error: unknown) {
    let failure = error;
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch (closeError: unknown) {
        failure = new Error(
          `write failed (${messageOf(failure)}) and temp close failed (${messageOf(closeError)})`,
          { cause: failure },
        );
      }
    }
    if (!stagingCreated) throw failure;
    return removeStagingDirOrThrow(stagingDir, failure, removeStagingDir);
  }
}

/**
 * 以目標路徑為鍵的 FIFO 鎖，**行程層級**（模組層一份）。
 *
 * 前一個操作成功或失敗，下一個都照樣接著跑；鎖尾巴吞掉前一個的結果與錯誤，只傳遞「它結束了」。
 */
const locks = new Map<string, Promise<unknown>>();

/**
 * 在 `key` 的鎖裡跑 `operation`。
 *
 * @param key - 目標的 canonical 絕對路徑：經不同別名走到同一個檔的呼叫要拿到同一把鎖。
 * @param operation - 讀、判斷、寫整段。
 */
export async function withTargetLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const prior = locks.get(key) ?? Promise.resolve();
  const run = prior.then(operation, operation);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  locks.set(key, tail);
  try {
    return await run;
  } finally {
    if (locks.get(key) === tail) locks.delete(key);
  }
}

/** 暫時留著給測試確認鎖表會清乾淨（沒有未完成的操作時是空的）。 */
export function lockCountForTest(): number {
  return locks.size;
}
