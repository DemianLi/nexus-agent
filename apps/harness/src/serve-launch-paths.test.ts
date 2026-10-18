/**
 * serve 帶 `--workspace` 起來時，key 來源與 harness home 不能跟工作區重疊
 * （[#1620](https://github.com/DemianLi/nexus-agent/issues/1620)）——端到端，走 `runServe`。
 *
 * 函式本身的邊界（相等、`--workspace /`、反方向、舊位置、ELOOP）在 `launch-paths.test.ts`。**這一檔只 import `runServe` 與
 * 測試夾具**，同一份檔可以原封不動丟到還沒有這道檢查的樹上跑，量「今天起得來」。
 *
 * 帶 `--live` 的那一條在測試行程裡跑也不會寫 `process.env`：這道檢查排在讀 `.env` 之前，被拒的那一次一份都不讀。
 * 斷言裡也量了這一點（假 key 的名字沒進 `process.env`）。
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { HARNESS_HOME_ENV } from './harness-home.js';
import { runServe } from './serve.js';
import type { RunningServe, RunServeOptions } from './serve.js';

const PERSISTENCE_OFF_PATCH = fileURLToPath(
  new URL('./settings/persistence-off.patch.yml', import.meta.url),
);

/** 夾具 `.env` 用的名字：不是任何真的 key 名，進了 `process.env` 也不會被誰拿去用。 */
const FAKE_NAME = 'FAKE_1620_API_KEY';

let running: RunningServe | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
  Reflect.deleteProperty(process.env, FAKE_NAME);
});

async function tmp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/**
 * 起一台；起來了就記下（`afterEach` 會關）並回 `undefined`，被拒就回那個錯。
 * 起得來／起不來兩種結果都要分得出來：檢查不在的時候（突變、還沒有這道檢查的樹）它是起得來的。
 */
async function startOrError(options: RunServeOptions): Promise<Error | undefined> {
  try {
    running = (await runServe(options)) as RunningServe;
    return undefined;
  } catch (error) {
    return error as Error;
  }
}

/** 一份帶假 key 的 `.env`，回假 key 的值。 */
async function writeFakeEnv(dir: string): Promise<string> {
  const value = `fake-${randomUUID()}`;
  await writeFile(join(dir, '.env'), `${FAKE_NAME}=${value}\n`);
  return value;
}

const OVERLAP = /serve 起不來：下面這些跟 --workspace .*重疊/su;

describe('工作區裡的 .env', () => {
  it('帶 --live：當場拒絕，點名那份 .env；訊息與日誌不含假 key，也沒載進行程環境，工作區沒多出檔', async () => {
    const workspace = await tmp('nexus-1620-ws-');
    const home = await tmp('nexus-1620-home-');
    const value = await writeFakeEnv(workspace);
    const before = await readdir(workspace);
    const lines: string[] = [];
    const error = await startOrError({
      argv: ['--port', '0', '--live', '--workspace', workspace],
      cwd: workspace,
      log: (line) => lines.push(line),
      env: { [HARNESS_HOME_ENV]: home },
    });
    expect(error?.message).toMatch(OVERLAP);
    expect(error?.message).toContain(`目前資料夾的 .env：${join(workspace, '.env')}`);
    expect(error?.message).not.toContain(value);
    expect(lines.join('\n')).not.toContain(value);
    expect(process.env[FAKE_NAME]).toBeUndefined();
    expect(await readdir(workspace)).toEqual(before);
  });

  it('不帶 --live 也擋（Q2 (b)）：同一個目錄下次帶 --live 重啟，就是這一份被讀', async () => {
    const workspace = await tmp('nexus-1620-ws-');
    const home = await tmp('nexus-1620-home-');
    await writeFakeEnv(workspace);
    const error = await startOrError({
      argv: ['--port', '0', '--workspace', workspace],
      cwd: workspace,
      log: () => undefined,
      env: { [HARNESS_HOME_ENV]: home },
    });
    expect(error?.message).toMatch(OVERLAP);
    expect(error?.message).toContain(`目前資料夾的 .env：${join(workspace, '.env')}`);
  });
});

