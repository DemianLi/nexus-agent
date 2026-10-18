/**
 * `grep` 自己起 rg（[#1532](https://github.com/DemianLi/nexus-agent/issues/1532)）：`--no-config`、輸出上限、取消與逾時、
 * 失敗不換結果、沒有 rg 才走退路、根不存在不走退路，以及掛進真的組裝之後這些都還在。
 *
 * 基座的做法有四個洞，每一條都對著其中一個：`RIPGREP_CONFIG_PATH` 能讓 rg 執行任意程式或濾掉結果；stdout 不設上限；
 * 按停止沒用；失敗改走結果不同的 `literalSearch`。`contained-backend-grep.test.ts` 管 glob 的錨點，這一份管子行程。
 *
 * **要 rg 在 `PATH` 上**（CI 在 `ci.yml` 裝了它），沒有就紅，不跳過——跳過會讓這份防線在沒有 rg 的機器上靜靜消失。
 */

import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { runRipgrep } from './ripgrep-runner.js';

const shipped = await shippedPlugins();

let base: string;
let root: string;
const originalEnv = { path: process.env['PATH'], config: process.env['RIPGREP_CONFIG_PATH'] };

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'nexus-rg-'));
  root = join(base, 'ws');
  await mkdir(root);
  await writeFile(join(root, 'a.log'), 'needle 一\nplain\nneedle 二\n');
  await writeFile(join(root, 'notes.txt'), 'needle 在 txt 裡\n');
  expect(spawnSync('rg', ['--version']).error).toBeUndefined();
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

