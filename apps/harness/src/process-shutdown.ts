/**
 * 長命行程的收尾控制器：有上限、會升級（[#599](https://github.com/DemianLi/nexus-agent/issues/599)）。
 *
 * **形狀照 dsh 的 `apps/cli/src/process-shutdown.ts`（`477b4f4`）逐條抄**：
 *
 * - 第一次訊號開始優雅收尾，收完強制結束——掛著的控制代碼不該讓行程賴著不走。
 * - **收尾進行中再來一次訊號就當場結束。** 那是使用者的「我不等了」，也是 dsh 的政策；
 *   代價是收尾沒做完的那一截會丟，所以耐久不能只靠收尾，要靠一輪之中的檢查點
 *   （`@nexus/core` 的 `durabilityCheckpointPlugin`）。
 * - 收尾有上限（{@link PROCESS_SHUTDOWN_TIMEOUT_MS}），到了就強制結束：一個卡住的
 *   `dispose` 不能讓 Ctrl-C 失效。
 * - 收尾本身失敗也強制結束，用同一個碼。
 *
 * 舊的做法是 `process.once('SIGINT', stop)`：第一次之後 listener 就沒了，第二次訊號落回
 * 預設動作（tsx 底下是它的 preflight 代為 `exit(130)`），而且收尾沒有上限。行為上「第二次
 * 就結束」跟這裡一樣，差在那是意外不是政策——沒有上限、沒有測試、退出碼也不對。
 *
 * @module
 */

/** 優雅收尾的上限，毫秒。到了就強制結束。 */
export const PROCESS_SHUTDOWN_TIMEOUT_MS = 5_000;

/** 正常結束與訊號共用的那一個收尾控制器。 */
export interface ProcessShutdown {
  /** 開始（或加入）優雅收尾，收完讓行程以 `code` 自然結束。 */
  shutdown(code: number): Promise<void>;
  /** 開始優雅收尾、收完強制結束；收尾已經在跑的話當場強制結束。 */
  interrupt(code: number): void;
}

/**
 * 包住一個整體收尾函式，建一個收尾控制器。
 *
 * @param dispose - 整個應用的收尾，靜止時 resolve。
 * @param forceExit - 當場結束行程。測試換掉它。
 * @param complete - 記下自然結束的退出碼。測試換掉它。
 * @param timeoutMs - 強制結束前的寬限。測試換掉它。
 * @returns 正常呼叫會合併、重複的訊號會升級的控制器。
 */
export function createProcessShutdown(
  dispose: () => Promise<void>,
  forceExit: (code: number) => void = (code) => {
    process.exit(code);
  },
  complete: (code: number) => void = (code) => {
    process.exitCode = code;
  },
  timeoutMs = PROCESS_SHUTDOWN_TIMEOUT_MS,
): ProcessShutdown {
  let pending: Promise<void> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let completed = false;
  let forceExited = false;

  const clearExitTimeout = (): void => {
    if (timeout !== undefined) clearTimeout(timeout);
  };

  const forceExitOnce = (code: number): void => {
    if (forceExited) return;
    forceExited = true;
    clearExitTimeout();
    forceExit(code);
  };

  const completeOnce = (code: number): void => {
    if (completed || forceExited) return;
    completed = true;
    clearExitTimeout();
    complete(code);
  };

  const start = (code: number, forceAfterDispose: boolean): Promise<void> => {
    if (pending !== undefined) return pending;
    timeout = setTimeout(() => {
      forceExitOnce(code);
    }, timeoutMs);
    pending = Promise.resolve()
      .then(dispose)
      .then(
        () => {
          if (forceAfterDispose) forceExitOnce(code);
          else completeOnce(code);
        },
        () => {
          forceExitOnce(code);
        },
      );
    return pending;
  };

  return {
    shutdown(code) {
      return start(code, false);
    },
    interrupt(code) {
      if (pending !== undefined) {
        forceExitOnce(code);
        return;
      }
      void start(code, true);
    },
  };
}
