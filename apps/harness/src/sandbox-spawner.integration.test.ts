/**
 * 真的 spawner 加真的 rg（#1946）：走 `ContainedFilesystemBackend` 的搜尋，驗沙箱裡的結果跟直接 spawn 一樣、擋得住該擋的、spawner
 * 掛了接得回來。只在 Linux 跑，`NEXUS_SPAWNER_BIN` 指到執行檔；CI 的 `sandbox-spawner` job 會設，沒設就跳過。
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ContainedFilesystemBackend } from './contained-backend.js';
import type { SandboxMode } from './contained-backend.js';
import { resolveRgPath } from './rg-path.js';
import { ripgrepReadRoots } from './ripgrep-sandbox.js';
import { SpawnerSupervisor } from './sandbox-spawner-client.js';
import { signalPid } from './test-pids.fixture.js';
import { directToolLauncher } from './tool-process.js';
import type { ToolLauncher, ToolRequest } from './tool-process.js';

const BINARY = process.env.NEXUS_SPAWNER_BIN;
const NEEDLE = 'needle';

describe.skipIf(BINARY === undefined)('真的 spawner 跑 rg', () => {
  const logs: string[] = [];
  const supervisor = new SpawnerSupervisor({
    binary: BINARY ?? '',
    log: (line) => logs.push(line),
    backoff: { initialDelayMs: 50, maxDelayMs: 1_000, maxAttempts: 10 },
  });
  let base: string;
  let repo: string;
  let ws: string;

  const put = (path: string, text = `${NEEDLE}\n`): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  const backend = (
    launcher: ToolLauncher = supervisor.launch,
    mode: SandboxMode = 'workspace-write',
    rootDir = ws,
  ): ContainedFilesystemBackend =>
    new ContainedFilesystemBackend({ rootDir, mode, ripgrep: { launcher } });
  const found = async (target: ContainedFilesystemBackend): Promise<string[]> => {
    const result = await target.grep(NEEDLE, '/');
    expect(result.error).toBeUndefined();
    return (result.matches ?? []).map((match) => match.path).sort();
  };

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'nexus-spawner-it-')));
    repo = join(base, 'repo');
    ws = join(repo, 'sub');
    mkdirSync(ws, { recursive: true });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('各處的忽略規則在沙箱裡照樣生效：結果跟直接 spawn 一字不差', async () => {
    const home = homedir();
    put(join(repo, '.git/HEAD'), 'ref: refs/heads/main\n');
    put(join(repo, '.git/info/exclude'), 'by-exclude.txt\n');
    put(join(repo, '.gitignore'), 'by-gitignore.txt\n');
    put(join(repo, '.ignore'), 'by-ignore.txt\n');
    put(join(repo, '.rgignore'), 'by-rgignore.txt\n');
    put(join(home, '.gitconfig'), `[core]\n\texcludesFile = ${join(home, 'global')}\n`);
    put(join(home, 'global'), 'by-global.txt\n');
    for (const name of [
      'plain.txt',
      'by-exclude.txt',
      'by-gitignore.txt',
      'by-ignore.txt',
      'by-rgignore.txt',
      'by-global.txt',
    ]) {
      put(join(ws, name));
    }
    const sandboxed = await found(backend());
    expect(sandboxed).toEqual(await found(backend(directToolLauncher)));
    expect(sandboxed).toEqual(['/plain.txt']);
  });

  it('glob 也走得通', async () => {
    put(join(ws, 'a.txt'));
    const result = await backend().glob('*.txt', '/');
    expect(result.error).toBeUndefined();
    expect(result.files?.map((file) => file.path)).toEqual(['/a.txt']);
  });

  it('讀不到 serve 的 home：連明指路徑都被 Landlock 擋下', async () => {
    const secret = join(homedir(), '.nexus-agent/.env');
    put(secret, `NVIDIA_API_KEY=${NEEDLE}\n`);
    put(join(ws, 'a.txt'));
    const rg = await resolveRgPath();
    const started = await supervisor.launch({
      executable: rg,
      args: ['--no-config', NEEDLE, secret],
      cwd: ws,
      mode: 'read-only',
      readable: await ripgrepReadRoots(ws, rg, { HOME: homedir() }),
      writable: [],
      env: {},
    });
    if (typeof started === 'string') throw new Error(started);
    let out = '';
    let err = '';
    started.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    started.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    expect(await started.done).toMatchObject({ kind: 'exited', code: 2 });
    expect(out).toBe('');
    expect(err).toContain('Permission denied');
  });

  it('全權模式：讀得到外面', async () => {
    put(join(base, 'outside.txt'));
    const rg = await resolveRgPath();
    const started = await supervisor.launch({
      executable: rg,
      args: ['--no-config', '-l', NEEDLE, join(base, 'outside.txt')],
      cwd: ws,
      mode: 'danger-full-access',
      readable: [],
      writable: [],
      env: {},
    });
    if (typeof started === 'string') throw new Error(started);
    started.stdout.resume();
    started.stderr.resume();
    expect(await started.done).toMatchObject({ kind: 'exited', code: 0 });
  });

  it.skipIf(process.getuid?.() === 0)(
    '起點讀不到：兩條路同一句，不說成沙箱不可用（#1945）',
    async () => {
      chmodSync(ws, 0o000);
      try {
        // backend 的起點檢查會先擋掉讀不到的根，所以根留在外層，到 launcher 才換成讀不到的起點。
        const request = async (launcher: ToolLauncher): Promise<string | undefined> => {
          const wrapped: ToolLauncher = (req: ToolRequest) => launcher({ ...req, cwd: ws });
          return (await backend(wrapped, 'workspace-write', repo).grep(NEEDLE, '/')).error;
        };
        const viaSpawner = await request(supervisor.launch);
        expect(viaSpawner).toContain('the search directory is not accessible');
        expect(viaSpawner).toBe(await request(directToolLauncher));
      } finally {
        chmodSync(ws, 0o755);
      }
    },
  );

  it('執行檔不在：說 rg 找不到', async () => {
    const target = new ContainedFilesystemBackend({
      rootDir: ws,
      mode: 'workspace-write',
      ripgrep: {
        launcher: (request) => supervisor.launch({ ...request, readable: [ws] }),
        executable: join(ws, 'no-such-rg'),
      },
    });
    expect((await target.grep(NEEDLE, '/')).error).toContain('bundled ripgrep not found');
  });

  it('spawner 被殺：跑到一半的搜尋結束、不會掛住，退避之後下一次搜尋成功', async () => {
    put(join(ws, 'a.txt'));
    await found(backend());
    const children = readdirSync('/proc').filter((name) => /^\d+$/u.test(name));
    const spawner = children.find((pid) => {
      try {
        return (
          readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('--listen') &&
          readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[3] === String(process.pid)
        );
      } catch {
        return false;
      }
    });
    expect(spawner).toBeDefined();
    const started = await supervisor.launch({
      executable: execFileSync('sh', ['-c', 'command -v sleep']).toString().trim(),
      args: ['30'],
      cwd: ws,
      mode: 'danger-full-access',
      readable: [],
      writable: [],
      env: {},
    });
    if (typeof started === 'string') throw new Error(started);
    signalPid(Number(spawner), 'SIGKILL');
    expect(await started.done).toEqual({ kind: 'failed', reason: 'sandbox-unavailable' });
    await expect
      .poll(() => found(backend()).catch(() => []), { timeout: 5_000 })
      .toEqual(['/a.txt']);
    expect(logs.join('\n')).toContain('後重起');
  });
});