describe('home 在工作區裡（不帶 --live：home 的規則不看這個旗標）', () => {
  it('--session-log 指到工作區外：拒絕，工作區保持空的（沒有 home/、沒有 serve.lock）', async () => {
    const workspace = await tmp('nexus-1620-ws-');
    const logs = await tmp('nexus-1620-logs-');
    const error = await startOrError({
      argv: ['--port', '0', '--workspace', workspace, '--session-log', logs],
      log: () => undefined,
      env: { [HARNESS_HOME_ENV]: join(workspace, 'home') },
    });
    expect(error?.message).toMatch(OVERLAP);
    expect(error?.message).toContain(
      `harness home（${HARNESS_HOME_ENV}）：${join(workspace, 'home')}`,
    );
    expect(await readdir(workspace)).toEqual([]);
  });

  it('落盤關掉：一樣拒絕，工作區保持空的', async () => {
    const workspace = await tmp('nexus-1620-ws-');
    const error = await startOrError({
      argv: ['--port', '0', '--patch', PERSISTENCE_OFF_PATCH, '--workspace', workspace],
      log: () => undefined,
      env: { [HARNESS_HOME_ENV]: join(workspace, 'home') },
    });
    expect(error?.message).toMatch(OVERLAP);
    expect(await readdir(workspace)).toEqual([]);
  });
});

describe('別名：比的是實際位置', () => {
  it('--workspace 給一條指向工作區的 symlink，.env 在真的那一份裡：拒絕', async () => {
    const workspace = await tmp('nexus-1620-ws-');
    const home = await tmp('nexus-1620-home-');
    const alias = join(await tmp('nexus-1620-alias-'), 'ws');
    await symlink(workspace, alias);
    await writeFakeEnv(workspace);
    const error = await startOrError({
      argv: ['--port', '0', '--workspace', alias],
      cwd: workspace,
      log: () => undefined,
      env: { [HARNESS_HOME_ENV]: home },
    });
    expect(error?.message).toMatch(OVERLAP);
    expect(error?.message).toContain(`實際位置 ${await realpath(workspace)}`);
  });

  it('home 經 symlink 指進工作區：拒絕', async () => {
    const workspace = await tmp('nexus-1620-ws-');
    await mkdir(join(workspace, 'home'));
    const home = join(await tmp('nexus-1620-alias-'), 'home');
    await symlink(join(workspace, 'home'), home);
    const error = await startOrError({
      argv: ['--port', '0', '--workspace', workspace],
      log: () => undefined,
      env: { [HARNESS_HOME_ENV]: home },
    });
    expect(error?.message).toMatch(OVERLAP);
    expect(error?.message).toContain(`harness home（${HARNESS_HOME_ENV}）：${home}`);
  });

  it('大小寫：不分大小寫的檔案系統上，換個寫法的 --workspace 也擋', async (ctx) => {
    const workspace = await tmp('nexus-1620-case-');
    const variant = join(dirname(workspace), basename(workspace).toUpperCase());
    if (variant === workspace || !existsSync(variant)) {
      ctx.skip(`這個檔案系統分大小寫（${variant} 不存在），量不到大小寫的別名`);
    }
    const home = await tmp('nexus-1620-home-');
    await writeFakeEnv(workspace);
    const error = await startOrError({
      argv: ['--port', '0', '--workspace', variant],
      cwd: workspace,
      log: () => undefined,
      env: { [HARNESS_HOME_ENV]: home },
    });
    expect(error?.message).toMatch(OVERLAP);
  });
});

describe('不該擋的照常起來', () => {
  it('.env 與 home 都在工作區外，工作區裡有一條指向 home 的目錄連結：起得來（不掃描）', async () => {
    const workspace = await tmp('nexus-1620-ws-');
    const home = await tmp('nexus-1620-home-');
    const cwd = await tmp('nexus-1620-cwd-');
    await writeFakeEnv(cwd);
    await symlink(home, join(workspace, 'link-to-home'));
    const error = await startOrError({
      argv: ['--port', '0', '--workspace', workspace],
      cwd,
      log: () => undefined,
      env: { [HARNESS_HOME_ENV]: home },
    });
    expect(error).toBeUndefined();
  });

  it('沒給 --workspace：cwd 的 .env 與 home 在哪裡都起得來', async () => {
    const cwd = await tmp('nexus-1620-cwd-');
    await writeFakeEnv(cwd);
    const error = await startOrError({
      argv: ['--port', '0'],
      cwd,
      log: () => undefined,
      env: { [HARNESS_HOME_ENV]: join(cwd, 'home') },
    });
    expect(error).toBeUndefined();
  });
});
