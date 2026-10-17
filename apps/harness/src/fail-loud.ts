/**
 * 行程層的致命例外處理：未處理的 rejection 與未捕捉的例外，先印一行帶標籤的診斷，再有界收尾，最後以 1 結束
 * （[#1501](https://github.com/DemianLi/nexus-agent/issues/1501)）。
 *
 * **逐條照 dsh 的 `installFailLoud`**（`packages/boot/app-boot/src/index.ts:792-933`，SHA `1517a4db`）：
 *
 * - 同時接 `unhandledRejection` 與 `uncaughtException`，標籤分別是 `fatal load failure` 與
 *   `fatal uncaught exception`。**標籤不翻中文**：那是給 grep 與監管程式認的記號，dsh 的 e2e 也靠它比對。
 * - 診斷一行：`<前綴>: <標籤>: ` 加上 `util.inspect(err, { depth: 4, maxArrayLength: 50 })`，寫到 stderr。
 *   用 `inspect` 不用 `err.stack`：`code`／`syscall`／`path`／`cause` 是可列舉屬性，堆疊那行不帶。
 *   裝了 handler 之後 Node 自己什麼都不印，這一行是唯一的紀錄。
 * - **控制權不回到失敗的那一步。** 只有拋錯的地方知道哪些狀態完整；從半套寫入接著跑，會留下靜靜錯掉的結果。
 *   事件迴圈只活到 `release` 結束或逾時。
 * - 先寫診斷、再 `release`，卡住或失敗的 `release` 吞不掉死因。
 * - `release` 有界：{@link FAIL_LOUD_RELEASE_TIMEOUT_MS}，`Promise.race` 加一顆**有 ref 的** timer，永不 settle 的
 *   `release` 不能讓 Node 走到空迴圈、變成 exit 0。`release` 自己失敗被吞，最後一律 `exit(1)`。
 * - latch：第一顆失敗是被回報的那顆；`release` 期間 handler 保持安裝，之後來的（含 `release` 自己的）一律吞掉，
 *   不讓 Node 在收尾中途殺掉行程。
 *
 * **dsh 的 Loader 衍生 rejection 去重沒有抄**（`index.ts:811-836`，為了 Loader rc.5 在 fiber 失敗後衍生又丟掉的
 * 那顆 promise）。#1501 驗收 5 量過：vendor rc.11 底下，試組掉一列沒有衍生的未處理 rejection，
 * 結果見該 PR。
 *
 * @module
 */

import { inspect } from 'node:util';

/** {@link installFailLoud} 變成致命退出的兩個行程事件。 */
export type FailLoudEvent = 'unhandledRejection' | 'uncaughtException';

/**
 * {@link installFailLoud} 需要的那一小片 `process`——可注入，測試不必註冊到（或結束）真的行程。
 */
export interface FailLoudProcess {
  on(event: FailLoudEvent, handler: (err: unknown) => void): unknown;
  off(event: FailLoudEvent, handler: (err: unknown) => void): unknown;
  stderr: { write(chunk: string): unknown };
  /**
   * 結束行程。呼叫端把它當成這一趟的終點，同 `process.exit`；測試用的假實作回得來，只有測試看得到那種情形。
   */
  exit(code: number): void;
}

/** `release` 的等待上限，毫秒。一個卡住的收尾只能延後致命退出，不能取消它。 */
export const FAIL_LOUD_RELEASE_TIMEOUT_MS = 2_000;

/**
 * 在啟動之前裝，把行程生命週期內任何時刻的未處理 rejection 或未捕捉例外，變成一行帶標籤的 stderr 診斷
 * 加 `exit(1)`。標準輸出不碰。
 *
 * @param binName - 致命失敗那一行的前綴。
 * @param proc - 要註冊的行程；測試注入假的。
 * @param release - 退出之前等待的收尾，最多 {@link FAIL_LOUD_RELEASE_TIMEOUT_MS}。它自己的失敗被吞：
 *   等著的致命退出已經擁有結果。
 * @returns 解除兩個 handler 的函式。
 */
export function installFailLoud(
  binName: string,
  proc: FailLoudProcess = process,
  release?: () => Promise<void> | void,
): () => void {
  let exiting = false;
  const report = (err: unknown, label: string): void => {
    // 收尾進行中已經擁有這次退出。之後的失敗（含收尾自己的）吞掉，不在真正的失敗上面再報一次，
    // 也不讓 Node 在收尾中途殺掉行程。
    if (exiting) return;
    exiting = true;
    proc.stderr.write(`${binName}: ${label}: ${inspect(err, { depth: 4, maxArrayLength: 50 })}\n`);
    if (release === undefined) {
      proc.exit(1);
      return;
    }
    void (async () => {
      // 一定已經賦值：timeout promise 的 executor 在 race 建構時同步執行，早於第一個 await。
      let timer!: ReturnType<typeof setTimeout>;
      try {
        await Promise.race([
          (async () => release())(),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, FAIL_LOUD_RELEASE_TIMEOUT_MS);
          }),
        ]);
      } catch (releaseError: unknown) {
        // 收尾失敗了；後面的致命退出才是要緊的結果，而且之後沒有任何回報者會再跑。
        void releaseError;
      }
      clearTimeout(timer);
      proc.exit(1);
    })();
  };
  const onRejection = (err: unknown): void => {
    report(err, 'fatal load failure');
  };
  const onException = (err: unknown): void => {
    report(err, 'fatal uncaught exception');
  };
  proc.on('unhandledRejection', onRejection);
  proc.on('uncaughtException', onException);
  return () => {
    proc.off('unhandledRejection', onRejection);
    proc.off('uncaughtException', onException);
  };
}
