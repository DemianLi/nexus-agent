/**
 * 自己起 ripgrep：`--no-config`、輸出上限、取消、錯誤分類（[#1532](https://github.com/DemianLi/nexus-agent/issues/1532)）。
 *
 * 基座 `FilesystemBackend.grep` 起 `rg` 的做法（`deepagents@1.13.1`，`dist/src-C9o7b5C6.js:935-984`）有四個洞：沒有
 * `--no-config`，所以管理者 shell 裡的 `~/.ripgreprc` 或專案 `.env` 帶進來的 `RIPGREP_CONFIG_PATH` 能悄悄濾掉結果、
 * 甚至用 `--pre` 讓 rg 對每個命中的檔執行任意程式；stdout 不設上限（`output += data`）；沒有取消，使用者按停止 rg
 * 照跑；結束碼不是 0／1、逾時、spawn 失敗一律回 `null`，接著改走結果不同的 `literalSearch`。
 *
 * 這裡照 dsh `packages/fs/tool-fs-search/src/search-core.ts:222-287` 的 `runRipgrep`（`687f282e`）：
 *
 * - argv 開頭是 `--no-config`（`:240`）。spawn 不受沙箱限制，宿主的 `RIPGREP_CONFIG_PATH` 可以注入 `--pre`。
 * - stdout 累計位元組，超過 {@link RAW_OUTPUT_MAX_BYTES} 就收掉 rg，回 `SEARCH_RAW_OUTPUT_OVERFLOW`，**不解析半份輸出**。
 *   stderr 只留最後 {@link STDERR_MAX_BYTES}，當診斷用。
 * - 取消：呼叫端的 signal 與 {@link SEARCH_TIMEOUT_MS} 的逾時合成一個，觸發時先 `SIGTERM`，{@link KILL_GRACE_MS} 後還在就
 *   `SIGKILL`（`:53`），回 `SEARCH_ABORTED`。
 * - 結束碼：0 有結果、1 零結果，其餘依 stderr 分 `SEARCH_INVALID_PATTERN`（regex／glob 解析錯誤）與 `SEARCH_FAILED`
 *   （`:124-130`）；被訊號殺也是 `SEARCH_FAILED`。**沒有退路**：這一層不改走別的搜尋法。
 * - 子行程環境是 `scrubbedParentEnv()`（`search-core.ts:8`、`subprocess-local/src/spawn.ts:45`）：名字像憑證的與
 *   harness 自己的變數不交給 rg。
 *
 * ## 與 dsh 的差異（不是偏離，是載體）
 *
 * dsh 經 `ctx.subprocess` 服務起子行程，終止升級由那個服務做；nexus 沒有這個服務（`child-env.ts` 檔頭同一個登記），
 * 所以升級（`SIGTERM` → `SIGKILL`）、逾時與輸出計數都在這個檔案裡自己做。規則照抄，載體退成一個函式。
 *
 * ## 不在這裡
 *
 * `ENOENT`（`rg` 找不到）不是這裡的錯誤，回 `unavailable` 讓呼叫端決定：偏離 1 的退路寫在
 * `ContainedFilesystemBackend.grep`。`cwd` 不存在時 Node 也回 `spawn rg ENOENT`，跟找不到 rg 分不出來，所以呼叫端
 * 要在 spawn 之前先確認 `cwd` 存在。
 *
 * @module
 */

import { spawn } from 'node:child_process';
import {
  SEARCH_ABORTED,
  SEARCH_FAILED,
  SEARCH_INVALID_PATTERN,
  SEARCH_RAW_OUTPUT_OVERFLOW,
  scrubbedParentEnv,
  trackHostExitChild,
} from '@nexus/core';
import type { SearchErrorCode } from '@nexus/core';

/** 完整 stdout 的上限（位元組）。dsh `RAW_OUTPUT_MAX_BYTES`（`search-core.ts:36`），同 Claude Code 的 ripgrep 緩衝。 */
export const RAW_OUTPUT_MAX_BYTES = 20_000_000;

