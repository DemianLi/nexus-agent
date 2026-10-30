import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SandboxMode } from '@nexus/core';

import {
  createGitStarter,
  forgetGitConfigAnswers,
  gitReadRoots,
  parseConfigPaths,
} from './git-sandbox.js';
import { directToolLauncher } from './tool-process.js';
import type { ToolLauncher, ToolRequest, ToolResult } from './tool-process.js';

const GIT = '/usr/bin/git';

/** 假的 git：`config` 回 `answers`，其餘正常結束。 */
const fakeLauncher = (
  answers: Partial<Record<'--global' | '--system', string>> = {},
): { launch: ToolLauncher; requests: ToolRequest[] } => {
  const requests: ToolRequest[] = [];
  const launch: ToolLauncher = (request) => {
    requests.push(request);
    const scope = request.args[1] as '--global' | '--system';
    const output = request.args[0] === 'config' ? (answers[scope] ?? '') : '';
    const result = { kind: 'exited', code: output === '' ? 1 : 0, signal: null } as const;
    const stdout = Readable.from([Buffer.from(output)]);
    return Promise.resolve({
      pid: 1,
      stdout,
      stderr: Readable.from([]),
      kill: () => undefined,
      exited: Promise.resolve(result),
      done: new Promise<ToolResult>((resolve) => stdout.once('close', () => resolve(result))),
    });
  };
  return { launch, requests };
};

describe('parseConfigPaths', () => {
  it('取值，相對路徑以來源檔為基準，非檔案來源的相對路徑不要', () => {
    const output = [
      'file:/h/.gitconfig',
      'include.path\n/h/inc/a',
      'file:/h/inc/a',
      'core.excludesfile\nrel/ig',
      'command line:',
      'include.path\nrel',
      '',
    ].join('\0');
    expect(parseConfigPaths(output)).toEqual(['/h/inc/a', '/h/inc/rel/ig']);
  });
});

