/**
 * key 來源與 home 跟 `--workspace` 重疊的檢查（[#1620](https://github.com/DemianLi/nexus-agent/issues/1620)），
 * 與它用的分隔符感知判斷。serve 那一端的端到端在 `serve-launch-paths.test.ts`。
 */

import { mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { assertLaunchPathsOutsideWorkspace, outsideWorkspace } from './assembly-root.js';
import { isWithin } from './canonical-path.js';
import { HARNESS_HOME_ENV } from './harness-home.js';

async function tmp(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

/** 不存在的舊位置：測試不讓程式碼根目錄那一份（主 checkout 上真的有）摻進來。 */
const NO_LEGACY = join(tmpdir(), 'nexus-1620-no-such-legacy.env');

describe('isWithin：感知分隔符', () => {
  it('根本身與子孫都算', () => {
    expect(isWithin('/a', '/a')).toBe(true);
    expect(isWithin('/a', '/a/b/c')).toBe(true);
  });

  it('`--workspace /` 底下什麼都算（`${root}${sep}` 寫法在這裡是 `//`）', () => {
    expect(isWithin('/', '/Users/x/.nexus-agent')).toBe(true);
  });

  it('名字以 `..` 開頭的子目錄也算在底下，不能當成外面', () => {
    expect(isWithin('/a', '/a/..nexus')).toBe(true);
  });

  it('同前綴的兄弟、上層都不算', () => {
    expect(isWithin('/a', '/ab')).toBe(false);
    expect(isWithin('/a/b', '/a')).toBe(false);
  });
});

describe('outsideWorkspace：`--workspace /` 的洞補上了', () => {
  it('根是 `/` 時，預設的日誌根也落在底下', () => {
    expect(() => outsideWorkspace('/home/x/.nexus-agent/sessions', '/', '/', '日誌根')).toThrow(
      '日誌根 不能在 --workspace 底下',
    );
  });
});

describe('assertLaunchPathsOutsideWorkspace', () => {
  it('沒給 --workspace 就不看：cwd 的 .env 與 home 在哪裡都行', async () => {
    const cwd = await tmp('nexus-1620-cwd-');
    await writeFile(join(cwd, '.env'), 'FAKE_1620_API_KEY=x\n');
    await expect(
      assertLaunchPathsOutsideWorkspace({
        workspace: undefined,
        cwd,
        env: { [HARNESS_HOME_ENV]: join(cwd, 'home') },
        legacyEnvFile: NO_LEGACY,
      }),
    ).resolves.toBeUndefined();
  });

  it('cwd 的 .env 不存在就不算：工作區就是 cwd 也照常', async () => {
    const workspace = await tmp('nexus-1620-ws-');
    const home = await tmp('nexus-1620-home-');
    await expect(
      assertLaunchPathsOutsideWorkspace({
        workspace,
        cwd: workspace,
        env: { [HARNESS_HOME_ENV]: home },
        legacyEnvFile: NO_LEGACY,
      }),
    ).resolves.toBeUndefined();
  });

  it('home 就是工作區：拒絕', async () => {
    const workspace = await tmp('nexus-1620-ws-');
    await expect(
      assertLaunchPathsOutsideWorkspace({
        workspace,
        cwd: '/',
        env: { [HARNESS_HOME_ENV]: workspace },
        legacyEnvFile: NO_LEGACY,
      }),
    ).rejects.toThrow(`harness home（${HARNESS_HOME_ENV}）：${workspace}，就是工作區`);
  });

  it('`--workspace /`：拒絕，home 在它底下', async () => {
    const home = await tmp('nexus-1620-home-');
    await expect(
      assertLaunchPathsOutsideWorkspace({
        workspace: '/',
        cwd: '/',
        env: { [HARNESS_HOME_ENV]: home },
        legacyEnvFile: NO_LEGACY,
      }),
    ).rejects.toThrow(`harness home（${HARNESS_HOME_ENV}）：${home}，在工作區之內`);
  });

  it('反方向（Q3）：工作區在 home 底下也拒絕', async () => {
    const home = await tmp('nexus-1620-home-');
    await expect(
      assertLaunchPathsOutsideWorkspace({
        workspace: join(home, 'attachments'),
        cwd: '/',
        env: { [HARNESS_HOME_ENV]: home },
        legacyEnvFile: NO_LEGACY,
      }),
    ).rejects.toThrow(`harness home（${HARNESS_HOME_ENV}）：${home}，包含工作區`);
  });

  it('沒設 NEXUS_AGENT_HOME：訊息講是預設的 ~/.nexus-agent', async () => {
    await expect(
      assertLaunchPathsOutsideWorkspace({
        workspace: '/',
        cwd: '/',
        env: {},
        legacyEnvFile: NO_LEGACY,
      }),
    ).rejects.toThrow('harness home（預設的 ~/.nexus-agent）');
  });

  it('舊位置的 .env 在工作區裡：拒絕，點名舊位置（Q5）', async () => {
    const workspace = await tmp('nexus-1620-ws-');
    const home = await tmp('nexus-1620-home-');
    const legacy = join(workspace, '.env');
    await writeFile(legacy, 'FAKE_1620_API_KEY=x\n');
    await expect(
      assertLaunchPathsOutsideWorkspace({
        workspace,
        cwd: '/',
        env: { [HARNESS_HOME_ENV]: home },
        legacyEnvFile: legacy,
      }),
    ).rejects.toThrow(`程式碼資料夾根目錄的舊 .env：${legacy}，在工作區之內`);
  });

  it('舊位置的 .env 不存在就不算', async () => {
    const workspace = await tmp('nexus-1620-ws-');
    const home = await tmp('nexus-1620-home-');
    await expect(
      assertLaunchPathsOutsideWorkspace({
        workspace,
        cwd: '/',
        env: { [HARNESS_HOME_ENV]: home },
        legacyEnvFile: join(workspace, '.env'),
      }),
    ).resolves.toBeUndefined();
  });

  it('cwd 就是程式碼根目錄：同一個 .env 只點名一次', async () => {
    const workspace = await tmp('nexus-1620-ws-');
    const home = await tmp('nexus-1620-home-');
    await writeFile(join(workspace, '.env'), 'FAKE_1620_API_KEY=x\n');
    const error = await assertLaunchPathsOutsideWorkspace({
      workspace,
      cwd: workspace,
      env: { [HARNESS_HOME_ENV]: home },
      legacyEnvFile: join(workspace, '.env'),
    }).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(error?.message).toContain('目前資料夾的 .env');
    expect(error?.message).not.toContain('舊 .env');
  });

  it('home 在外面、它的 .env 經 symlink 指進工作區：拒絕，點名 home 的 .env', async () => {
    const workspace = await tmp('nexus-1620-ws-');
    const home = await tmp('nexus-1620-home-');
    await writeFile(join(workspace, 'secret.env'), 'FAKE_1620_API_KEY=x\n');
    await symlink(join(workspace, 'secret.env'), join(home, '.env'));
    await expect(
      assertLaunchPathsOutsideWorkspace({
        workspace,
        cwd: '/',
        env: { [HARNESS_HOME_ENV]: home },
        legacyEnvFile: NO_LEGACY,
      }),
    ).rejects.toThrow(
      `harness home 的 .env（${HARNESS_HOME_ENV}）：${join(home, '.env')}（實際位置 ${join(workspace, 'secret.env')}），在工作區之內`,
    );
  });

  it('home 還不存在：用最深的存在祖先判，照樣擋', async () => {
    const workspace = await tmp('nexus-1620-ws-');
    await expect(
      assertLaunchPathsOutsideWorkspace({
        workspace,
        cwd: '/',
        env: { [HARNESS_HOME_ENV]: join(workspace, 'not', 'yet', 'home') },
        legacyEnvFile: NO_LEGACY,
      }),
    ).rejects.toThrow('在工作區之內');
  });

  it('解不開的路徑（ELOOP）原樣拋，訊息帶錯誤碼', async () => {
    const workspace = await tmp('nexus-1620-ws-');
    const cwd = await tmp('nexus-1620-cwd-');
    const home = await tmp('nexus-1620-home-');
    await symlink(join(cwd, '.env'), join(cwd, '.env'));
    await expect(
      assertLaunchPathsOutsideWorkspace({
        workspace,
        cwd,
        env: { [HARNESS_HOME_ENV]: home },
        legacyEnvFile: NO_LEGACY,
      }),
    ).rejects.toThrow('ELOOP');
  });

  it('訊息不含 .env 的內容', async () => {
    const workspace = await tmp('nexus-1620-ws-');
    const home = await tmp('nexus-1620-home-');
    await writeFile(join(workspace, '.env'), 'FAKE_1620_API_KEY=value-that-must-not-leak\n');
    const error = await assertLaunchPathsOutsideWorkspace({
      workspace,
      cwd: workspace,
      env: { [HARNESS_HOME_ENV]: home },
      legacyEnvFile: NO_LEGACY,
    }).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(error?.message).toContain(join(workspace, '.env'));
    expect(error?.message).not.toContain('value-that-must-not-leak');
    expect(error?.message).not.toContain('FAKE_1620_API_KEY');
  });
});
