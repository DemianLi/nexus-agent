/**
 * `grep` 自己起 rg（[#1532](https://github.com/DemianLi/nexus-agent/issues/1532)）：`--no-config`、輸出上限、取消與逾時、
 * 失敗不換結果、內附 rg 找不到也沒有退路、根不存在不是 rg 的錯，以及掛進真的組裝之後這些都還在。
 *
 * 基座的做法有四個洞，每一條都對著其中一個：`RIPGREP_CONFIG_PATH` 能讓 rg 執行任意程式或濾掉結果；stdout 不設上限；
 * 按停止沒用；失敗改走結果不同的 `literalSearch`。`contained-backend-grep.test.ts` 管 glob 的錨點，這一份管子行程。
 *
 * **用的是內附 rg**（[#1502](https://github.com/DemianLi/nexus-agent/issues/1502) 刀 4，`rg-path.ts`），不是 `PATH` 上的：
 * 每一條 `beforeEach` 先確認內附的在，不在就紅，不跳過——跳過會讓這份防線在壞掉的產物上靜靜消失。
 */

import { ChildProcess, spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { FilesystemBackend } from 'deepagents';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseMessage } from '@langchain/core/messages';
import { ToolMessage } from '@langchain/core/messages';
import {
  SEARCH_ABORTED,
  SEARCH_FAILED,
  SEARCH_INVALID_PATTERN,
  SEARCH_RAW_OUTPUT_OVERFLOW,
} from '@nexus/core';
import type { SessionEvent } from '@nexus/core';

import { createCliAgent } from './assembly-root.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { shippedPlugins, withScriptedModel } from './fixtures.js';
import { toAgentInvocation } from './messages.js';
import { ripgrepStatus } from './rg-path.js';
import { runRipgrep } from './ripgrep-runner.js';
import { isAlive, readPidFile } from './test-pids.fixture.js';

// 包一層讓個別測試能換掉解析結果（abort 接線、解析不到）；預設原樣呼叫真的。
vi.mock('./rg-path.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./rg-path.js')>();
  return { ...actual, resolveRgPath: vi.fn(actual.resolveRgPath) };
});
const { resolveRgPath } = await import('./rg-path.js');
const realResolveRgPath = (await vi.importActual<typeof import('./rg-path.js')>('./rg-path.js'))
  .resolveRgPath;

const shipped = await shippedPlugins();

let base: string;
let root: string;
/** 內附 rg 的絕對路徑。 */
let rg: string;
const originalEnv = { path: process.env['PATH'], config: process.env['RIPGREP_CONFIG_PATH'] };

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'nexus-rg-'));
  root = join(base, 'ws');
  await mkdir(root);
  await writeFile(join(root, 'a.log'), 'needle 一\nplain\nneedle 二\n');
  await writeFile(join(root, 'notes.txt'), 'needle 在 txt 裡\n');
  vi.mocked(resolveRgPath).mockImplementation(realResolveRgPath);
  const status = await ripgrepStatus();
  if (status.kind !== 'bundled') throw new Error(`內附 rg 不可用：${status.reason}`);
  rg = status.path;
});

afterEach(async () => {
  if (originalEnv.path === undefined) delete process.env['PATH'];
  else process.env['PATH'] = originalEnv.path;
  if (originalEnv.config === undefined) delete process.env['RIPGREP_CONFIG_PATH'];
  else process.env['RIPGREP_CONFIG_PATH'] = originalEnv.config;
  vi.restoreAllMocks();
  await rm(base, { recursive: true, force: true });
});

const paths = (result: { matches?: Array<{ path: string }> }): string[] =>
  [...new Set((result.matches ?? []).map((match) => match.path))].sort();