/** 行程還活著嗎（`kill 0` 對已回收的行程丟 `ESRCH`）。 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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
    spawnSync('rg', ['-F', 'needle', root], { env: process.env });
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
});

describe('子行程的環境', () => {
  it('名字像憑證的與 NEXUS_ 開頭的不交給 rg，PATH 照留', async () => {
    const dump = join(base, 'env.txt');
    const executable = await script('env-rg.sh', `env > "${dump}"\nexit 1`);
    process.env['FAKE_1532_API_KEY'] = 'secret-value';
    process.env['NEXUS_AGENT_FAKE_1532'] = 'internal';
    try {
      await runRipgrep({ argv: ['--json'], cwd: root, internals: { executable } });
    } finally {
      delete process.env['FAKE_1532_API_KEY'];
      delete process.env['NEXUS_AGENT_FAKE_1532'];
    }

    const seen = await readFile(dump, 'utf8');
    expect(seen).not.toContain('FAKE_1532_API_KEY');
    expect(seen).not.toContain('NEXUS_AGENT_FAKE_1532');
    expect(seen).toContain('PATH=');
  });
});

describe('輸出上限', () => {
  it('超過上限就收掉 rg、回縮小範圍的錯誤，不解析半份輸出', async () => {
    const long = `needle ${'x'.repeat(100)}\n`.repeat(100);
    await writeFile(join(root, 'big.log'), long);
    let pid: number | undefined;

    const backend = new ContainedFilesystemBackend({
      rootDir: root,
      ripgrep: { rawOutputMaxBytes: 1024, onChild: (child) => (pid = child.pid) },
    });
    const result = await backend.grep('needle', '/', 'big.log');

    expect(result.matches).toBeUndefined();
    expect(result.error).toContain('narrow');
    expect(result.error).toContain('1024');
    expect(pid).toBeDefined();
    expect(alive(pid as number)).toBe(false);
  });

  it('runner 的碼是 SEARCH_RAW_OUTPUT_OVERFLOW', async () => {
    await writeFile(join(root, 'big.log'), `needle ${'x'.repeat(100)}\n`.repeat(100));
    const outcome = await runRipgrep({
      argv: ['--json', '-F', '--', 'needle', 'big.log'],
      cwd: root,
      internals: { rawOutputMaxBytes: 1024 },
    });
    expect(outcome).toMatchObject({ kind: 'error', code: SEARCH_RAW_OUTPUT_OVERFLOW });
  });

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
      internals: { executable },
    });
    await vi.waitFor(async () => expect(await exists(pidFile)).toBe(true));
    controller.abort();

    const outcome = await pending;

    expect(Date.now() - started).toBeLessThan(3500);
    expect(outcome).toMatchObject({ kind: 'error', code: SEARCH_ABORTED });
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    expect(alive(pid)).toBe(false);
  }, 15_000);

  it('逾時也是 SEARCH_ABORTED，同樣收掉', async () => {
    const { executable, pidFile } = await hangingRg();

    const outcome = await runRipgrep({
      argv: ['--json'],
      cwd: root,
      internals: { executable, timeoutMs: 1500 },
    });

    expect(outcome).toMatchObject({ kind: 'error', code: SEARCH_ABORTED });
    expect(alive(Number((await readFile(pidFile, 'utf8')).trim()))).toBe(false);
  }, 15_000);

  it('SIGTERM 被忽略時，寬限之後升級成 SIGKILL', async () => {
    const { executable, pidFile } = await hangingRg(true);
    const controller = new AbortController();
    const pending = runRipgrep({
      argv: ['--json'],
      cwd: root,
      signal: controller.signal,
      internals: { executable, killGraceMs: 300 },
    });
    await vi.waitFor(async () => expect(await exists(pidFile)).toBe(true));
    controller.abort();

    const outcome = await pending;

    expect(outcome).toMatchObject({ kind: 'error', code: SEARCH_ABORTED });
    expect(alive(Number((await readFile(pidFile, 'utf8')).trim()))).toBe(false);
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
    });
    expect(outcome).toMatchObject({ kind: 'error', code: SEARCH_INVALID_PATTERN });
  });

  it('被訊號殺掉（不是我們收的）是 SEARCH_FAILED', async () => {
    const executable = await script('self-kill.sh', 'kill -9 $$');
    const outcome = await runRipgrep({ argv: ['--json'], cwd: root, internals: { executable } });
    expect(outcome).toMatchObject({ kind: 'error', code: SEARCH_FAILED });
    expect((outcome as { message: string }).message).toContain('SIGKILL');
  });

  it('非 ENOENT 的起不來（沒有執行權限）是 SEARCH_FAILED，不走退路', async () => {
    const file = join(base, 'not-executable');
    await writeFile(file, '#!/bin/sh\n');
    const bare = vi.spyOn(FilesystemBackend.prototype, 'grep');

    const result = await new ContainedFilesystemBackend({
      rootDir: root,
      ripgrep: { executable: file },
    }).grep('needle', '/');

    expect(result.error).toContain('could not start');
    expect(bare).not.toHaveBeenCalled();
  });
});

describe('偏離 1：沒有 rg 才走基座的退路', () => {
  it('執行檔找不到（ENOENT）：交給基座，走 literalSearch', async () => {
    const bare = vi.spyOn(FilesystemBackend.prototype, 'grep');

    const result = await new ContainedFilesystemBackend({
      rootDir: root,
      ripgrep: { executable: 'nexus-no-such-rg' },
    }).grep('needle', '/');

    expect(bare).toHaveBeenCalledTimes(1);
    expect(paths(result)).toEqual(['/a.log', '/notes.txt']);
  });

  it('工作區根不存在：沒有東西可找（matches 為空），**不走退路**（ENOENT 會被誤當成沒有 rg）', async () => {
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

  it('工作區根不是目錄：同樣回錯誤、不走退路', async () => {
    const bare = vi.spyOn(FilesystemBackend.prototype, 'grep');
    const file = join(base, 'a-file');
    await writeFile(file, 'needle\n');

    const result = await new ContainedFilesystemBackend({ rootDir: file }).grep('needle', '/');

    expect(result.error).toContain('workspace root');
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
    const bin = join(base, 'bin');
    await mkdir(bin);
    const shim = join(bin, 'rg');
    await writeFile(shim, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 20\n`);
    await chmod(shim, 0o755);
    process.env['PATH'] = `${bin}:${originalEnv.path ?? ''}`;
    const controller = new AbortController();
    const running = runAgent([{ name: 'grep', args: { pattern: 'needle', path: '/' } }], {
      signal: controller.signal,
    });
    await vi.waitFor(async () => expect(await exists(pidFile)).toBe(true), { timeout: 20_000 });
    controller.abort();

    await running;

    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5_000 });
  }, 60_000);
});
