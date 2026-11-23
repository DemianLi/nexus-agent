/**
 * 工具結果暫存的啟動清掃**放到背景**（#1553 N0952），照 dsh `spill-local` 的 `LocalSpillStore` 建構子
 * （`packages/spill/spill-local/src/index.ts:90-101`，`687f282e`）：啟動時放出一次清掃、**不等它**，服務照常開始；
 * 清掃歸一個 effect 所有，它交出的 disposer 等**同一顆** promise，所以卸載一定等清掃收斂，沒有清掃的 I/O 活得比擁有者久。
 *
 * 擁有者是 Cordis 根的 context：`serve` 與 `cli` 起得來、起不來、跑完，每一條收尾都會卸載根（`root.dispose()`），
 * 而且都排在還原代理與放 home 鎖之前——所以啟動在清掃之後才失敗，下一台 serve 也不會跟還在跑的清掃重疊。
 *
 * 跟續接中 thread 的寫入同時跑是安全的，靠刀 A（#1901）的兩件事：清掃只刪過期的單一檔（`cleanupToolResultStash`），
 * 寫入遇到會話目錄剛被 `rmdir` 會重建再寫（`HostStashBackend.write`）。
 *
 * 獨立成一個模組，是為了讓 `cleanupToolResultStash` 是一次跨模組的呼叫：測試換掉它，才量得到「不等」與「等」。
 */

import type { Context } from '@nexus/cordis';
import { cleanupToolResultStash } from './tool-result-stash.js';

/**
 * 在 `ctx` 上放出一次背景清掃。`cleanupPeriodDays` 為 `0` 時不清，disposer 什麼都不等（dsh 同）。
 *
 * `cleanupToolResultStash` 自己接住每一個檔案系統錯誤；萬一它還是拒絕，照 dsh 走 `warn` 講一聲，不讓 disposer 拋。
 *
 * @param ctx - 擁有這次清掃的 context（入口的 Cordis 根）。
 * @param rootDir - 暫存根。
 * @param cleanupPeriodDays - 保留天數。
 * @param warn - 收清掃的警告。
 */
export function launchToolResultStashSweep(
  ctx: Context,
  rootDir: string,
  cleanupPeriodDays: number,
  warn: (message: string) => void,
): void {
  ctx.effect(function* () {
    const sweep =
      cleanupPeriodDays > 0
        ? cleanupToolResultStash(rootDir, cleanupPeriodDays, { warn }).then(
            () => undefined,
            (error: unknown) => {
              warn(
                `[暫存] 背景清掃失敗：${error instanceof Error ? error.message : String(error)}`,
              );
            },
          )
        : undefined;
    yield async () => {
      await sweep;
    };
  }, 'tool-result-stash cleanup sweep');
}