/** 一次搜尋的逾時預算（毫秒）。dsh `SEARCH_TIMEOUT_MS`（`:43`）。 */
export const SEARCH_TIMEOUT_MS = 30_000;

/** 保留的 stderr 尾巴（位元組），診斷用。dsh `SEARCH_STDERR_MAX_BYTES`（`:50`）。 */
export const STDERR_MAX_BYTES = 64 * 1024;

/** 收掉 rg 時 `SIGTERM` 之後等多久升級到 `SIGKILL`（毫秒）。dsh `SEARCH_GRACE_MS`（`:53`）。 */
export const KILL_GRACE_MS = 3_000;

/** 這一次執行的結果。 */
export type RipgrepOutcome =
  | { readonly kind: 'ok'; readonly stdout: string; readonly noMatches: boolean }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'error'; readonly code: SearchErrorCode; readonly message: string };

/** {@link runRipgrep} 的參數。 */
export interface RipgrepRunOptions {
  /** `--no-config` 之後的 argv。 */
  readonly argv: readonly string[];
  /** 工作目錄；呼叫端要先確認它存在。 */
  readonly cwd: string;
  /** 呼叫端的取消訊號（這一次工具呼叫的）。 */
  readonly signal?: AbortSignal | undefined;
  /** 測試接縫：覆寫預設值。 */
  readonly internals?: RipgrepInternals | undefined;
}

/** 只給測試用的接縫：換執行檔名、數 spawn、壓低上限。 */
export interface RipgrepInternals {
  /** 執行檔名；省略即 `rg`（走 `PATH`）。 */
  readonly executable?: string;
  readonly rawOutputMaxBytes?: number;
  readonly timeoutMs?: number;
  readonly killGraceMs?: number;
  /** 每次真的要 spawn 之前呼叫一次（測試用來數「取消後不起 rg」）。 */
  readonly onSpawn?: (argv: readonly string[]) => void;
  /** 子行程起來之後給測試一個把手（斷言「行程已經結束」）。 */
  readonly onChild?: (child: { readonly pid: number | undefined }) => void;
}

const ABORT_MESSAGE = 'grep was aborted before completion (tool timeout or caller cancellation)';

function stderrExcerpt(text: string, truncated: boolean): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '';
  return truncated ? `${trimmed} [stderr truncated]` : trimmed;
}

/** 非 0／1 結束的 rg 歸類，照 dsh `classifyRunFailure`（`:124-130`）。 */
function classifyExit(
  exitCode: number,
  stderrText: string,
  truncated: boolean,
): Extract<RipgrepOutcome, { kind: 'error' }> {
  const stderr = stderrExcerpt(stderrText, truncated);
  if (/regex parse error|error parsing glob/i.test(stderr)) {
    return {
      kind: 'error',
      code: SEARCH_INVALID_PATTERN,
      message: `grep pattern rejected by ripgrep: ${stderr}`,
    };
  }
  return {
    kind: 'error',
    code: SEARCH_FAILED,
    message: `grep search failed (exit ${String(exitCode)})${stderr.length > 0 ? `: ${stderr}` : ''}`,
  };
}

/**
 * 起一次 `rg` 並等它結束。
 *
 * 判斷順序（`close` 時）：**取消 → 輸出超限 → 被訊號殺 → 結束碼**。輸出超限與取消都是我們自己 kill 的，`close` 會帶
 * `SIGTERM`／`SIGKILL`，順序反過來就會被當成「被訊號殺」。
 *
 * @param options - 見 {@link RipgrepRunOptions}。
 * @returns 結果；不丟例外。
 */
