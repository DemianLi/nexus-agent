/**
 * 行程被強制結束時，還在跑的 rg 跟著被收掉（[#1532](https://github.com/DemianLi/nexus-agent/issues/1532) 補充，
 * 登記表是 [#1542](https://github.com/DemianLi/nexus-agent/issues/1542) 的 `trackHostExitChild`）。
 *
 * **另起一個子行程當「serve」**：它用 {@link ContainedFilesystemBackend.grep} 起一支假 rg（忽略 SIGTERM、一直掛著），
 * 等假 rg 起來就 `process.exit(0)`——強制結束的三條路最後都走這一步。父測試等它結束，看假 rg 還在不在。
 * 做法照 `packages/nexus-plugin-workspace-changes/src/git-host-exit.test.ts`。
 *
 * 對照組用裸 `spawn` 起同一支假 rg：Node 不替你收子行程，它要還活著，「grep 起的不在了」才有意義。
 * 拿掉 `ripgrep-runner.ts` 裡的 `trackHostExitChild` 那一行，第二條會紅。
 */

import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const BACKEND_SOURCE = fileURLToPath(new URL('./contained-backend.ts', import.meta.url));
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));

/** 假 rg：把 pid 寫進檔、忽略 SIGTERM、一直掛著；`FAKE_RG_QUICK=1` 時寫完就以「零筆」結束。 */
const FAKE_RG = `#!${process.execPath}
require('node:fs').writeFileSync(process.env.FAKE_RG_PID_FILE, String(process.pid));
if (process.env.FAKE_RG_QUICK === '1') process.exit(1);
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`;

/** 當「serve」的子行程。 */
const DRIVER = (mode: string) => `
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { ContainedFilesystemBackend } from ${JSON.stringify(BACKEND_SOURCE)};

const [fakeRg, pidFile, root] = process.argv.slice(2);
const waitForPid = async () => {
  while (!existsSync(pidFile)) await new Promise((resolve) => setTimeout(resolve, 10));
};
const backend = new ContainedFilesystemBackend({ rootDir: root, ripgrep: { executable: fakeRg } });
if (${JSON.stringify(mode)} === 'tracked') {
  void backend.grep('needle', '/');
  await waitForPid();
  process.exit(0);
} else if (${JSON.stringify(mode)} === 'bare') {
  spawn(fakeRg, [], { cwd: root, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  await waitForPid();
  process.exit(0);
} else {
  await backend.grep('needle', '/');
  // 正常結束：close 先到、登記已經拿掉，'exit' 上沒有東西要殺。
  const armed = process.listeners('exit').some((listener) => listener.name === 'terminateHostExitChildren');
  console.log(JSON.stringify({ armed }));
  process.exit(0);
}
`;

const cleanup: string[] = [];
const leftovers: number[] = [];
afterEach(async () => {
  for (const pid of leftovers.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 已經不在了。
    }
  }
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

/** 跑一次「serve」到它自己結束；回傳假 rg 的 pid 與「serve」的 stdout。 */
async function serveThenExit(mode: 'tracked' | 'bare' | 'completed') {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-rg-host-exit-'));
  cleanup.push(dir);
  const fakeRg = join(dir, 'rg');
  await writeFile(fakeRg, FAKE_RG);
  await chmod(fakeRg, 0o755);
  const driver = join(dir, 'driver.mts'); // 暫存目錄沒有 package.json，`.ts` 會被 tsx 當 CJS 轉、頂層 await 過不了
  await writeFile(driver, DRIVER(mode));
  const pidFile = join(dir, 'pid');
  const { stdout } = await run(
    process.execPath,
    ['--import', 'tsx', driver, fakeRg, pidFile, dir],
    {
      cwd: PACKAGE_DIR,
      timeout: 20_000,
      env: {
        ...process.env,
        FAKE_RG_PID_FILE: pidFile,
        ...(mode === 'completed' ? { FAKE_RG_QUICK: '1' } : {}),
      },
    },
  );
  const pid = Number(await readFile(pidFile, 'utf8'));
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

describe('行程結束時收掉還在跑的 rg', () => {
  it('對照：裸 spawn 的子行程在父行程 process.exit 之後還活著（Node 不替你收）', async () => {
    const { pid } = await serveThenExit('bare');
    expect(await goneWithin(pid, 1000)).toBe(false);
  }, 30_000);

  it('grep 起的 rg：父行程 process.exit 之後被 SIGKILL 收掉（它忽略 SIGTERM）', async () => {
    const { pid } = await serveThenExit('tracked');
    expect(await goneWithin(pid, 3000)).toBe(true);
  }, 30_000);

  it('rg 正常跑完才結束：登記已經拿掉，exit 上沒有東西要殺', async () => {
    const { pid, stdout } = await serveThenExit('completed');
    expect(JSON.parse(stdout.trim())).toEqual({ armed: false });
    expect(alive(pid)).toBe(false);
  }, 30_000);
});
