/**
 * git runner 與 numstat 解析。runner 用一支假的「git」（shell 腳本）量：環境有沒有淨化、逾時、輸出上限。
 */

import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { GitRunner, resolveGitExecutable, scrubbedParentEnv } from './git.js';
import { parseNumstat } from './numstat.js';

const cleanup: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'nexus-wc-git-'));
  cleanup.push(path);
  return path;
}

/** 一支可執行的 shell 腳本。 */
async function script(dir: string, name: string, body: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

const LIMITS = { timeoutMs: 5_000, outputMaxBytes: 1024 };
const signal = new AbortController().signal;

describe('parseNumstat', () => {
  it('一般、二進位、改名、檔名裡的 tab', () => {
    const output = [
      '3\t1\ta.md',
      '-\t-\tbin.dat',
      '0\t0\t',
      'old.md',
      'new.md',
      '1\t0\tt\tab.md',
      '',
    ];
    expect(parseNumstat(output.join('\0'))).toEqual([
      { path: 'a.md', added: 3, deleted: 1, binary: false },
      { path: 'bin.dat', added: 0, deleted: 0, binary: true },
      { path: 'new.md', oldPath: 'old.md', added: 0, deleted: 0, binary: false },
      { path: 't\tab.md', added: 1, deleted: 0, binary: false },
    ]);
    expect(parseNumstat('')).toEqual([]);
  });

  it('被截斷的輸出當場拋', () => {
    expect(() => parseNumstat('1\t0\ta.md')).toThrow('not NUL-terminated');
    expect(() => parseNumstat('1\t0\0')).toThrow('malformed numstat record');
    expect(() => parseNumstat('0\t0\t\0old.md\0')).toThrow('malformed numstat rename record');
  });
});

describe('環境淨化', () => {
  it('拿掉名字像憑證的與 `NEXUS_*`，不分大小寫；其餘照留', () => {
    expect(
      scrubbedParentEnv({
        PATH: '/bin',
        HOME: '/h',
        OPENAI_API_KEY: 'k',
        GH_TOKEN: 't',
        db_password: 'p',
        MY_SECRET: 's',
        GIT_CONFIG_KEY_0: 'core.hooksPath',
        NEXUS_AGENT_HOME: '/n',
        nexus_x: 'x',
        UNDEFINED: undefined,
      }),
    ).toEqual({ PATH: '/bin', HOME: '/h' });
  });

  it('子行程拿到的是淨化過的環境，外加 dsh 那四個 git 變數', async () => {
    vi.stubEnv('FAKE_API_TOKEN', 'leak');
    vi.stubEnv('NEXUS_AGENT_HOME', '/somewhere');
    vi.stubEnv('KEEP_ME', 'yes');
    const dir = await directory();
    const runner = new GitRunner(await script(dir, 'git', 'env'), LIMITS);
    const { stdout, exitCode, truncated } = await runner.run([], {
      cwd: dir,
      env: { EXTRA: '1' },
      maxBytes: 1024 * 1024,
      signal,
    });
    const env = new Map(stdout.split('\n').map((line) => line.split('=', 2) as [string, string]));
    expect({ exitCode, truncated }).toEqual({ exitCode: 0, truncated: false });
    expect(env.get('KEEP_ME')).toBe('yes');
    expect(env.get('EXTRA')).toBe('1');
    expect(env.has('FAKE_API_TOKEN')).toBe(false);
    expect(env.has('NEXUS_AGENT_HOME')).toBe(false);
    expect({
      GIT_CONFIG_COUNT: env.get('GIT_CONFIG_COUNT'),
      GIT_TERMINAL_PROMPT: env.get('GIT_TERMINAL_PROMPT'),
      GIT_OPTIONAL_LOCKS: env.get('GIT_OPTIONAL_LOCKS'),
      LC_ALL: env.get('LC_ALL'),
    }).toEqual({
      GIT_CONFIG_COUNT: '0',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      LC_ALL: 'C',
    });
  });
});

describe('GitRunner', () => {
  it('非零結束碼是結果不是例外；stdin 送得進去', async () => {
    const dir = await directory();
    const runner = new GitRunner(await script(dir, 'git', 'cat; echo oops >&2; exit 3'), LIMITS);
    expect(await runner.run([], { cwd: dir, stdin: 'in\0', signal })).toEqual({
      exitCode: 3,
      stdout: 'in\0',
      stderr: 'oops\n',
      truncated: false,
    });
  });

  it('stdout 超過上限：留尾端、標 truncated', async () => {
    const dir = await directory();
    const runner = new GitRunner(await script(dir, 'git', 'printf 0123456789abcdef'), LIMITS);
    expect(await runner.run([], { cwd: dir, maxBytes: 6, signal })).toMatchObject({
      stdout: 'abcdef',
      truncated: true,
    });
  });

  it('逾時與中止都拋，子行程被收掉', async () => {
    const dir = await directory();
    const executable = await script(dir, 'git', 'exec sleep 30');
    const slow = new GitRunner(executable, { ...LIMITS, timeoutMs: 100 });
    const started = Date.now();
    await expect(slow.run(['status'], { cwd: dir, signal })).rejects.toThrow(
      'git status timed out after 100ms',
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    const controller = new AbortController();
    const running = new GitRunner(executable, LIMITS).run(['add'], {
      cwd: dir,
      signal: controller.signal,
    });
    controller.abort();
    await expect(running).rejects.toThrow('git add was aborted');
  });

  it('spawn 不起來就拋', async () => {
    const dir = await directory();
    await expect(
      new GitRunner(join(dir, 'missing'), LIMITS).run([], { cwd: dir, signal }),
    ).rejects.toThrow('ENOENT');
  });
});

describe('resolveGitExecutable', () => {
  it('在 PATH 裡找第一個可執行的 git；不能執行的、相對路徑的目錄跳過', async () => {
    const first = await directory();
    const second = await directory();
    await writeFile(join(first, 'git'), 'not executable');
    const executable = await script(second, 'git', 'exit 0');
    const path = ['relative/bin', first, second].join(':');
    expect(await resolveGitExecutable({ path, platform: 'linux' })).toBe(executable);
    expect(await resolveGitExecutable({ path: first, platform: 'linux' })).toBeNull();
    expect(await resolveGitExecutable({ path: '', platform: 'linux' })).toBeNull();
  });

  it.skipIf(!existsSync('/usr/bin/git'))(
    'macOS 的 `/usr/bin/git` 在開發者工具沒選好時是樁程序，當成沒有 git',
    async () => {
      const probe = (selected: boolean) => async () => selected;
      const base = { path: '/usr/bin', platform: 'darwin' as const };
      expect(
        await resolveGitExecutable({ ...base, developerToolsSelected: probe(false) }),
      ).toBeNull();
      expect(await resolveGitExecutable({ ...base, developerToolsSelected: probe(true) })).toBe(
        '/usr/bin/git',
      );
      // 別的平台不探。
      expect(
        await resolveGitExecutable({
          ...base,
          platform: 'linux',
          developerToolsSelected: probe(false),
        }),
      ).toBe('/usr/bin/git');
    },
  );
});