export function runRipgrep(options: RipgrepRunOptions): Promise<RipgrepOutcome> {
  const internals = options.internals ?? {};
  const maxBytes = internals.rawOutputMaxBytes ?? RAW_OUTPUT_MAX_BYTES;
  const graceMs = internals.killGraceMs ?? KILL_GRACE_MS;
  const executable = internals.executable ?? 'rg';
  const signals: AbortSignal[] = [AbortSignal.timeout(internals.timeoutMs ?? SEARCH_TIMEOUT_MS)];
  if (options.signal !== undefined) signals.push(options.signal);
  const signal = AbortSignal.any(signals);

  const aborted = (): RipgrepOutcome => ({
    kind: 'error',
    code: SEARCH_ABORTED,
    message: ABORT_MESSAGE,
  });
  if (signal.aborted) return Promise.resolve(aborted());

  return new Promise<RipgrepOutcome>((resolve) => {
    const argv = ['--no-config', ...options.argv];
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let wasAborted = false;
    let overflowed = false;
    let stdoutBytes = 0;
    const stdoutChunks: Buffer[] = [];
    let stderrTail = Buffer.alloc(0);
    let stderrTruncated = false;

    /** 行程被強制結束時由 core 同步 SIGKILL 的登記（#1542）；自己結束了就拿掉。 */
    const untrackers: Array<() => void> = [];
    const settle = (outcome: RipgrepOutcome): void => {
      if (settled) return;
      settled = true;
      for (const untrack of untrackers.splice(0)) untrack();
      if (killTimer !== undefined) clearTimeout(killTimer);
      signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };

    let child: ReturnType<typeof spawn>;
    try {
      internals.onSpawn?.(argv);
      child = spawn(executable, argv, {
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: scrubbedParentEnv(),
      });
    } catch (error: unknown) {
      resolve(
        signal.aborted
          ? aborted()
          : {
              kind: 'error',
              code: SEARCH_FAILED,
              message: `grep could not start its search command (ripgrep launch failed: ${(error as Error).message})`,
            },
      );
      return;
    }
    // spawn 之後立刻登記：serve 走 `process.exit` 結束而 rg 還在跑時，今天沒有人收它。只殺直接子行程，不做 process group
    // ——#1542 登記的偏離（理由 1，沒有 subprocess 服務）同樣適用，寫法照 `nexus-plugin-workspace-changes/src/git.ts`。
    untrackers.push(trackHostExitChild(child));
    internals.onChild?.({ pid: child.pid });

    /** 收掉 rg：先 `SIGTERM`，寬限之後還沒結束就 `SIGKILL`。 */
    const terminate = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, graceMs);
    };

    function onAbort(): void {
      wasAborted = true;
      terminate();
    }
    signal.addEventListener('abort', onAbort, { once: true });
    // 在 spawn 同步結束到掛上監聽之間已經取消的話，事件不會再來。
    if (signal.aborted) onAbort();

    child.stdout?.on('data', (chunk: Buffer) => {
      if (overflowed) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBytes) {
        overflowed = true;
        stdoutChunks.length = 0;
        terminate();
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = Buffer.concat([stderrTail, chunk]);
      if (stderrTail.length > STDERR_MAX_BYTES) {
        stderrTail = stderrTail.subarray(stderrTail.length - STDERR_MAX_BYTES);
        stderrTruncated = true;
      }
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        settle({ kind: 'unavailable' });
        return;
      }
      settle({
        kind: 'error',
        code: SEARCH_FAILED,
        message: `grep could not start its search command (ripgrep launch failed: ${error.message})`,
      });
    });

    child.on('close', (exitCode, killedBy) => {
      if (wasAborted || signal.aborted) {
        settle(aborted());
        return;
      }
      if (overflowed) {
        settle({
          kind: 'error',
          code: SEARCH_RAW_OUTPUT_OVERFLOW,
          message: `grep produced more than ${String(maxBytes)} bytes of raw output; narrow pattern, path, or glob and retry`,
        });
        return;
      }
      if (killedBy !== null || exitCode === null) {
        settle({
          kind: 'error',
          code: SEARCH_FAILED,
          message: `grep search command was killed by signal ${killedBy ?? '(unknown)'}`,
        });
        return;
      }
      if (exitCode !== 0 && exitCode !== 1) {
        settle(classifyExit(exitCode, stderrTail.toString('utf8'), stderrTruncated));
        return;
      }
      settle({
        kind: 'ok',
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        noMatches: exitCode === 1,
      });
    });
  });
}