/** 一個可執行的腳本。 */
async function script(name: string, body: string): Promise<string> {
  const file = join(base, name);
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

/** 行程還活著嗎（`kill 0` 對已回收的行程丟 `ESRCH`）。pid 不合法時丟錯（#1712）。 */
const alive = isAlive;

/** 寫一份 `RIPGREP_CONFIG_PATH` 指向的設定檔並設進行程環境。 */
async function configWith(lines: string[]): Promise<void> {
  const file = join(base, 'rgrc');
  await writeFile(file, `${lines.join('\n')}\n`);
  process.env['RIPGREP_CONFIG_PATH'] = file;
}

/** 讓 rg 對每個命中的檔先跑它、並留下標記檔的 `--pre` 腳本。 */
async function markerPre(): Promise<{ marker: string }> {
  const marker = join(base, 'PRE-RAN');
  const pre = await script('pre.sh', `: > "${marker}"\ncat "$1"`);
  await configWith([`--pre=${pre}`]);
  return { marker };
}

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

describe('`--no-config`：宿主的 RIPGREP_CONFIG_PATH 影響不到我們起的 rg', () => {
  /** 對照：沒有 `--no-config` 的 rg 真的會吃這份設定，所以下面兩條的斷言不是白綠。 */
  it('對照：直接起 rg（不帶 --no-config）會執行 --pre 腳本', async () => {
    const { marker } = await markerPre();
    spawnSync(rg, ['-F', 'needle', root], { env: process.env });
    expect(await exists(marker)).toBe(true);
  });

  it('設定裡的 --pre 不會被執行，而且照樣有命中', async () => {
    const { marker } = await markerPre();

    const result = await new ContainedFilesystemBackend({ rootDir: root }).grep('needle', '/');

    expect(result.error).toBeUndefined();
    expect(paths(result)).toEqual(['/a.log', '/notes.txt']);
    expect(await exists(marker)).toBe(false);
  });

  it('設定裡的 --glob=!*.txt 濾不掉 .txt 的命中', async () => {
    await configWith(['--glob=!*.txt']);

    const result = await new ContainedFilesystemBackend({ rootDir: root }).grep('needle', '/');

    expect(paths(result)).toEqual(['/a.log', '/notes.txt']);
  });
});

describe('虛擬路徑的形狀', () => {
  /** rg 的輸出路徑是相對於 `cwd` 的（`./a.log`、`sub/a.log`）；換算成虛擬路徑不能留下 `./`。 */
  it('搜尋根與子目錄：路徑都是乾淨的 `/…`，沒有 `./`', async () => {
    await mkdir(join(root, 'sub'));
    await writeFile(join(root, 'sub', 'deep.log'), 'needle 深\n');
    const backend = new ContainedFilesystemBackend({ rootDir: root });

    const all = await backend.grep('needle', '/');
    const sub = await backend.grep('needle', '/sub');

    expect(paths(all)).toEqual(['/a.log', '/notes.txt', '/sub/deep.log']);
    expect(paths(sub)).toEqual(['/sub/deep.log']);
    for (const match of [...(all.matches ?? []), ...(sub.matches ?? [])]) {
      expect(match.path).not.toContain('/./');
      expect(match.path).toMatch(/^\/[^.]/);
    }
  });

  /**
   * 搜尋起點傳相對於根的路徑（不是絕對路徑）：rg 的錨點是它自己 `getcwd()` 的 realpath，根經 symlink 進來時，
   * 傳絕對路徑會讓帶目錄的 `--glob` 一個都對不上。**根特地建在 realpath 的暫存目錄底下再用 symlink 指過去**，
   * 不靠 macOS 的 `/var` 剛好是 symlink：改傳絕對路徑的突變在任何平台都會紅。
   */
  it('根是 symlink 時，帶目錄的 glob 仍對根錨定、命中', async () => {
    const real = join(await realpath(await mkdtemp(join(tmpdir(), 'nexus-rg-real-'))), 'real');
    await mkdir(join(real, 'logs'), { recursive: true });
    await writeFile(join(real, 'logs', 'app.log'), 'needle 在 symlink 根\n');
    const link = join(base, 'ws-link');
    await symlink(real, link);
    try {
      const backend = new ContainedFilesystemBackend({ rootDir: link });

      const viaGlob = await backend.grep('needle', '/', 'logs/app.log');
      const viaSub = await backend.grep('needle', '/logs', 'logs/*.log');

      expect(viaGlob.error).toBeUndefined();
      expect(paths(viaGlob)).toEqual(['/logs/app.log']);
      expect(paths(viaSub)).toEqual(['/logs/app.log']);
    } finally {
      await rm(join(real, '..'), { recursive: true, force: true });
    }
  });

  it('目錄名是 `-` 或像旗標（`-x`）：照常搜，不是讀 stdin、不是 0 筆', async () => {
    for (const name of ['-', '-x']) {
      await mkdir(join(root, name));
      await writeFile(join(root, name, 'f.log'), 'needle 旗標目錄\n');
    }
    const backend = new ContainedFilesystemBackend({ rootDir: root });

    expect(paths(await backend.grep('needle', '/-'))).toEqual(['/-/f.log']);
    expect(paths(await backend.grep('needle', '/-x'))).toEqual(['/-x/f.log']);
  });
});

describe('子行程的環境', () => {
  it('名字像憑證的與 NEXUS_ 開頭的不交給 rg，PATH 照留', async () => {
    const dump = join(base, 'env.txt');
    const executable = await script('env-rg.sh', `env > "${dump}"\nexit 1`);
    process.env['FAKE_1532_API_KEY'] = 'secret-value';
    process.env['NEXUS_AGENT_FAKE_1532'] = 'internal';
    try {
      await runRipgrep({ argv: ['--json'], cwd: root, executable });
    } finally {
      delete process.env['FAKE_1532_API_KEY'];
      delete process.env['NEXUS_AGENT_FAKE_1532'];
    }

    const seen = await readFile(dump, 'utf8');
    expect(seen).not.toContain('FAKE_1532_API_KEY');
    expect(seen).not.toContain('NEXUS_AGENT_FAKE_1532');
    expect(seen.split('\n')).toContain(`PATH=${process.env['PATH']}`);
  });
});

describe('帶目錄的 glob 由 rg 自己對根錨定，不走基座那一支', () => {
  it('帶目錄的 glob 不經過 super.grep', async () => {
    await mkdir(join(root, 'logs'));
    await mkdir(join(root, 'nested', 'logs'), { recursive: true });
    await writeFile(join(root, 'logs', 'app.log'), 'needle 根\n');
    await writeFile(join(root, 'nested', 'logs', 'app.log'), 'needle 巢狀\n');
    const bare = vi.spyOn(FilesystemBackend.prototype, 'grep');

    const result = await new ContainedFilesystemBackend({ rootDir: root }).grep(
      'needle',
      '/',
      'logs/app.log',
    );

    expect(paths(result)).toEqual(['/logs/app.log']);
    expect(bare).not.toHaveBeenCalled();
  });
});

describe('輸出上限', () => {
  /**
   * 假 rg：先寫出超過上限的量，再掛著不結束。runner 要等 `close` 才 resolve，所以只有「超限時真的收掉 rg」才會很快回來；
   * 用真的 rg 的話它自己很快就寫完結束，拿掉超限分支的 `terminate()` 也照樣綠。
   */
  async function floodingRg(): Promise<{ executable: string; pidFile: string }> {
    const pidFile = join(base, 'flood.pid');
    const executable = await script(
      'flood-rg.sh',
      `echo $$ > "${pidFile}"\nhead -c 4096 /dev/zero | tr '\\0' x\nexec sleep 20`,
    );
    return { executable, pidFile };
  }

  it('超過上限就收掉 rg、很快回縮小範圍的錯誤，不解析半份輸出', async () => {
    const { executable, pidFile } = await floodingRg();
    const started = Date.now();

    const backend = new ContainedFilesystemBackend({
      rootDir: root,
      ripgrep: { executable, rawOutputMaxBytes: 1024 },
    });
    const result = await backend.grep('needle', '/');

    expect(Date.now() - started).toBeLessThan(3500);
    expect(result.matches).toBeUndefined();
    expect(result.error).toContain('narrow');
    expect(result.error).toContain('1024');
    expect(alive(await readPidFile(pidFile))).toBe(false);
  }, 15_000);

  it('runner 的碼是 SEARCH_RAW_OUTPUT_OVERFLOW', async () => {
    const { executable } = await floodingRg();
    const outcome = await runRipgrep({
      argv: ['--json'],
      cwd: root,
      executable,
      internals: { rawOutputMaxBytes: 1024 },
    });
    expect(outcome).toMatchObject({ kind: 'error', code: SEARCH_RAW_OUTPUT_OVERFLOW });
  }, 15_000);

  it('反例：上限內照常回結果', async () => {
    const result = await new ContainedFilesystemBackend({ rootDir: root }).grep('needle', '/');
    expect(result.matches).toHaveLength(3);
  });
});

describe('取消與逾時', () => {
  /** 一支會卡住的「rg」：記下自己的 pid，睡 20 秒；`SIGTERM` 預設會讓它死。 */
  async function hangingRg(trapTerm = false): Promise<{ executable: string; pidFile: string }> {
    const pidFile = join(base, 'rg.pid');
    const executable = await script(
      'slow-rg.sh',
      `echo $$ > "${pidFile}"\n${trapTerm ? "trap '' TERM\nwhile :; do sleep 0.1; done" : 'exec sleep 20'}`,
    );
    return { executable, pidFile };
  }

  it('先取消再呼叫：rg 不起（spawn 計數 0），回 SEARCH_ABORTED', async () => {
    const controller = new AbortController();
    controller.abort();
    let spawned = 0;

    const outcome = await runRipgrep({
      argv: ['--json', '-F', '--', 'needle', '.'],
      cwd: root,
      signal: controller.signal,
      executable: rg,
      internals: { onSpawn: () => (spawned += 1) },
    });

    expect(spawned).toBe(0);
    expect(outcome).toMatchObject({ kind: 'error', code: SEARCH_ABORTED });
  });

  it('搜尋途中取消：幾秒內收掉，行程已經不在', async () => {
    const { executable, pidFile } = await hangingRg();
    const controller = new AbortController();
    const started = Date.now();
    const pending = runRipgrep({
      argv: ['--json'],
      cwd: root,
      signal: controller.signal,
      executable,
    });
    await readPidFile(pidFile); // 內容完整才算起來（shim 的 `echo $$ >` 是先建空檔、後寫字）
    controller.abort();

    const outcome = await pending;

    expect(Date.now() - started).toBeLessThan(3500);
    expect(outcome).toMatchObject({ kind: 'error', code: SEARCH_ABORTED });
    const pid = await readPidFile(pidFile);
    expect(alive(pid)).toBe(false);
  }, 15_000);

  it('逾時也是 SEARCH_ABORTED，同樣收掉', async () => {
    const { executable, pidFile } = await hangingRg();

    const outcome = await runRipgrep({
      argv: ['--json'],
      cwd: root,
      executable,
      internals: { timeoutMs: 1500 },
    });

    expect(outcome).toMatchObject({ kind: 'error', code: SEARCH_ABORTED });
    expect(alive(await readPidFile(pidFile))).toBe(false);
  }, 15_000);

  it('SIGTERM 被忽略時，寬限之後升級成 SIGKILL', async () => {
    const { executable, pidFile } = await hangingRg(true);
    const controller = new AbortController();
    const pending = runRipgrep({
      argv: ['--json'],
      cwd: root,
      signal: controller.signal,
      executable,
      internals: { killGraceMs: 300 },
    });
    await readPidFile(pidFile); // 內容完整才算起來（shim 的 `echo $$ >` 是先建空檔、後寫字）
    controller.abort();

    const outcome = await pending;

    expect(outcome).toMatchObject({ kind: 'error', code: SEARCH_ABORTED });
    expect(alive(await readPidFile(pidFile))).toBe(false);
  }, 15_000);
});

describe('失敗不換結果', () => {
  it('讓 rg 結束碼是 2 的 glob：回 SEARCH_INVALID_PATTERN，不是基座退路的結果', async () => {
    const bare = vi.spyOn(FilesystemBackend.prototype, 'grep');

    const backend = new ContainedFilesystemBackend({ rootDir: root });
    const result = await backend.grep('needle', '/', '{');

    expect(result.matches).toBeUndefined();
    expect(result.error).toMatch(/^grep pattern rejected by ripgrep: /);
    expect(bare).not.toHaveBeenCalled();
    const outcome = await runRipgrep({
      argv: ['--json', '-F', '--glob', '{', '--', 'needle', '.'],
      cwd: root,
      executable: rg,
    });
    expect(outcome).toMatchObject({ kind: 'error', code: SEARCH_INVALID_PATTERN });
  });

  it('被訊號殺掉（不是我們收的）是 SEARCH_FAILED', async () => {
    const executable = await script('self-kill.sh', 'kill -9 $$');
    const outcome = await runRipgrep({ argv: ['--json'], cwd: root, executable });
    expect(outcome).toMatchObject({ kind: 'error', code: SEARCH_FAILED });
    expect((outcome as { message: string }).message).toContain('SIGKILL');
  });

  it('起不來（ENOENT）的同時已被取消：回取消，不是「起不來」；沒有 pid 的 child 不呼叫 kill（pid 0 = 整個行程群組）', async () => {
    // kill 換成不做事的替身：沒有 pid 守衛時它會被呼叫（而且真的會殺掉整個行程群組，連測試行程一起），
    // 換掉之後守衛拿掉只會紅，不會殺人。
    const kill = vi.spyOn(ChildProcess.prototype, 'kill').mockReturnValue(false);
    try {
      const controller = new AbortController();
      const outcome = await runRipgrep({
        argv: ['--json'],
        cwd: root,
        executable: join(base, 'no-such-rg'),
        signal: controller.signal,
        internals: { onSpawn: () => controller.abort() },
      });
      expect(outcome).toMatchObject({ kind: 'error', code: SEARCH_ABORTED });
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it('spawn 同步丟（執行檔路徑含 NUL）：SEARCH_FAILED，訊息固定、不含路徑', async () => {
    const executable = join(base, 'rg\0x');
    const outcome = await runRipgrep({ argv: ['--json'], cwd: root, executable });
    expect(outcome).toEqual({
      kind: 'error',
      code: SEARCH_FAILED,
      message: 'grep could not start its search command (ripgrep launch failed)',
    });
  });

  it('非 ENOENT 的起不來（沒有執行權限）是 SEARCH_FAILED，不走退路', async () => {
    const file = join(base, 'not-executable');
    await writeFile(file, '#!/bin/sh\n');
    const bare = vi.spyOn(FilesystemBackend.prototype, 'grep');

    const result = await new ContainedFilesystemBackend({
      rootDir: root,
      ripgrep: { executable: file },
    }).grep('needle', '/');

    expect(result.error).toBe('grep could not start its search command (ripgrep launch failed)');
    // 訊息不含主機路徑（模型看得到工具結果）：Node 的 spawn 錯誤原文帶執行檔路徑，不能接在後面。
    expect(result.error).not.toContain(base);
    expect(result.error).not.toContain('EACCES');
    expect(bare).not.toHaveBeenCalled();
  });
});

describe('grep 真的用內附的那一支（#1502 刀 4 的條件）', () => {
  it('實際 spawn 的執行檔是 node_modules/@vscode/ripgrep-<平台>-<arch>/ 底下的 rg，不是 PATH 上的', async () => {
    let used: string | undefined;

    const result = await new ContainedFilesystemBackend({
      rootDir: root,
      ripgrep: { onSpawn: (_argv, executable) => (used = executable) },
    }).grep('needle', '/');

    expect(paths(result)).toEqual(['/a.log', '/notes.txt']);
    expect(used).toBe(await resolveRgPath());
    const platformPackage = `@vscode/ripgrep-${process.platform}-${process.arch}`;
    expect((used ?? '').split(sep).join('/')).toMatch(
      new RegExp(`/node_modules/${platformPackage}/bin/rg(\\.exe)?$`),
    );
  });
});

describe('內附 rg 找不到：沒有退路（#1502 刀 4 拿掉了 #1532 的 ENOENT 退路）', () => {
  /** `PATH` 上放一支會留下標記的 `rg`：任何回頭去查 `PATH` 的實作都會被抓到。 */
  async function pathTrap(): Promise<{ marker: string }> {
    const marker = join(base, 'PATH-RG-RAN');
    const bin = join(base, 'trap-bin');
    await mkdir(bin);
    const shim = join(bin, 'rg');
    await writeFile(shim, `#!/bin/sh\n: > "${marker}"\nexit 1\n`);
    await chmod(shim, 0o755);
    process.env['PATH'] = `${bin}:${originalEnv.path ?? ''}`;
    return { marker };
  }

  it('執行檔路徑不存在（ENOENT）：SEARCH_FAILED，不交給基座、不查 PATH', async () => {
    const { marker } = await pathTrap();
    const bare = vi.spyOn(FilesystemBackend.prototype, 'grep');

    const result = await new ContainedFilesystemBackend({
      rootDir: root,
      ripgrep: { executable: join(base, 'no-such-rg') },
    }).grep('needle', '/');

    expect(result.matches).toBeUndefined();
    expect(result.error).toBe(
      'grep could not start its search command (bundled ripgrep not found)',
    );
    expect(result.error).not.toContain(base);
    expect(result.error).not.toContain('no-such-rg');
    expect(bare).not.toHaveBeenCalled();
    expect(await exists(marker)).toBe(false);
  });

  it('內附 rg 解析不到（平台套件不見了）：SEARCH_FAILED，不交給基座、不查 PATH', async () => {
    const { marker } = await pathTrap();
    const bare = vi.spyOn(FilesystemBackend.prototype, 'grep');
    vi.mocked(resolveRgPath).mockRejectedValue(new Error('Cannot find module @vscode/ripgrep-x'));

    const result = await new ContainedFilesystemBackend({ rootDir: root }).grep('needle', '/');

    expect(result.matches).toBeUndefined();
    expect(result.error).toBe(
      'grep could not start its search command (bundled ripgrep unavailable)',
    );
    // `resolveRgPath` 的原始錯誤（套件名、路徑）不交給模型。
    expect(result.error).not.toContain('Cannot find module');
    expect(result.error).not.toContain('@vscode');
    expect(bare).not.toHaveBeenCalled();
    expect(await exists(marker)).toBe(false);
  });

  it('反例：內附 rg 在時，PATH 上的 rg 不會被起來——命中來自內附那一支', async () => {
    const { marker } = await pathTrap();

    const result = await new ContainedFilesystemBackend({ rootDir: root }).grep('needle', '/');

    expect(paths(result)).toEqual(['/a.log', '/notes.txt']);
    expect(await exists(marker)).toBe(false);
  });

  it('工作區根不存在：沒有東西可找（matches 為空），不是 rg 的錯', async () => {
    const bare = vi.spyOn(FilesystemBackend.prototype, 'grep');
    let spawned = 0;

    const result = await new ContainedFilesystemBackend({
      rootDir: join(base, 'gone'),
      ripgrep: { onSpawn: () => (spawned += 1) },
    }).grep('needle', '/');

    expect(result).toEqual({ matches: [] });
    expect(spawned).toBe(0);
    expect(bare).not.toHaveBeenCalled();
  });

  it('工作區根不是目錄：回錯誤', async () => {
    const bare = vi.spyOn(FilesystemBackend.prototype, 'grep');
    const file = join(base, 'a-file');
    await writeFile(file, 'needle\n');

    const result = await new ContainedFilesystemBackend({ rootDir: file }).grep('needle', '/');

    expect(result.error).toContain('workspace root');
    expect(result.error).not.toContain(base);
    expect(bare).not.toHaveBeenCalled();
  });
});

describe('掛進真的組裝之後', () => {
  /** 依序跑腳本，回模型拿到的工具訊息與 root 那份日誌的 `tool/result`。 */
  async function runAgent(
    turns: Array<{ name: string; args: Record<string, unknown> }>,
    config: { signal?: AbortSignal } = {},
  ): Promise<{ messages: ToolMessage[]; results: Array<Record<string, unknown>> }> {
    const built = await createCliAgent(
      { live: false, workspace: root },
      withScriptedModel(shipped, [
        ...turns.map((call) => ({ content: '', toolCalls: [call] })),
        { content: '收工。' },
      ]),
      root,
    );
    const detach = built.attachSession(built.sessions);
    let state: { messages: BaseMessage[] } = { messages: [] };
    try {
      state = (await built.agent
        .invoke(toAgentInvocation('搜尋'), {
          configurable: { thread_id: 'rg-wiring' },
          ...config,
        })
        .catch(() => state)) as { messages: BaseMessage[] };
    } finally {
      detach();
      await built.dispose();
    }
    const log = built.sessions.list().find((entry) => entry.address.kind === 'root');
    const events: readonly SessionEvent[] = log?.log.events ?? [];
    return {
      messages: state.messages.filter((m): m is ToolMessage => ToolMessage.isInstance(m)),
      results: events.flatMap((event) =>
        event.type === 'tool/result' ? [event.data as Record<string, unknown>] : [],
      ),
    };
  }

  it('經真的 grep 工具：RIPGREP_CONFIG_PATH 的 --pre 不被執行，命中照樣回給模型', async () => {
    const { marker } = await markerPre();

    const { messages } = await runAgent([
      { name: 'grep', args: { pattern: 'needle', path: '/', output_mode: 'content' } },
    ]);

    expect(await exists(marker)).toBe(false);
    expect(String(messages[0]?.content)).toContain('/a.log');
    expect(messages[0]?.status).not.toBe('error');
  }, 60_000);

  it('rg 回 2：工具結果是錯誤、模型看到 Error: 前綴、日誌上帶 SEARCH_INVALID_PATTERN', async () => {
    const { messages, results } = await runAgent([
      { name: 'grep', args: { pattern: 'needle', path: '/', glob: '{' } },
    ]);

    expect(messages[0]?.status).toBe('error');
    expect(String(messages[0]?.content)).toMatch(/^Error: grep pattern rejected by ripgrep: /);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      isError: true,
      error: { name: 'SearchError', code: SEARCH_INVALID_PATTERN },
    });
  }, 60_000);

  it('使用者中止這一輪：工具呼叫的 signal 一路送到 rg，行程被收掉', async () => {
    const pidFile = join(base, 'wired.pid');
    const shim = await script('slow-rg.sh', `echo $$ > "${pidFile}"\nexec sleep 20`);
    vi.mocked(resolveRgPath).mockResolvedValue(shim);
    const controller = new AbortController();
    const running = runAgent([{ name: 'grep', args: { pattern: 'needle', path: '/' } }], {
      signal: controller.signal,
    });
    await readPidFile(pidFile, 20_000);
    controller.abort();

    await running;

    const pid = await readPidFile(pidFile);
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5_000 });
  }, 60_000);

  it('內附 rg 解析不到：工具結果是錯誤、模型看到 Error: 前綴、日誌上帶 SEARCH_FAILED，沒有改走別的搜尋', async () => {
    vi.mocked(resolveRgPath).mockRejectedValue(new Error('Cannot find module @vscode/ripgrep-x'));

    const { messages, results } = await runAgent([
      { name: 'grep', args: { pattern: 'needle', path: '/', output_mode: 'content' } },
    ]);

    expect(messages[0]?.status).toBe('error');
    expect(String(messages[0]?.content)).toMatch(/^Error: grep could not start its search command/);
    expect(String(messages[0]?.content)).not.toContain('/a.log');
    expect(results[0]).toMatchObject({
      isError: true,
      error: { name: 'SearchError', code: SEARCH_FAILED },
    });
  }, 60_000);

  // ---- #1605 ----

  it('glob 在內附 rg 解析不到：錯誤、碼是 SEARCH_FAILED、字句指名 glob，沒有改走基座的 glob', async () => {
    vi.mocked(resolveRgPath).mockRejectedValue(new Error('Cannot find module @vscode/ripgrep-x'));
    const bare = vi.spyOn(FilesystemBackend.prototype, 'glob');

    const { messages, results } = await runAgent([{ name: 'glob', args: { pattern: '**/*' } }]);

    expect(messages[0]?.status).toBe('error');
    expect(String(messages[0]?.content)).toMatch(
      /^Error finding files: glob could not start its search command/,
    );
    expect(String(messages[0]?.content)).not.toContain('/a.log');
    expect(results[0]).toMatchObject({
      isError: true,
      error: { name: 'SearchError', code: SEARCH_FAILED },
    });
    expect(bare).not.toHaveBeenCalled();
  }, 60_000);

  it('glob 的 pattern 空白：錯誤，碼是 SEARCH_INVALID_PATTERN', async () => {
    const { messages, results } = await runAgent([{ name: 'glob', args: { pattern: '  ' } }]);

    expect(messages[0]?.status).toBe('error');
    expect(String(messages[0]?.content)).toBe(
      'Error finding files: glob pattern must be a non-empty string',
    );
    expect(results[0]).toMatchObject({
      isError: true,
      error: { name: 'SearchError', code: SEARCH_INVALID_PATTERN },
    });
  }, 60_000);

  it('glob 的 pattern 是 rg 解不開的（`{`）：碼是 SEARCH_INVALID_PATTERN，字句指名 glob', async () => {
    const { messages, results } = await runAgent([{ name: 'glob', args: { pattern: '{' } }]);

    expect(messages[0]?.status).toBe('error');
    expect(String(messages[0]?.content)).toMatch(
      /^Error finding files: glob pattern rejected by ripgrep: /,
    );
    expect(results[0]).toMatchObject({
      isError: true,
      error: { name: 'SearchError', code: SEARCH_INVALID_PATTERN },
    });
  }, 60_000);

  it.each([
    ['!*.log', 'negated'],
    ['*.log,*.txt', 'comma list'],
    ['', 'empty'],
  ])(
    'grep 的檔案篩選 %j（%s）：SEARCH_INVALID_PATTERN，rg 沒有被起',
    async (glob) => {
      const spawned = vi.fn();
      vi.mocked(resolveRgPath).mockImplementation(async () => {
        spawned();
        return realResolveRgPath();
      });

      const { messages, results } = await runAgent([
        { name: 'grep', args: { pattern: 'needle', path: '/', glob, output_mode: 'content' } },
      ]);

      expect(messages[0]?.status).toBe('error');
      expect(String(messages[0]?.content)).toMatch(/^Error: glob must be /);
      expect(results[0]).toMatchObject({
        isError: true,
        error: { name: 'SearchError', code: SEARCH_INVALID_PATTERN },
      });
      expect(spawned).not.toHaveBeenCalled();
    },
    60_000,
  );

  it('grep 的 pattern 是空字串：SEARCH_INVALID_PATTERN，rg 沒有被起（`--regexp=` 會命中每一行）', async () => {
    const spawned = vi.fn();
    vi.mocked(resolveRgPath).mockImplementation(async () => {
      spawned();
      return realResolveRgPath();
    });

    const { messages, results } = await runAgent([
      { name: 'grep', args: { pattern: '', path: '/', output_mode: 'content' } },
    ]);

    expect(messages[0]?.status).toBe('error');
    expect(String(messages[0]?.content)).toBe('Error: pattern must be a non-empty string');
    expect(results[0]).toMatchObject({
      isError: true,
      error: { name: 'SearchError', code: SEARCH_INVALID_PATTERN },
    });
    expect(spawned).not.toHaveBeenCalled();
  }, 60_000);

  it('grep 的 pattern 只有空白字元是合法的正規式（照 dsh：只擋「空」，不擋空白）', async () => {
    const { messages } = await runAgent([
      { name: 'grep', args: { pattern: ' ', path: '/a.log', output_mode: 'content' } },
    ]);

    expect(messages[0]?.status).not.toBe('error');
    expect(String(messages[0]?.content)).toContain('needle 一');
  }, 60_000);

  it('grep 的檔案篩選 `*.{log,txt}`（逗號在大括號內）照常搜尋', async () => {
    const { messages } = await runAgent([
      {
        name: 'grep',
        args: { pattern: 'needle', path: '/', glob: '*.{log,txt}', output_mode: 'content' },
      },
    ]);

    expect(messages[0]?.status).not.toBe('error');
    expect(String(messages[0]?.content)).toContain('/a.log');
    expect(String(messages[0]?.content)).toContain('/notes.txt');
  }, 60_000);

  it('grep 的 pattern 不是合法正規式（`(`）：碼是 SEARCH_INVALID_PATTERN，不是 SEARCH_FAILED', async () => {
    const { messages, results } = await runAgent([
      { name: 'grep', args: { pattern: '(', path: '/', output_mode: 'content' } },
    ]);

    expect(messages[0]?.status).toBe('error');
    expect(String(messages[0]?.content)).toMatch(/^Error: grep pattern rejected by ripgrep: /);
    expect(results[0]).toMatchObject({
      isError: true,
      error: { name: 'SearchError', code: SEARCH_INVALID_PATTERN },
    });
  }, 60_000);

  it('grep 的 pattern 是正規式：`needle 一|needle 二` 兩行都命中（`-F` 底下是 0 筆）', async () => {
    const { messages } = await runAgent([
      {
        name: 'grep',
        args: { pattern: 'needle 一|needle 二', path: '/a.log', output_mode: 'content' },
      },
    ]);

    expect(messages[0]?.status).not.toBe('error');
    expect(String(messages[0]?.content)).toContain('needle 一');
    expect(String(messages[0]?.content)).toContain('needle 二');
  }, 60_000);

  it.skipIf(process.getuid?.() === 0)('起點讀不到不說成 rg 起不來（#1945）', async () => {
    const closed = await mkdtemp(join(tmpdir(), 'nexus-rg-closed-'));
    await chmod(closed, 0o000);
    try {
      const outcome = await runRipgrep({
        argv: ['--json'],
        cwd: closed,
        executable: process.execPath,
      });
      expect(outcome).toMatchObject({
        kind: 'error',
        code: SEARCH_FAILED,
        message: 'grep could not start its search command (the search directory is not accessible)',
      });
    } finally {
      await chmod(closed, 0o700);
      await rm(closed, { recursive: true, force: true });
    }
  });
});
