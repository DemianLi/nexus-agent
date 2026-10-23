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
 *   **唯一的例外是偏離 1（#1704）**：結束碼 2、而 stderr 每一行都是「讀不到」時，照樣交出 stdout。
 * - 子行程環境是 `scrubbedParentEnv()`（`search-core.ts:8`、`subprocess-local/src/spawn.ts:45`）：名字像憑證的與
 *   harness 自己的變數不交給 rg。
 *
 * ## 偏離 dsh（[#1704](https://github.com/DemianLi/nexus-agent/issues/1704)，理由 2：多人共用主機）
 *
 * 1. **有些檔讀不到不讓整次搜尋失敗。** dsh `runRipgrep` 把 0、1 以外的結束碼一律拋成 `SEARCH_FAILED`
 *    （`search-core.ts:282-284`），dsh 的測試也只有 regex／glob 解析錯誤、路徑不存在與空 stderr 三種 2
 *    （`tests/tools.spec.ts:566-598`），沒有「部分檔讀不到」的情境——它是單人的 Host，工作區都是自己的檔。
 *    多人共用一台主機時，工作區裡只要有一個 0600、屬於別人的檔，或一個 0700 的目錄，rg 就回 2，stdout 其實已經有
 *    其餘檔的命中，整次 grep 失敗等於把已找到的一起丟掉。
 *
 *    判準寫死、從嚴：**結束碼是 2、stderr 完整（沒被截尾）、而且每一個非空行都是 `rg: <路徑>: Permission denied (os error 13)`**。
 *    少一條就照舊判錯：regex／glob 解析錯誤、路徑不存在（`IO error for operation on`）、symlink 迴圈、stderr 被截尾（看不到
 *    被截掉的那段，不能保證裡面沒有別種錯誤）。字樣在 macOS（rg 15.1.0 與內附 15.0.0）與 Linux（內附 15.0.0）實測過，
 *    見 PR 內文。退到的做法：照樣交出 stdout，並在結果上帶 {@link RipgrepOutcome.unreadable}（讀不到幾條路徑），
 *    由呼叫端告訴模型「結果只涵蓋讀得到的」。
 *
 * ## 與 dsh 的差異（不是偏離，是載體）
 *
 * dsh 經 `ctx.subprocess` 服務起子行程，終止升級由那個服務做；nexus 沒有這個服務（`child-env.ts` 檔頭同一個登記），
 * 所以升級（`SIGTERM` → `SIGKILL`）、逾時與輸出計數都在這個檔案裡自己做。規則照抄，載體退成一個函式。
 *
 * ## 執行檔
 *
 * **呼叫端給執行檔的絕對路徑**（`rg-path.ts` 解出的內附 rg），這裡不查 `PATH`、也沒有預設值。`ENOENT` 就是
 * `SEARCH_FAILED`：產物裡的 rg 不見了，沒有退路（#1502 刀 4 拿掉了 #1532 偏離 1 的 `ENOENT` 退路）。
 * `cwd` 不存在時 Node 也回 `spawn … ENOENT`，兩者分不出來，所以呼叫端要在 spawn 之前先確認 `cwd` 存在。
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

/**
 * 起不來的錯誤訊息是**固定字串**：它會原樣變成工具結果交給模型，而 Node 的 spawn 錯誤訊息與內附 rg 的位置都帶主機的絕對路徑
 * （`spawn /opt/…/rg ENOENT`）。照 dsh `packages/fs/tool-fs-search/src/search-core.ts:260`：訊息固定、原始錯誤不接在後面。
 * 要查是哪個路徑，看 serve 啟動日誌那一行「搜尋（grep）：內附 ripgrep …」（給管理者的，`rg-path.ts`）。
 */
const launchFailedMessage = (tool: RipgrepTool): string =>
  `${tool} could not start its search command (ripgrep launch failed)`;
const notFoundMessage = (tool: RipgrepTool): string =>
  `${tool} could not start its search command (bundled ripgrep not found)`;

