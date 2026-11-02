/**
 * 行程被強制結束時，還在跑的 git 跟著被收掉（[#1542](https://github.com/DemianLi/nexus-agent/issues/1542)）。
 *
 * **另起一個子行程當「serve」**：它用 {@link GitRunner} 起一支假 git（忽略 SIGTERM、一直掛著），等假 git 起來就 `process.exit(0)`
 * ——強制結束的三條路（第二次訊號、收尾逾時、致命退出）最後都走這一步。父測試等它結束，看假 git 還在不在。
 *
 * 對照組用裸 `spawn` 起同一支假 git：Node 不替你收子行程，它要還活著，「GitRunner 起的不在了」才有意義。
 * 登記表本身的單元測試在 `packages/nexus-core/src/host-exit-children.test.ts`。
 */

import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const GIT_SOURCE = fileURLToPath(new URL('./git.ts', import.meta.url));
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));

/** 假 git：把 pid 寫進檔、忽略 SIGTERM、一直掛著；`FAKE_GIT_QUICK=1` 時寫完就結束。 */
const FAKE_GIT = `#!${process.execPath}
// 寫暫存檔再 rename：pid 檔一出現就是完整的（直接 writeFileSync 會先建出空檔，#1712）。
const fs = require('node:fs');
fs.writeFileSync(process.env.FAKE_GIT_PID_FILE + '.tmp', String(process.pid));
fs.renameSync(process.env.FAKE_GIT_PID_FILE + '.tmp', process.env.FAKE_GIT_PID_FILE);
if (process.env.FAKE_GIT_QUICK === '1') process.exit(0);
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`;

/** 當「serve」的子行程：`tracked` 經 GitRunner 起假 git，`bare` 用裸 spawn，`completed` 等 GitRunner 跑完才結束。 */
const DRIVER = (mode: string) => `
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { GitRunner } from ${JSON.stringify(GIT_SOURCE)};

const [fakeGit, pidFile, cwd] = process.argv.slice(2);
const env = { FAKE_GIT_PID_FILE: pidFile };
const waitForPid = async () => {
  while (!existsSync(pidFile)) await new Promise((resolve) => setTimeout(resolve, 10));
};
const runner = new GitRunner(fakeGit, { timeoutMs: 60_000, outputMaxBytes: 1024 });
const signal = new AbortController().signal;
if (${JSON.stringify(mode)} === 'tracked') {
  void runner.run(['add'], { cwd, env, signal });
  await waitForPid();
  process.exit(0);
} else if (${JSON.stringify(mode)} === 'bare') {
  spawn(fakeGit, ['add'], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  await waitForPid();
  process.exit(0);
} else {
  await runner.run(['add'], { cwd, env: { ...env, FAKE_GIT_QUICK: '1' }, signal });
  // 正常結束：close 先到、登記已經拿掉，'exit' 上沒有東西要殺。
  const armed = process.listeners('exit').some((listener) => listener.name === 'terminateHostExitChildren');
  console.log(JSON.stringify({ armed }));
  process.exit(0);
}
`;

const cleanup: string[] = [];
const leftovers: number[] = [];
afterEach(async () => {
  for (const pid of leftovers.splice(0)) killPid(pid);
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});

/**
 * 對單一行程送 SIGKILL。pid 不是大於 1 的整數就丟錯、不送：`process.kill(0, …)` 殺整個行程群組（含 vitest 主行程與外層 shell），
 * 而 `Number('')` 就是 0（#1712；`apps/harness/src/test-pids.fixture.ts` 是同一份）。
 */
function killPid(pid: number): void {
  if (!(Number.isInteger(pid) && pid > 1)) {
    throw new RangeError(`不是可以送訊號的 pid：${String(pid)}`);
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

/** 等 pid 檔出現而且內容是完整的整數（寫的人先建檔、後寫字，直接讀會讀到空字串）。 */
async function readPid(path: string): Promise<number> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const text = await readFile(path, 'utf8').catch(() => '');
    if (/^\d+\s*$/u.test(text) && Number.isInteger(Number(text)) && Number(text) > 1)
      return Number(text);
    if (Date.now() >= deadline)
      throw new Error(`等不到 ${path} 的完整 pid（讀到 ${JSON.stringify(text)}）`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function alive(pid: number): boolean {
  if (!(Number.isInteger(pid) && pid > 1))
    throw new RangeError(`不是可以送訊號的 pid：${String(pid)}`);
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

/** 跑一次「serve」到它自己結束；回傳假 git 的 pid 與「serve」的 stdout。 */
async function serveThenExit(mode: 'tracked' | 'bare' | 'completed') {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-git-host-exit-'));
  cleanup.push(dir);
  const fakeGit = join(dir, 'git');
  await writeFile(fakeGit, FAKE_GIT);
  await chmod(fakeGit, 0o755);
  const driver = join(dir, 'driver.mts'); // 暫存目錄沒有 package.json，`.ts` 會被 tsx 當 CJS 轉、頂層 await 過不了
  await writeFile(driver, DRIVER(mode));
  const pidFile = join(dir, 'pid');
  const { stdout } = await run(
    process.execPath,
    ['--import', 'tsx', driver, fakeGit, pidFile, dir],
    { cwd: PACKAGE_DIR, timeout: 20_000 },
  );
  const pid = await readPid(pidFile);
  leftovers.push(pid);
  return { pid, stdout };
}

/** SIGKILL 是非同步送達的：等一下再判斷。 */
async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !alive(pid);
}

describe('行程結束時收掉還在跑的 git', () => {
  it('對照：裸 spawn 的子行程在父行程 process.exit 之後還活著（Node 不替你收）', async () => {
    const { pid } = await serveThenExit('bare');
    expect(await goneWithin(pid, 1000)).toBe(false);
  }, 30_000);

  it('GitRunner 起的 git：父行程 process.exit 之後被 SIGKILL 收掉（它忽略 SIGTERM）', async () => {
    const { pid } = await serveThenExit('tracked');
    expect(await goneWithin(pid, 3000)).toBe(true);
  }, 30_000);

  it('git 正常跑完才結束：登記已經拿掉，exit 上沒有東西要殺', async () => {
    const { pid, stdout } = await serveThenExit('completed');
    expect(JSON.parse(stdout.trim())).toEqual({ armed: false });
    expect(alive(pid)).toBe(false);
  }, 30_000);
});
