/**
 * serve 的伺服器日誌：等級、格式、命令輸出、起不來時的回放（[#1534](https://github.com/DemianLi/nexus-agent/issues/1534)）。
 *
 * 前三組跑 `runServe`（`log` 收一行一行），最後一組另起一個 serve 行程、讀真正的標準輸出——接線有沒有接上，只有行程邊界上看得到
 * （同 `serve-shutdown.test.ts` 的 `startServe`）。exporter 本身的行為（門檻、換算、JSON、回放）釘在 `server-log.test.ts`。
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

const serveEntry = fileURLToPath(new URL('./serve.ts', import.meta.url));
const harnessDir = fileURLToPath(new URL('../', import.meta.url));

const temporary: string[] = [];
let running: RunningServe | undefined;
let child: ChildProcess | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
  if (child !== undefined && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
  child = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

function privateDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'nexus-serve-log-format-'));
  temporary.push(root);
  chmodSync(root, 0o700);
  return root;
}

function writePatch(dir: string, content: string): string {
  const path = join(dir, 'log.patch.yml');
  writeFileSync(path, content);
  chmodSync(path, 0o600);
  return path;
}

/** 一格設定壞掉的 `todo`：它是可少掛的，所以 serve 起得來、啟動時印一段警告（warn 等級）指名它。 */
const BAD_TODO = "- id: todo\n  config:\n    allowParallelInProgress: '不是布林'\n";

const LINE_PREFIX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[([EWID])\] (\S+) /u;

async function startWith(patch: string, home: string): Promise<{ lines: string[] }> {
  const lines: string[] = [];
  running = (await runServe({
    argv: ['--port', '0', '--patch', patch],
    log: (line) => lines.push(line),
    env: { [HARNESS_HOME_ENV]: home },
  })) as RunningServe;
  return { lines };
}

describe('出廠預設：每一行都帶等級與名字，印出來的行和以前一樣多', () => {
  it('啟動披露是 info，每一行都有「時間 [等級] 名字」前綴', async () => {
    const home = privateDir();
    const { lines } = await startWith(writePatch(home, '[]\n'), home);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line, line).toMatch(LINE_PREFIX);
    const model = lines.find((line) => line.includes('模型：'));
    expect(model).toMatch(/\[I\] serve 模型：/u);
    expect(lines.some((line) => /\[I\] serve plugin：/u.test(line))).toBe(true);
    expect(lines.some((line) => /\[I\] serve thread 上限：500（/u.test(line))).toBe(true);
    expect(lines.some((line) => /\[I\] serve 沙箱：/u.test(line))).toBe(true);
  });
});

describe('門檻（驗收 1）', () => {
  it('levels.default 設成 warn：披露不出現，`警告：…沒有掛上` 照樣出現且是 warn 等級', async () => {
    const home = privateDir();
    const patch = writePatch(
      home,
      `- id: logger-console\n  config:\n    levels:\n      default: warn\n${BAD_TODO}`,
    );
    const { lines } = await startWith(patch, home);
    expect(lines.some((line) => line.includes('模型：'))).toBe(false);
    expect(lines.some((line) => line.includes('plugin：'))).toBe(false);
    expect(lines.some((line) => line.includes('thread 上限：'))).toBe(false);
    const warning = lines.find((line) => line.includes('警告：1 列沒有掛上'));
    expect(warning).toMatch(/\[W\] serve 警告：1 列沒有掛上/u);
  });

  it('設定寫壞（等級名稱打錯）：那一列掉了、serve 起得來，警告指名它，門檻回到出廠的 info', async () => {
    const home = privateDir();
    const patch = writePatch(
      home,
      '- id: logger-console\n  config:\n    levels:\n      default: warning\n',
    );
    const { lines } = await startWith(patch, home);
    expect(lines.some((line) => /\[W\] serve 警告：1 列沒有掛上/u.test(line))).toBe(true);
    expect(lines.some((line) => line.includes('logger-console'))).toBe(true);
    expect(lines.some((line) => /\[I\] serve 模型：/u.test(line))).toBe(true);
  });
});