/** 收掉 rg 時 `SIGTERM` 之後等多久升級到 `SIGKILL`（毫秒）。dsh `SEARCH_GRACE_MS`（`:53`）。 */
export const KILL_GRACE_MS = 3_000;

/** 錯誤訊息裡說的是哪一顆工具：`grep` 與 `glob` 共用同一支 runner（[#1605](https://github.com/DemianLi/nexus-agent/issues/1605)）。 */
export type RipgrepTool = 'grep' | 'glob';

/** 這一次執行的結果。 */
export type RipgrepOutcome =
  | {
      readonly kind: 'ok';
      readonly stdout: string;
      /** rg 結束碼是 1。結束碼 2 的部分失敗（{@link unreadable} 大於 0）不是零結果，這裡永遠是 `false`，由呼叫端解析 stdout。 */
      readonly noMatches: boolean;
      /** 讀不到的路徑數（偏離 1，#1704）；沒有就是 0。 */
      readonly unreadable: number;
    }
  | { readonly kind: 'error'; readonly code: SearchErrorCode; readonly message: string };

/** {@link runRipgrep} 的參數。 */
export interface RipgrepRunOptions {
  /** rg 執行檔的絕對路徑（內附的那一支）。不查 `PATH`。 */
  readonly executable: string;
  /** `--no-config` 之後的 argv。 */
  readonly argv: readonly string[];
  /** 工作目錄；呼叫端要先確認它存在。 */
  readonly cwd: string;
  /**
   * 結束碼 2、stderr 全是「讀不到」時照樣交出 stdout（偏離 1，#1704）。**預設 `false`，也就是 dsh 的做法**：
   * 只有呼叫端確定「讀不到的路徑不是秘密、少搜幾個檔可以接受」才開（工作區的 `grep`／`glob`）；附件路由不開
   * （#1822：同一個目錄裡沒引用的別名檔屬於別的 thread，連「有幾個」都不交給模型）。
   */
  readonly tolerateUnreadable?: boolean | undefined;
  /** 錯誤訊息裡的工具名；預設 `grep`。 */
  readonly tool?: RipgrepTool | undefined;
  /** 呼叫端的取消訊號（這一次工具呼叫的）。 */
  readonly signal?: AbortSignal | undefined;
  /** 測試接縫：覆寫預設值。 */
  readonly internals?: RipgrepInternals | undefined;
}

/** 只給測試用的接縫：換執行檔、數 spawn、壓低上限。 */
export interface RipgrepInternals {
  /** 換掉內附 rg 的路徑（`ContainedFilesystemBackend.grep` 讀它）；runner 本身只認 {@link RipgrepRunOptions.executable}。 */
  readonly executable?: string;
  readonly rawOutputMaxBytes?: number;
  readonly timeoutMs?: number;
  readonly killGraceMs?: number;
  /** 每次真的要 spawn 之前呼叫一次（測試用來數「取消後不起 rg」）。 */
  readonly onSpawn?: (argv: readonly string[], executable: string) => void;
  /** 子行程起來之後給測試一個把手（斷言「行程已經結束」）。 */
  readonly onChild?: (child: { readonly pid: number | undefined }) => void;
}

const abortMessage = (tool: RipgrepTool): string =>
  `${tool} was aborted before completion (tool timeout or caller cancellation)`;

function stderrExcerpt(text: string, truncated: boolean): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '';
  return truncated ? `${trimmed} [stderr truncated]` : trimmed;
}

/**
 * rg 為了「讀不到」寫的 stderr 行：`rg: <路徑>: Permission denied (os error 13)`。
 * 實測（#1704）：macOS rg 15.1.0、內附 rg 15.0.0（darwin-arm64、linux-arm64）字樣一致；檔與目錄都是這一句。
 * `(os error 13)` 是 `EACCES` 的數字，不依賴 locale（Rust 不呼叫 `setlocale`，訊息固定是 C locale 的英文）。
 */
const UNREADABLE_LINE = /^rg: .+: Permission denied \(os error 13\)$/u;

