/**
 * 寫入口試掛碰到連不上的 MCP 列（[#2125](https://github.com/DemianLi/nexus-agent/issues/2125)）：沒寫 `failOnStartupError` 的列，
 * 試掛最多等 {@link FIRST_CONNECT_WAIT_MS} 就照「連不上」處理；寫了的列照舊等到落定、連不上算掉，判法同 serve。
 *
 * 試掛收池之後，還在握手的子行程照樣活到 SDK 的請求逾時（`@nexus/plugin-mcp` `supervisor.ts` 檔頭偏離 6），所以「寫一次要多久、
 * 留不留子行程」只在真的 `plugin` 行程上量得到：進入點排空輸出就 exit，子行程收到 stdin 的 EOF 自己退。
 *
 * 握手卡住用 `modern-stdio-server.ts` 的 `FIXTURE_HANG_IF_FILE`（讀著 stdin、永遠不回 initialize）；一啟動就退出的 server 是
 * `node -e 'process.exit(1)'`。home 放 `/var/tmp`，不放系統暫存目錄。
 */

import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FIRST_CONNECT_WAIT_MS } from '@nexus/plugin-mcp';
import { afterEach, describe, expect, it } from 'vitest';

import { HARNESS_HOME_ENV } from './harness-home.js';
import { defaultSources } from './plugin-config.js';
import { seedHomePatch } from './plugin-journal.fixture.js';
import { trialMount } from './plugin-trial.js';
import { signalPid } from './test-pids.fixture.js';

const MODERN_SERVER = fileURLToPath(
  new URL('../../../packages/nexus-plugin-mcp/src/modern-stdio-server.ts', import.meta.url),
);

/** 關池時每一份的收尾期限（`@nexus/plugin-mcp` 監督者的 `GENERATION_CLOSE_TIMEOUT_MS`）。 */
const CLOSE_LIMIT_MS = 5_000;

const temporary: string[] = [];
const markers: string[] = [];

afterEach(() => {
  for (const marker of markers.splice(0))
    for (const pid of pidsOf(marker)) signalPid(pid, 'SIGKILL');
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 命令列含記號的行程；不經 shell。 */
function pidsOf(marker: string): number[] {
  try {
    return execFileSync('pgrep', ['-f', '--', marker])
      .toString()
      .split('\n')
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

/** 一個 home，紀錄裡插一列 stdio MCP；回 `defaultSources` 要的 env 與那一列 server 的記號。 */
function home(
  connection: { args: string[]; env?: Record<string, string> },
  failOnStartupError: boolean,
) {
  const dir = mkdtempSync('/var/tmp/nexus-trial-mcp-');
  chmodSync(dir, 0o700);
  temporary.push(dir);
  const config = {
    serverName: 'crm',
    approval: { default: 'allow' },
    ...(failOnStartupError && { failOnStartupError: true }),
    connection: { transport: 'stdio', command: process.execPath, ...connection },
  };
  seedHomePatch(
    dir,
    `- insert:\n    - id: mcp-crm\n      name: '@nexus/plugin-mcp'\n      config: ${JSON.stringify(config)}\n`,
  );
  return { dir, env: { ...process.env, [HARNESS_HOME_ENV]: dir } };
}

/** 握手卡住的那一台。 */
function hung(failOnStartupError: boolean) {
  const marker = `--marker-${randomUUID()}`;
  markers.push(marker);
  const flagDir = mkdtempSync('/var/tmp/nexus-trial-mcp-flag-');
  temporary.push(flagDir);
  const flag = join(flagDir, 'hang');
  writeFileSync(flag, '');
  const made = home(
    { args: ['--import', 'tsx', MODERN_SERVER, marker], env: { FIXTURE_HANG_IF_FILE: flag } },
    failOnStartupError,
  );
  return { ...made, marker };
}

/** 一啟動就退出的那一台。 */
const exits = (failOnStartupError: boolean) =>
  home({ args: ['-e', 'process.exit(1)'] }, failOnStartupError);

const trial = ({ dir, env }: { dir: string; env: NodeJS.ProcessEnv }) =>
  trialMount(defaultSources({ serve: true, env }), { env, cwd: dir });

describe('試掛碰到連不上的 MCP 列（#2125）', () => {
  it('握手卡住、沒寫 failOnStartupError：等到期限就回來，不算掉', async () => {
    const h = hung(false);
    const started = Date.now();
    const failures = await trial(h);
    const waited = Date.now() - started;
    console.log(`#2125：握手卡住的列，試掛花了 ${String(waited)} ms`);
    expect(waited).toBeLessThan(FIRST_CONNECT_WAIT_MS + CLOSE_LIMIT_MS + 3_000);
    expect(failures).toEqual([]);
  }, 40_000);

  it('一啟動就退出、寫了 failOnStartupError：這一列在 apply 掉', async () => {
    const failures = await trial(exits(true));
    expect(failures).toEqual([
      expect.objectContaining({ id: 'mcp-crm', stage: 'apply', required: false, pending: false }),
    ]);
  }, 40_000);

  it('一啟動就退出、沒寫 failOnStartupError：不算掉（同 serve，只警告）', async () => {
    expect(await trial(exits(false))).toEqual([]);
  }, 40_000);
});

describe('plugin 行程（#2125）', () => {
  const entry = fileURLToPath(new URL('./plugin-cli.ts', import.meta.url));
  const harnessDir = fileURLToPath(new URL('../', import.meta.url));

  it('一列握手卡住的 MCP：寫完就結束，輸出完整；結束後沒有殘留的子行程', async () => {
    const h = hung(false);
    const started = Date.now();
    const child = spawn(process.execPath, ['--import', 'tsx', entry, 'disable', 'todo'], {
      cwd: harnessDir,
      env: h.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => void stdout.push(chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => void stderr.push(chunk));
    const code = await new Promise<number | null>((settle, fail) => {
      child.once('error', fail);
      child.once('close', settle);
    });
    const wall = Date.now() - started;
    console.log(`#2125：plugin 行程從起到結束 ${String(wall)} ms`);
    expect(code).toBe(0);
    // home 沒有 serve 留的快照，所以 stderr 只有那一句警告；整句連換行都要在。
    expect(stderr.join('')).toMatch(/^警告：[^\n]*沒有 plugin-snapshot\.json[^\n]*請自己確認。\n$/);
    // 上界：一次試掛（等期限＋收池）加行程起動；沒有這道 exit 的話要等到握手逾時，約 120 秒。
    expect(wall).toBeLessThan(FIRST_CONNECT_WAIT_MS + CLOSE_LIMIT_MS + 15_000);
    const lines = stdout.join('').trimEnd().split('\n');
    expect(lines[0]).toMatch(/^已寫入 /);
    expect(lines.at(-1)).toBe('  生效：新對話生效（下一條 thread 起）；開著的對話不變');
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(pidsOf(h.marker)).toEqual([]);
  }, 60_000);
});