describe('gitReadRoots', () => {
  let base: string;
  let home: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    forgetGitConfigAnswers();
    base = await realpath(await mkdtemp(join(tmpdir(), 'nexus-git-roots-')));
    home = join(base, 'home');
    repo = join(base, 'repo');
    await mkdir(join(repo, '.git/objects/info'), { recursive: true });
    await mkdir(home);
    env = { HOME: home };
  });
  afterEach(() => rm(base, { recursive: true, force: true }));

  const roots = async (launch: ToolLauncher, cwd = repo): Promise<readonly string[]> => {
    const found = await gitReadRoots(launch, GIT, cwd, env);
    if (typeof found === 'string') throw new Error(found);
    return found;
  };

  it('空的 include 檔要給（EACCES 時 git 整個結束），不存在的不給（spawner 打不開就整筆失敗）', async () => {
    const empty = join(home, 'empty.inc');
    await writeFile(empty, '');
    const { launch } = fakeLauncher({
      '--global': `file:${home}/.gitconfig\0include.path\n${empty}\0file:${home}/.gitconfig\0include.path\n${home}/gone.inc\0`,
    });
    const found = await roots(launch);
    expect(found).toContain(empty);
    expect(found).not.toContain(`${home}/gone.inc`);
  });

  it('repo 的 .git/config 指到的檔不給：只問 global 與 system', async () => {
    const secret = join(home, 'id_rsa');
    await writeFile(secret, 'k');
    await writeFile(
      join(repo, '.git/config'),
      `[include]\n\tpath = ${secret}\n[core]\n\texcludesFile = ${secret}\n`,
    );
    const { launch, requests } = fakeLauncher();
    expect(await roots(launch)).not.toContain(secret);
    expect(requests.map((request) => request.args[1])).toEqual(['--global', '--system']);
    expect(requests.every((request) => request.mode === 'danger-full-access')).toBe(true);
    expect(requests.every((request) => request.args[2] === '--includes')).toBe(true);
  });

  it('只問路徑類的鍵，不列全部設定', async () => {
    const { launch, requests } = fakeLauncher();
    await roots(launch);
    for (const { args } of requests) {
      expect(args).not.toContain('--list');
      expect(args).toContain('--get-regexp');
    }
  });

  it('同一組 HOME 加 repo 只問一次；換 repo 重問（includeIf 看工作目錄）', async () => {
    const other = join(base, 'other');
    await mkdir(join(other, '.git'), { recursive: true });
    const { launch, requests } = fakeLauncher();
    await roots(launch);
    await roots(launch);
    expect(requests).toHaveLength(2);
    await roots(launch, other);
    expect(requests).toHaveLength(4);
  });

  it('問不到（沙箱不可用）：回原因、不記答案，不帶著不完整的清單跑', async () => {
    let down = true;
    const { launch: up, requests } = fakeLauncher();
    const launch: ToolLauncher = (request) =>
      down ? Promise.resolve('sandbox-unavailable') : up(request);
    expect(await gitReadRoots(launch, GIT, repo, env)).toBe('sandbox-unavailable');
    down = false;
    await roots(launch);
    expect(requests).toHaveLength(2);
  });

  it('子目錄當工作區：repo 根與 git 目錄都給；worktree 順著 gitdir、commondir，alternates 也給', async () => {
    const main = join(base, 'main/.git');
    const worktreeDir = join(main, 'worktrees/w');
    await mkdir(worktreeDir, { recursive: true });
    await mkdir(join(main, 'objects/info'), { recursive: true });
    const shared = join(base, 'shared-objects');
    await mkdir(shared);
    await writeFile(join(main, 'objects/info/alternates'), `${shared}\n`);
    await writeFile(join(worktreeDir, 'commondir'), '../..\n');
    const tree = join(base, 'tree');
    await mkdir(join(tree, 'sub'), { recursive: true });
    await writeFile(join(tree, '.git'), `gitdir: ${worktreeDir}\n`);
    const found = await roots(fakeLauncher().launch, join(tree, 'sub'));
    expect(found).toEqual(expect.arrayContaining([tree, worktreeDir, main, shared]));
  });

  it('repo 根包住 $HOME：不給 repo 根', async () => {
    env = { HOME: join(repo, 'home') };
    await mkdir(join(repo, 'home'));
    const found = await roots(fakeLauncher().launch, join(repo, 'home'));
    expect(found).not.toContain(repo);
    expect(found).not.toContain(join(repo, 'home'));
    expect(found).toContain(join(repo, '.git'));
  });

  it('工作目錄就是包住 $HOME 的 repo 根：快照走的是這條，也不給', async () => {
    env = { HOME: join(repo, 'home') };
    await mkdir(join(repo, 'home'));
    const found = await roots(fakeLauncher().launch, repo);
    expect(found).not.toContain(repo);
    expect(found).toContain(join(repo, '.git'));
  });

  it('沒有 HOME 也沒有 XDG：不問 --global', async () => {
    env = {};
    const { launch, requests } = fakeLauncher();
    await roots(launch);
    expect(requests.map((request) => request.args[1])).toEqual(['--system']);
  });
});

describe('createGitStarter', () => {
  const start = { executable: GIT, args: ['status'], cwd: tmpdir(), env: {}, writable: ['/p'] };

  beforeEach(forgetGitConfigAnswers);

  it('每次讀當下的模式：全權不上 Landlock；其餘含 read-only 一律 workspace-write 加私有寫根', async () => {
    let mode: SandboxMode = 'read-only';
    const { launch, requests } = fakeLauncher();
    const starter = createGitStarter(
      () => mode,
      () => launch,
    );
    await starter(start);
    expect(requests.at(-1)).toMatchObject({ mode: 'workspace-write', writable: ['/p'] });
    mode = 'danger-full-access';
    const before = requests.length;
    await starter(start);
    expect(requests).toHaveLength(before + 1);
    expect(requests.at(-1)).toMatchObject({
      mode: 'danger-full-access',
      readable: [],
      writable: [],
    });
  });

  it('stdin 帶到工具接縫', async () => {
    const { launch, requests } = fakeLauncher();
    await createGitStarter(
      () => 'danger-full-access',
      () => launch,
    )({ ...start, stdin: 'a\0' });
    expect(requests.at(-1)?.stdin).toBe('a\0');
  });

  it('沒有沙箱後端時 workspace-write 回 sandbox-unavailable，不退回直接 spawn', async () => {
    const reported = vi.fn();
    const launch: ToolLauncher = (request) =>
      request.mode === 'danger-full-access'
        ? directToolLauncher(request)
        : Promise.resolve('sandbox-unavailable');
    const starter = createGitStarter(
      () => 'workspace-write',
      () => launch,
      reported,
    );
    expect(await starter(start)).toBe('sandbox-unavailable');
    expect(await starter(start)).toBe('sandbox-unavailable');
    expect(reported).toHaveBeenCalledTimes(1);
  });
});