/**
 * stderr 是不是**只有**「讀不到」。
 *
 * @param text - 保留下來的 stderr。
 * @param truncated - stderr 是否被截尾；截過的看不到前段，不能保證裡面沒有別種錯誤，一律當不是。
 * @returns 讀不到的路徑數；有任何一行不是「讀不到」、沒有任何一行、或被截尾時是 `undefined`。
 */
function unreadableCount(text: string, truncated: boolean): number | undefined {
  if (truncated) return undefined;
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) return undefined;
  return lines.every((line) => UNREADABLE_LINE.test(line)) ? lines.length : undefined;
}

/** 非 0／1 結束的 rg 歸類，照 dsh `classifyRunFailure`（`:124-130`）。 */
function classifyExit(
  tool: RipgrepTool,
  exitCode: number,
  stderrText: string,
  truncated: boolean,
): Extract<RipgrepOutcome, { kind: 'error' }> {
  const stderr = stderrExcerpt(stderrText, truncated);
  if (/regex parse error|error parsing glob/i.test(stderr)) {
    return {
      kind: 'error',
      code: SEARCH_INVALID_PATTERN,
      message: `${tool} pattern rejected by ripgrep: ${stderr}`,
    };
  }
  return {
    kind: 'error',
    code: SEARCH_FAILED,
    message: `${tool} search failed (exit ${String(exitCode)})${stderr.length > 0 ? `: ${stderr}` : ''}`,
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
  const executable = options.executable;
  const tool = options.tool ?? 'grep';
  const signals: AbortSignal[] = [AbortSignal.timeout(internals.timeoutMs ?? SEARCH_TIMEOUT_MS)];
  if (options.signal !== undefined) signals.push(options.signal);
  const signal = AbortSignal.any(signals);

  const aborted = (): RipgrepOutcome => ({
    kind: 'error',
    code: SEARCH_ABORTED,
    message: abortMessage(tool),
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
      internals.onSpawn?.(argv, executable);
      child = spawn(executable, argv, {
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: scrubbedParentEnv(),
      });
    } catch {
      resolve(
        signal.aborted
          ? aborted()
          : {
              kind: 'error',
              code: SEARCH_FAILED,
              message: launchFailedMessage(tool),
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
      // 起不來的 child 沒有 pid（'error' 事件還沒送到）：此時 `kill()` 會對 pid 0 送訊號，也就是整個行程群組（包括 serve 自己）。
      if (child.pid === undefined) return;
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
      // 起不來的同時已經被取消：回「取消」不回「起不來」（照 dsh `search-core.ts:257-259`，spawn 失敗後再看一次 `signal.aborted`）。
      if (wasAborted || signal.aborted) {
        settle(aborted());
        return;
      }
      settle({
        kind: 'error',
        code: SEARCH_FAILED,
        message: error.code === 'ENOENT' ? notFoundMessage(tool) : launchFailedMessage(tool),
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
          message: `${tool} produced more than ${String(maxBytes)} bytes of raw output; narrow pattern, path, or glob and retry`,
        });
        return;
      }
      if (killedBy !== null || exitCode === null) {
        settle({
          kind: 'error',
          code: SEARCH_FAILED,
          message: `${tool} search command was killed by signal ${killedBy ?? '(unknown)'}`,
        });
        return;
      }
      let unreadable = 0;
      if (exitCode !== 0 && exitCode !== 1) {
        const stderrText = stderrTail.toString('utf8');
        // 偏離 1（#1704）：只有結束碼 2、而 stderr 全是「讀不到」才放行；其餘的非 0／1 照 dsh 判錯。
        const skipped =
          exitCode === 2 && options.tolerateUnreadable === true
            ? unreadableCount(stderrText, stderrTruncated)
            : undefined;
        if (skipped === undefined) {
          settle(classifyExit(tool, exitCode, stderrText, stderrTruncated));
          return;
        }
        unreadable = skipped;
      }
      settle({
        kind: 'ok',
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        noMatches: exitCode === 1,
        unreadable,
      });
    });
  });
}
