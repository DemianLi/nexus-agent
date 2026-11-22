/**
 * 沒有 pid 的子行程不送訊號（[#1742](https://github.com/DemianLi/nexus-agent/issues/1742)）。
 *
 * spawn 失敗的 `ChildProcess`，在 `'error'` 事件送到之前沒有 `pid`；這時 `child.kill(sig)` 送出去的是 `kill(0, sig)`，等於對**整個
 * 行程群組**送訊號，serve 自己也在群組裡。視窗只有同一個 tick：abort 或 `process.exit` 剛好落在這裡。照 dsh `signalTree` 的
 * `if (pid === undefined) return`（`packages/subprocess/subprocess-local/src/spawn.ts:139-140`，`687f282e`）。
 *
 * 兩種證據：
 * - **形狀**：把 `ChildProcess.prototype.kill` 換成記錄器（不真的送訊號），看守衛有沒有擋住。
 * - **真的行程**：另起一個 `detached`（自己的行程群組）的子行程重現同一個視窗，父測試看它是正常結束還是被訊號殺掉。
 *   **`detached` 是這組測試的安全邊界**：守衛拿掉時被殺的只有那個子行程的群組，測試行程本身不受影響。
 */

import { ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { GitRunner } from './git.js';

const GIT_SOURCE = fileURLToPath(new URL('./git.ts', import.meta.url));
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const MISSING_EXECUTABLE = '/nonexistent-nexus-1742/git';
const LIMITS = { timeoutMs: 60_000, outputMaxBytes: 1024 };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GitRunner 的 terminate', () => {
  it('spawn 失敗的同一個 tick 裡 abort：不呼叫 kill（kill 會變成對整個行程群組送訊號），這一趟照常以 spawn 錯誤 reject', async () => {
    const kill = vi.spyOn(ChildProcess.prototype, 'kill').mockReturnValue(true);
    const runner = new GitRunner(MISSING_EXECUTABLE, LIMITS);
    const controller = new AbortController();
    const result = runner.run(['status'], { cwd: tmpdir(), signal: controller.signal });
    controller.abort(); // run() 的 spawn 是同步發生的：此刻 child 還沒有 pid，'error' 還在 nextTick 的路上。
    await expect(result).rejects.toThrow(/ENOENT/u);
    expect(kill).not.toHaveBeenCalled();
  });

  it('git 已經結束（exit 到了、stdout 還被孫行程握著所以 close 沒到）時 abort：不再送訊號', async () => {
    const kill = vi.spyOn(ChildProcess.prototype, 'kill').mockReturnValue(true);
    const runner = new GitRunner(process.execPath, LIMITS);
    const controller = new AbortController();
    const script = [
      "const { spawn } = require('node:child_process');",
      "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'ignore'] }).unref();",
    ].join('\n');
    const result = runner.run(['-e', script], { cwd: tmpdir(), signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 400)); // 直接子行程早已結束，close 要等孫行程放開 stdout
    controller.abort();
    await expect(result).rejects.toThrow(/aborted/u);
    expect(kill).not.toHaveBeenCalled();
  }, 20_000);

  it('對照：起得來的 git 被 abort 照樣收（SIGTERM）', async () => {
    const kill = vi.spyOn(ChildProcess.prototype, 'kill').mockReturnValue(true);
    const runner = new GitRunner(process.execPath, LIMITS);
    const controller = new AbortController();
    // `node -e` 掛住；kill 被換成記錄器所以不會真的結束，abort 之後自己用 stdin 關不掉，就讓它跑 1 秒的逾時收尾。
    const result = runner.run(['-e', 'setTimeout(() => {}, 1500)'], {
      cwd: tmpdir(),
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    controller.abort();
    await expect(result).rejects.toThrow(/aborted/u);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
  }, 20_000);
});

/** 當「serve」的子行程：`abort` 在 spawn 失敗的同一個 tick 裡取消；`exit` 登記後直接 `process.exit(0)`。 */
const DRIVER = (mode: string) => `
import { spawn } from 'node:child_process';
import { trackHostExitChild } from '@nexus/core';
import { GitRunner } from ${JSON.stringify(GIT_SOURCE)};

if (${JSON.stringify(mode)} === 'abort') {
  const runner = new GitRunner(${JSON.stringify(MISSING_EXECUTABLE)}, { timeoutMs: 60_000, outputMaxBytes: 1024 });
  const controller = new AbortController();
  const result = runner.run(['status'], { cwd: process.cwd(), signal: controller.signal });
  controller.abort();
  const message = await result.then(() => 'resolved', (error) => String(error.code));
  console.log(JSON.stringify({ message }));
} else {
  const child = spawn(${JSON.stringify(MISSING_EXECUTABLE)}, [], { stdio: 'ignore' });
  trackHostExitChild(child);
  console.log(JSON.stringify({ pid: child.pid ?? null }));
}
process.exit(0);
`;

const cleanup: string[] = [];
afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});

/**
 * 在自己的行程群組裡跑 driver；守衛沒擋住時被殺的是那個群組，回傳它的結束碼、收到的訊號與 stdout。
 * **要用 `spawn` 的 `detached`**：`execFile` 不認 `detached`，driver 會留在測試的行程群組裡，守衛拿掉時連測試行程一起被殺。
 */
async function runDriver(mode: 'abort' | 'exit') {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-git-no-pid-'));
  cleanup.push(dir);
  const driver = join(dir, 'driver.mts');
  await writeFile(driver, DRIVER(mode));
  const child = spawn(process.execPath, ['--import', 'tsx', driver], {
    cwd: PACKAGE_DIR,
    detached: true,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  return await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string }>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        // 逾時只收 driver 自己的群組；pid 先抄進區域變數過守衛，`no-group-signal.test.ts` 的掃描器認這個形狀（`-pid` 前面要有 `Number.isInteger(pid) && pid > 1`）。
        const pid = child.pid;
        if (pid !== undefined && Number.isInteger(pid) && pid > 1) process.kill(-pid, 'SIGKILL');
        reject(new Error('driver 逾時'));
      }, 30_000);
      child.once('error', reject);
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, stdout: stdout.trim() });
      });
    },
  );
}

describe('真的行程：守衛拿掉時整個群組會被殺，這裡是正常結束', () => {
  it('git 的 abort 落在 spawn 失敗的同一個 tick：行程活著走到結尾、正常結束', async () => {
    const result = await runDriver('abort');
    expect({ code: result.code, signal: result.signal }).toEqual({ code: 0, signal: null });
    expect(JSON.parse(result.stdout)).toEqual({ message: 'ENOENT' });
  }, 40_000);

  it('登記了 spawn 失敗的 child 就 process.exit(0)：exit 上不送 SIGKILL，正常結束', async () => {
    const result = await runDriver('exit');
    expect({ code: result.code, signal: result.signal }).toEqual({ code: 0, signal: null });
    expect(JSON.parse(result.stdout)).toEqual({ pid: null });
  }, 40_000);
});