describe('format: json（行程內）', () => {
  it('每一行都能 JSON.parse，警告那一行 level 是 warn、logger 是 serve', async () => {
    const home = privateDir();
    const patch = writePatch(
      home,
      `- id: logger-console\n  config:\n    format: json\n${BAD_TODO}`,
    );
    const { lines } = await startWith(patch, home);
    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed.length).toBeGreaterThan(0);
    const warning = parsed.find((entry) => String(entry['msg']).startsWith('警告：1 列沒有掛上'));
    expect(warning).toMatchObject({ level: 'warn', logger: 'serve' });
    expect(parsed.find((entry) => String(entry['msg']).startsWith('模型：'))).toMatchObject({
      level: 'info',
    });
  });
});

describe('命令的輸出不是日誌（驗收 4）', () => {
  it('format: json、levels.default: error 時，--dump-config-schema 還是只有那份 JSON、--help 照印', async () => {
    const home = privateDir();
    const patch = writePatch(
      home,
      '- id: logger-console\n  config:\n    format: json\n    levels:\n      default: error\n',
    );
    const schemaLines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    // 規格表本來就不完整（有 refine 轉不出來的格），照既有行為拋出去；輸出照樣先印完。
    await runServe({
      argv: ['--dump-config-schema', '--patch', patch],
      log: (line) => schemaLines.push(line),
      env: { [HARNESS_HOME_ENV]: home },
    }).catch(() => undefined);
    expect(schemaLines).toHaveLength(1);
    expect(() => JSON.parse(schemaLines[0] as string)).not.toThrow();
    expect(schemaLines.join('\n')).not.toMatch(LINE_PREFIX);

    const helpLines: string[] = [];
    await runServe({ argv: ['--help'], log: (line) => helpLines.push(line), env: {} });
    expect(helpLines).toHaveLength(1);
    expect(helpLines[0]).toMatch(/^用法：/u);
  });
});

describe('起不來的時候：緩衝裡的話用出廠設定印出來（#1534）', () => {
  it('讀清單時起不來（保護列被停用）：排在它前面的警告（代理）照樣印出來，是 warn 等級', async () => {
    vi.stubEnv('HTTPS_PROXY', 'socks5://user:secret@127.0.0.1:1080');
    const home = privateDir();
    const patch = writePatch(home, '- id: thread-capacity\n  disabled: true\n');
    const lines: string[] = [];
    await expect(
      runServe({
        argv: ['--port', '0', '--patch', patch],
        log: (line) => lines.push(line),
        env: { [HARNESS_HOME_ENV]: home },
        cwd: home,
      }),
    ).rejects.toThrow();
    const proxy = lines.find((line) => line.includes('代理：'));
    expect(proxy).toMatch(/\[W\] serve 代理：/u);
    expect(lines.join('\n')).not.toContain('secret');
  });
});

describe('接線：真的 serve 行程的標準輸出（驗收 7）', () => {
  it('--patch 把 logger-console 的 format 設成 json：標準輸出每一行都能 JSON.parse，網址那一行照樣在', async () => {
    const home = privateDir();
    const patch = writePatch(home, '- id: logger-console\n  config:\n    format: json\n');
    const spawned = spawn(
      process.execPath,
      ['--import', 'tsx', serveEntry, '--port', '0', '--patch', patch],
      {
        cwd: harnessDir,
        env: { ...process.env, [HARNESS_HOME_ENV]: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child = spawned;
    const exited = new Promise<void>((resolve) => spawned.once('exit', () => resolve()));
    let stdout = '';
    const seenUrl = await new Promise<boolean>((resolve) => {
      spawned.stdout.setEncoding('utf8');
      spawned.stdout.on('data', (chunk: string) => {
        stdout += chunk;
        if (/nexus-agent 在 /u.test(stdout) && stdout.endsWith('\n')) resolve(true);
      });
      void exited.then(() => resolve(false));
    });
    expect(seenUrl).toBe(true);
    const lines = stdout.split('\n').filter((line) => line.length > 0);
    // 網址帶 token：不印、不寫進斷言訊息。
    for (const line of lines) {
      expect(() => JSON.parse(line), '標準輸出有一行不是 JSON').not.toThrow();
    }
    const entries = lines.map((line) => JSON.parse(line) as { msg: string; level: string });
    expect(entries.some((entry) => entry.msg.startsWith('nexus-agent 在 '))).toBe(true);
    expect(entries.every((entry) => ['error', 'warn', 'info', 'debug'].includes(entry.level))).toBe(
      true,
    );
    spawned.kill('SIGINT');
    await exited;
  }, 60_000);
});
