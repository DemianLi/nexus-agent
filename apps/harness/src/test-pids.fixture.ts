/**
 * 測試裡「讀出一個 pid、再對它送訊號」的唯一入口（[#1712](https://github.com/DemianLi/nexus-agent/issues/1712)）。
 *
 * **為什麼要有**：`process.kill(0, 'SIGKILL')` 殺的是**整個行程群組**，包括 vitest 主行程、全部 worker、和外層的 shell。
 * 而 `Number('')` 是 `0`——pid 檔剛被建出來、還沒寫進內容（`writeFileSync` 與 shell 的 `echo $$ > 檔` 都是先 `open` 截斷、
 * 再寫）時讀它，或假子行程在兩步之間被收掉、檔案永遠是空的，`Number(讀到的字串)` 就是 0，接著 `afterEach` 的清理對 pid 0 送 `SIGKILL`：
 * 整套測試無聲消失，連 `; echo EXIT=$?` 都跑不到（本機兩次、同一棵樹重跑就全綠，正是 #1712 的症狀）。
 *
 * 所以：pid 只能從 {@link readPidFile}（等到內容是完整的正整數才回）取得，訊號只能用 {@link signalPid}（pid 不是大於 1 的整數就**丟錯**，
 * 不送）。`no-group-signal.test.ts` 掃整棵測試原始碼，不經過這裡的 `process.kill(…, 非 0 訊號)` 一律紅。
 *
 * @module
 */

import { readFile } from 'node:fs/promises';

/** 把一段文字解成 pid；不是完整的大於 1 的整數就丟錯（0 是群組、1 是 init、負數是群組）。 */
export function parsePid(text: string, source: string): number {
  const trimmed = text.trim();
  if (!/^\d+$/u.test(trimmed)) {
    throw new RangeError(`${source} 的內容不是 pid：${JSON.stringify(text)}`);
  }
  const pid = Number(trimmed);
  assertSignalablePid(pid, source);
  return pid;
}

/** 對 pid 0、1、負數、非整數一律丟錯：`process.kill` 對它們的語意是「整個群組」或「所有行程」。 */
export function assertSignalablePid(pid: number, source = 'pid'): void {
  if (!Number.isInteger(pid) || pid <= 1) {
    throw new RangeError(
      `${source}：${String(pid)} 不是可以送訊號的 pid（0、1、負數會打到整個行程群組）`,
    );
  }
}

/**
 * 等 pid 檔出現**而且內容完整**才回。檔案存在不代表有內容：寫的人先建檔、後寫字。
 * @throws 逾時仍不是完整的 pid（含：寫的人在兩步之間死了，檔案永遠是空的）。
 */
export async function readPidFile(path: string, timeoutMs = 10_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  for (;;) {
    try {
      last = await readFile(path, 'utf8');
      if (/^\d+\s*$/u.test(last)) return parsePid(last, path);
    } catch {
      // 檔案還沒出現。
    }
    if (Date.now() >= deadline) {
      throw new Error(`等不到 ${path} 的完整 pid（最後讀到 ${JSON.stringify(last)}）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 這個 pid 還在嗎（訊號 0，不打擾它）。pid 不合法時丟錯，不回「還在」。 */
export function isAlive(pid: number): boolean {
  assertSignalablePid(pid);
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM：行程在，屬於別的使用者。
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 對單一行程送訊號。pid 不合法丟錯、**不送**；行程已經不在（`ESRCH`）回 `false`。
 * @returns 訊號送出去了。
 */
export function signalPid(pid: number, signal: NodeJS.Signals): boolean {
  assertSignalablePid(pid);
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
