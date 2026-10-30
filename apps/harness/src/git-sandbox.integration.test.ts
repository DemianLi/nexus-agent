/**
 * 真的 spawner 加真的 git（#1946）：快照走 `createGitStarter`，驗 repo 不被寫、全域設定照讀、repo 帶進來的指令也在沙箱裡。
 * 只在 Linux 跑，`NEXUS_SPAWNER_BIN` 指到執行檔；CI 的 `sandbox-spawner` job 會設，沒設就跳過。
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  diffTrees,
  GitRunner,
  ignoredPaths,
  locateGitWorkspace,
  snapshotTree,
} from '@nexus/plugin-workspace-changes/src/git.js';

import { createGitStarter, forgetGitConfigAnswers } from './git-sandbox.js';
import { SpawnerSupervisor } from './sandbox-spawner-client.js';

const BINARY = process.env.NEXUS_SPAWNER_BIN;
const GIT = '/usr/bin/git';
const LIMITS = { timeoutMs: 20_000, outputMaxBytes: 1 << 20 };

describe.skipIf(BINARY === undefined)('真的 spawner 跑 git', () => {
  const supervisor = new SpawnerSupervisor({
    binary: BINARY ?? '',
    log: () => undefined,
  });
  const home = { value: '' };
  let base: string;
  let repo: string;
  let scratch: string;

  const shell = (args: string[], cwd = repo): void => {
    execFileSync(GIT, args, { cwd, stdio: 'ignore', env: { ...process.env, HOME: home.value } });
  };
  const runner = (mode: 'read-only' | 'danger-full-access' = 'read-only'): GitRunner =>
    new GitRunner(
      GIT,
      LIMITS,
      createGitStarter(
        () => mode,
        () => supervisor.launch,
      ),
    );
  const locate = async (git: GitRunner, cwd = repo) => {
    const signal = new AbortController().signal;
    const workspace = await locateGitWorkspace(git, cwd, () => Promise.resolve(scratch), signal);
    if (workspace === null) throw new Error('沒找到 repo');
    return { workspace, signal };
  };

  beforeEach(() => {
    forgetGitConfigAnswers();
    // 全域設定要從 serve 的環境進 git：`test-home.setup.ts` 每條測試換一個 HOME，就寫在那裡。
    home.value = realpathSync(process.env.HOME ?? '');
    base = realpathSync(mkdtempSync(join(tmpdir(), 'nexus-git-it-')));
    repo = join(base, 'repo');
    scratch = join(base, 'scratch');
    mkdirSync(repo);
    mkdirSync(scratch);
    writeFileSync(join(home.value, '.gitconfig'), '[user]\n\tname = t\n\temail = t@t\n');
    shell(['init', '-q', '.']);
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    shell(['add', '.']);
    shell(['commit', '-qm', 'x']);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('快照與比較走得通，repo 的物件庫一筆都不多', async () => {
    const git = runner();
    const { workspace, signal } = await locate(git);
    const objects = (): string[] => readdirSync(join(repo, '.git/objects')).sort();
    const before = objects();
    const first = await snapshotTree(git, workspace, signal);
    writeFileSync(join(repo, 'a.txt'), 'b\n');
    writeFileSync(join(repo, 'new.txt'), 'n\n');
    const second = await snapshotTree(git, workspace, signal);
    const changed = await diffTrees(git, workspace, first, second, signal);
    expect(changed.map((entry) => entry.path).sort()).toEqual(['a.txt', 'new.txt']);
    expect(objects()).toEqual(before);
  });

  it('stdin 送得到：check-ignore', async () => {
    writeFileSync(join(repo, '.gitignore'), 'skip.txt\n');
    const git = runner();
    const { workspace, signal } = await locate(git);
    const ignored = await ignoredPaths(git, workspace, ['skip.txt', 'a.txt'], signal);
    expect([...ignored]).toEqual(['skip.txt']);
  });

  it('全域設定照讀：include（含空檔、includeIf）與 excludesFile，全域忽略的檔不進快照', async () => {
    const inc = join(home.value, 'inc');
    mkdirSync(inc, { recursive: true });
    writeFileSync(join(inc, 'empty.inc'), '');
    writeFileSync(join(inc, 'keys.inc'), '[core]\n\texcludesFile = ~/inc/ignore\n');
    writeFileSync(join(inc, 'if.inc'), '[a]\n\tb = 1\n');
    writeFileSync(join(inc, 'ignore'), 'secret.env\n');
    writeFileSync(
      join(home.value, '.gitconfig'),
      `[user]\n\tname = t\n\temail = t@t\n[include]\n\tpath = ~/inc/empty.inc\n\tpath = inc/keys.inc\n` +
        `[includeIf "gitdir:${repo}/"]\n\tpath = ~/inc/if.inc\n`,
    );
    writeFileSync(join(repo, 'secret.env'), 'x\n');
    const git = runner();
    const { workspace, signal } = await locate(git);
    const first = await snapshotTree(git, workspace, signal);
    writeFileSync(join(repo, 'a.txt'), 'b\n');
    const second = await snapshotTree(git, workspace, signal);
    const changed = await diffTrees(git, workspace, first, second, signal);
    expect(changed.map((entry) => entry.path)).toEqual(['a.txt']);
    const listed = await git.run(['ls-tree', '-r', '--name-only', second], {
      cwd: repo,
      writable: [scratch],
      env: workspace.env,
      signal,
    });
    expect(listed.stdout.trim().split('\n')).toEqual(['a.txt']);
  });

  it('repo 帶進來的指令也在沙箱裡：讀不到 home 的秘密檔，寫不進工作區', async () => {
    const secret = join(home.value, 'secret');
    writeFileSync(secret, 'token\n');
    const marker = join(repo, 'marker');
    writeFileSync(
      join(repo, '.git/config'),
      `[include]\n\tpath = ${secret}.none\n[alias]\n\tleak = !cat ${secret}\n\tmark = !touch ${marker}\n`,
    );
    const git = runner();
    const { signal } = await locate(git);
    const leak = await git.run(['leak'], { cwd: repo, signal });
    expect(leak.stdout).not.toContain('token');
    expect(leak.stderr).toContain('Permission denied');
    const mark = await git.run(['mark'], { cwd: repo, signal });
    expect(mark.exitCode).not.toBe(0);
  });

  it('repo 的 .git/config 開不了讀權：include 指到 home 的檔，git 在沙箱裡起不來', async () => {
    const secret = join(home.value, 'other.inc');
    writeFileSync(secret, '[a]\n\tb = 1\n');
    chmodSync(secret, 0o644);
    writeFileSync(join(repo, '.git/config'), `[include]\n\tpath = ${secret}\n`);
    const git = runner();
    const signal = new AbortController().signal;
    const found = await git.run(['rev-parse', '--show-toplevel'], { cwd: repo, signal });
    expect(found.exitCode).toBe(128);
    expect(found.stderr).toContain('unable to access');
  });

  it('`core.fsmonitor` 指到 repo 帶的腳本：照樣關在沙箱裡', async () => {
    const secret = join(home.value, 'secret');
    writeFileSync(secret, 'token\n');
    const script = join(repo, 'monitor.sh');
    writeFileSync(
      script,
      `#!/bin/sh\ncp ${secret} ${join(scratch, 'stolen')}\ntouch ${join(repo, 'marker')}\n`,
    );
    chmodSync(script, 0o755);
    writeFileSync(join(repo, '.git/config'), `[core]\n\tfsmonitor = ${script}\n`);
    const git = runner();
    const { workspace, signal } = await locate(git);
    await snapshotTree(git, workspace, signal);
    expect(existsSync(join(scratch, 'stolen'))).toBe(false);
    expect(existsSync(join(repo, 'marker'))).toBe(false);
    await snapshotTree(runner('danger-full-access'), workspace, signal);
    expect(existsSync(join(scratch, 'stolen'))).toBe(true);
  });

  it('全權模式讀得到外面', async () => {
    const secret = join(home.value, 'secret');
    writeFileSync(secret, 'token\n');
    writeFileSync(join(repo, '.git/config'), `[alias]\n\tleak = !cat ${secret}\n`);
    const git = runner('danger-full-access');
    const leak = await git.run(['leak'], { cwd: repo, signal: new AbortController().signal });
    expect(leak.stdout).toContain('token');
  });

  it('子目錄當工作區：repo 找得到', async () => {
    const sub = join(repo, 'sub');
    mkdirSync(sub);
    const git = runner();
    const { workspace } = await locate(git, sub);
    expect(workspace.root).toBe(repo);
  });

  it('後代脫離行程群組還抓著 stdout：逾時之內結算，不等它', async () => {
    writeFileSync(
      join(repo, '.git/config'),
      "[alias]\n\tbg = !setsid sh -c 'sleep 30' & sleep 0.2\n",
    );
    const git = runner();
    const started = Date.now();
    const result = await git.run(['bg'], { cwd: repo, signal: new AbortController().signal });
    expect(result.exitCode).toBe(0);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(1_500);
    expect(elapsed).toBeLessThan(10_000);
  });
});
