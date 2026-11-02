/**
 * 工具子行程的接縫（[#1946](https://github.com/DemianLi/nexus-agent/issues/1946)）：工具只說要起什麼、在哪個模式、能讀寫哪些根，
 * 怎麼起由 {@link ToolLauncher} 決定。產品的選法在 `tool-launcher.ts`，經常駐 spawner 的實作在 `sandbox-spawner-client.ts`，
 * 直接 spawn 的實作在這裡。
 *
 * @module
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import type { Readable } from 'node:stream';

import { trackHostExitChild } from '@nexus/core';
import type { SandboxMode } from '@nexus/core';

/** 起一支工具要的東西。 */
export interface ToolRequest {
  readonly executable: string;
  /** 不含 argv0。 */
  readonly args: readonly string[];
  readonly cwd: string;
  readonly mode: SandboxMode;
  /** 讀根。`danger-full-access` 不看。 */
  readonly readable: readonly string[];
  /** 寫根。只有 `workspace-write` 看。 */
  readonly writable: readonly string[];
  /** 子行程的環境就是這一份，呼叫端要自己刷洗。 */
  readonly env: NodeJS.ProcessEnv;
  /** 寫進工具 stdin 的內容，寫完就關。省略時 stdin 是 `/dev/null`。 */
  readonly stdin?: string;
}

/**
 * 工具沒有跑起來的原因。起點讀不到、執行檔不在、沙箱不可用是三件事，文案不能混（#1945）。
 */
export type ToolLaunchFailure = 'sandbox-unavailable' | 'start-dir' | 'not-found' | 'launch-failed';

/** 一次執行的結局。`exited` 表示行程結束而且 stdout、stderr 都讀完了。 */
export type ToolResult =
  | { readonly kind: 'exited'; readonly code: number | null; readonly signal: string | null }
  | { readonly kind: 'failed'; readonly reason: ToolLaunchFailure };

/** 起起來的工具。 */
export interface ToolProcess {
  readonly pid: number | undefined;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** 對工具送訊號。工具已經結束時什麼都不做。 */
  kill(signal: 'SIGTERM' | 'SIGKILL'): void;
  /** 工具結束或沒起成就 settle，不等輸出。不會 reject。 */
  readonly exited: Promise<ToolResult>;
  /** 不會 reject。要有人讀完 stdout、stderr 才會 settle；後代抓著輸出時，呼叫端要自己在 {@link exited} 之後 `destroy`。 */
  readonly done: Promise<ToolResult>;
}

/** 不會 reject：起不來回 {@link ToolLaunchFailure}。 */
export type ToolLauncher = (request: ToolRequest) => Promise<ToolProcess | ToolLaunchFailure>;

/** 起點進得去嗎。spawn 分不出這件事跟執行檔不在（兩邊都可能是 `ENOENT`），所以先問。 */
function startDirUsable(cwd: string): boolean {
  try {
    accessSync(cwd, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 不經沙箱直接 spawn：只有非 Linux 的 `danger-full-access` 與測試設施走這裡。`process.exit` 時由 core 同步 SIGKILL（只殺直接子行程，
 * 不做 process group，#1542）。
 */
export const directToolLauncher: ToolLauncher = (request) => {
  if (!startDirUsable(request.cwd)) return Promise.resolve('start-dir');
  let child: ChildProcess;
  try {
    child = spawn(request.executable, [...request.args], {
      cwd: request.cwd,
      stdio: [request.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      env: request.env,
    });
  } catch {
    return Promise.resolve('launch-failed');
  }
  const untrack = trackHostExitChild(child);
  if (request.stdin !== undefined) {
    // 工具不讀完 stdin 就結束時寫入會 EPIPE；結果由結束碼決定。
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(request.stdin);
  }
  const failure = new Promise<ToolResult>((resolve) => {
    child.once('error', (error: NodeJS.ErrnoException) => {
      untrack();
      resolve({
        kind: 'failed',
        reason: error.code === 'ENOENT' ? 'not-found' : 'launch-failed',
      });
    });
  });
  const exited = Promise.race([
    failure,
    new Promise<ToolResult>((resolve) => {
      child.once('exit', (code, signal) => resolve({ kind: 'exited', code, signal }));
    }),
  ]);
  const done = Promise.race([
    failure,
    new Promise<ToolResult>((resolve) => {
      child.once('close', (code, signal) => {
        untrack();
        resolve({ kind: 'exited', code, signal });
      });
    }),
  ]);
  return Promise.resolve({
    pid: child.pid,
    stdout: child.stdout!,
    stderr: child.stderr!,
    kill(signal) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      // 起不來的 child 沒有 pid（'error' 事件還沒送到）：此時 `kill()` 會對 pid 0 送訊號，也就是整個行程群組（包括 serve 自己）。
      if (child.pid === undefined) return;
      child.kill(signal);
    },
    exited,
    done,
  });
};
