/**
 * home 底下狀態檔的原子寫入（[#1527](https://github.com/DemianLi/nexus-agent/issues/1527)）：整份取代、第一次建立，
 * 與兩者共用的目錄 fsync。釘選與封存、插件快照、變更紀錄的初建檔、瀏覽器簽章密鑰與設定雜湊鍵都走這裡。
 *
 * - {@link writeAtomic}：逐行照 dsh `packages/storage/storage-json/src/atomic.ts:24-40`。語意是**取代**，前提是單一寫者、
 *   最後勝出（`:4-10`）；單一寫者由 home 鎖保證（`home-lock.ts`，#1503）。
 * - {@link publishNewFile}：照 dsh 會話物化的三步（`packages/session/session-persistence-jsonl/src/index.ts:1296-1321`、
 *   `:1359-1369`）。用 `link` 不用 `rename`：目標已在就 `EEXIST`，先建的贏。
 * - {@link syncDirectory}：照 dsh `atomic.ts:44-52`。**錯往外拋，不吞**；dsh 三份目錄 fsync 都是這樣。
 *
 * 不在這裡的：會話日誌自己的那一份（`jsonl-session-store.ts`，#1510）、附件（#1528）、工作區的寫檔（#1531，照的是 dsh
 * `fs-local` 那支不 fsync 目錄的 `writeFileAtomic`，原語不同）。
 *
 * @module
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { link, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * 把 `path` 整份換成 `data`，回來時已經斷電也不會退回上一版。
 *
 * 同目錄的 `.<uuid>.tmp`，`wx`（不跟隨預先放好的連結）、`0600` → 寫 → `sync` → 關 → `rename` → fsync 目錄。
 * 任何一步失敗都刪暫存檔再拋。**目錄 fsync 失敗時 `rename` 已經做了**：檔上是新的，但呼叫端收到的是失敗。
 *
 * @param path - 目標檔的絕對路徑。目錄要先建好。
 * @param data - 新的完整內容。
 */
export async function writeAtomic(path: string, data: string): Promise<void> {
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    const handle = await open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(data, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/**
 * 第一次建立 `path`，不蓋掉已有的：暫存檔 `wx`、`0600`、寫滿、`sync` → `link` 到正式路徑 → fsync 目錄 → 盡力刪暫存檔。
 *
 * - `link` 失敗就刪暫存檔再原樣拋；目標已在是 `EEXIST`，交給呼叫端判斷（通常是「別人先建好了，讀它的」）。
 *   寫暫存檔那一段（`writeSyncedTempFile`）失敗時同 dsh 不刪：名字是隨機的 `.tmp`，讀方不認，當機殘留也一樣不清。
 * - 刪暫存檔排在目錄 fsync 之後、失敗不拋：正式檔已經發佈而且落盤了，多一個硬連結不該讓呼叫端以為沒建成。
 *
 * @param path - 目標檔的絕對路徑。目錄要先建好。
 * @param data - 完整內容。
 * @throws `EEXIST`：目標已在，沒有動它。
 */
export async function publishNewFile(path: string, data: string): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  await syncDirectory(dirname(path));
  try {
    await rm(tmp, { force: true });
  } catch {
    // 正式檔已發佈、已落盤；剩下的只是同一份內容的另一個名字。
  }
}

/**
 * fsync 一個目錄，讓裡面剛 `rename`／`link` 進來的名字斷電後還在。Windows 開不了目錄，直接回。
 *
 * @param directory - 目錄的絕對路徑。
 */
export async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
