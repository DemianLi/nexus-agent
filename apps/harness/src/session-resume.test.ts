/**
 * CLI 的 `--resume`：會話 resume 的門 A 真的開了——
 * [#251](https://github.com/DemianLi/nexus-agent/issues/251) 的端到端驗收。
 *
 * 形狀（seed 是一個建構選項、`SessionStore` 多了 `resume`）在 `session-resume-doors.test.ts`
 * 與 `sandbox-mode.test.ts`；`session/end-seed` 的重設在各自的配套入口測試裡。這一檔只問
 * **兩次真的 `runCli`**：上一次留下什麼、這一次接回來什麼、檔案被寫成什麼樣。
 *
 * ## 前提先釘死
 *
 * 沙箱模式的預設是 `workspace-write`，所以「接回來的是 `workspace-write`」證不了任何事——
 * 一份從預設出發的新日誌也長那樣。所以第一次跑**切成 `read-only`**，而且配一條沒給
 * `--resume` 的對照：同一個工作區、同一份清單，起始那一格是 `workspace-write`。
 */

import { appendFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SESSION_LOG_FORMAT_VERSION } from '@nexus/core';
import type { SessionEvent } from '@nexus/core';
import { GOAL_COMMAND_NAME } from '@nexus/plugin-goal';

import { parseCliArgs, runCli } from './cli.js';
import { SANDBOX_COMMAND_NAME } from './sandbox-mode.js';

/** 分開收 stdout 與 stderr：不變量違規走的是後者。 */
function recorder() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    printer: {
      log: (line: string) => void out.push(line),
      error: (line: string) => void err.push(line),
    },
    stdout: () => out.join('\n'),
    stderr: () => err.join('\n'),
  };
}

/** 跑一次 CLI；`lines` 給了就是 REPL，餵完就結束。 */
async function cli(argv: readonly string[], lines = '/exit\n') {
  const { printer, stdout, stderr } = recorder();
  const input = new PassThrough();
  input.end(lines);
  await runCli({ argv: [...argv], input, output: new PassThrough(), printer });
  return { stdout: stdout(), stderr: stderr() };
}

/** 讀一份 jsonl 日誌。 */
async function readLog(path: string): Promise<SessionEvent[]> {
  const body = await readFile(path, 'utf8');
  return body
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SessionEvent);
}

let workspace: string;
let logs: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'nexus-resume-ws-'));
  logs = await mkdtemp(join(tmpdir(), 'nexus-resume-logs-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
  await rm(logs, { recursive: true, force: true });
});

/** 第一次跑：切成 read-only、建一個目標，然後離開。回那一次的 run 目錄。 */
async function firstRun(): Promise<string> {
  await cli(
    ['--workspace', workspace, '--session-log', logs],
    `/${SANDBOX_COMMAND_NAME} read-only\n/${GOAL_COMMAND_NAME} 把測試修綠\n/exit\n`,
  );
  const entries = await readdir(logs);
  expect(entries).toHaveLength(1);
  return join(logs, entries[0]!);
}

describe('接回來的是日誌那一半', () => {
  it('上一次切成 read-only，`--resume` 回來還是 read-only，目標在但要人重新授權', async () => {
    const runDir = await firstRun();
    const { stdout, stderr } = await cli(
      ['--workspace', workspace, '--resume', runDir],
      `/${SANDBOX_COMMAND_NAME}\n/${GOAL_COMMAND_NAME}\n/exit\n`,
    );

    expect(stdout).toContain('起始 mode: read-only（從續接的日誌來）');
    // `/sandbox` 不帶引數報的是**控制器此刻那一格**，也就是 fence 讀的那一顆。
    expect(stdout).toMatch(/目前.*read-only/);
    // 目標回來了，相位 active，但授權打回 disarmed——所以提示的是 `/goal resume`。
    expect(stdout).toContain('目標：把測試修綠');
    expect(stdout).toContain('狀態：進行中');
    expect(stdout).toContain(`/${GOAL_COMMAND_NAME} resume`);
    // 披露照實講回來的是哪一半。
    expect(stdout).toContain('對話與計劃模式從頭開始');
    expect(stderr).not.toContain('[不變量]');
  });

  it('對照：同一個工作區不給 `--resume`，起始那一格是 workspace-write', async () => {
    await firstRun();
    const { stdout } = await cli(['--workspace', workspace]);
    expect(stdout).toContain('起始 mode: workspace-write，');
    expect(stdout).not.toContain('從續接的日誌來');
  });
});

describe('往原檔續寫', () => {
  it('seq 從上一次的長度接下去，中間只有一顆 `session/end-seed`，header 升到這一版', async () => {
    const runDir = await firstRun();
    const before = await readLog(join(runDir, 'cli.jsonl'));
    // 讓 header 看起來是上一版寫的：續接要把它蓋成這一版（續寫進去的是這一版的詞彙）。
    const headerPath = join(runDir, 'cli.header.json');
    const header = JSON.parse(await readFile(headerPath, 'utf8')) as Record<string, unknown>;
    await writeFile(headerPath, JSON.stringify({ ...header, version: 2 }));

    await cli(['--workspace', workspace, '--resume', runDir]);

    const after = await readLog(join(runDir, 'cli.jsonl'));
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.map((event) => event.seq)).toEqual(after.map((_, index) => index));
    expect(after.filter((event) => event.type === 'session/end-seed')).toEqual([
      expect.objectContaining({ seq: before.length }),
    ]);
    const rewritten = JSON.parse(await readFile(headerPath, 'utf8')) as Record<string, unknown>;
    expect(rewritten).toEqual({ ...header, version: SESSION_LOG_FORMAT_VERSION });
    // 沒有另開目錄：續接不是把舊的抄進新的。
    expect(await readdir(logs)).toHaveLength(1);
  });
});

describe('尾巴', () => {
  /**
   * 上一個行程當在輪中、一個命令沒落定、最後一行寫到一半——三件事都是當掉的常態。
   *
   * 截掉半行是讀方的事，不重設 turn 與命令的開關是配套入口的事；三件任何一件沒做，
   * 這一條都會紅：半行會讓續寫的第一行黏成壞行，另外兩件會讓 stderr 出現 `[不變量]`。
   */
  it('當在輪中、命令沒落定、最後一行寫到一半：接得回來，不報違規，半行被截掉', async () => {
    const runDir = await firstRun();
    const logPath = join(runDir, 'cli.jsonl');
    const before = await readLog(logPath);
    const next = before.length;
    const tail: SessionEvent[] = [
      { type: 'turn/start', seq: next, time: 1, data: { kind: 'message', text: '跑到一半' } },
      {
        type: 'command/run',
        seq: next + 1,
        time: 1,
        data: { commandId: 'cmd-dead-1', name: 'plan', args: '', source: { kind: 'user' } },
      },
    ] as SessionEvent[];
    await appendFile(logPath, `${tail.map((event) => JSON.stringify(event)).join('\n')}\n`);
    await appendFile(logPath, '{"type":"turn/end","seq":');

    const { stderr } = await cli(
      ['--workspace', workspace, '--resume', runDir],
      `/${SANDBOX_COMMAND_NAME}\n說點什麼\n/exit\n`,
    );

    expect(stderr).not.toContain('[不變量]');
    const after = await readLog(logPath);
    expect(after.map((event) => event.seq)).toEqual(after.map((_, index) => index));
    expect(after[next + 2]).toMatchObject({ type: 'session/end-seed', seq: next + 2 });
  });
});

describe('讀不了的時候在什麼都還沒起來之前就講', () => {
  it('中段一行壞了是壞檔', async () => {
    const runDir = await firstRun();
    const logPath = join(runDir, 'cli.jsonl');
    const lines = (await readFile(logPath, 'utf8')).split('\n');
    lines[1] = '這不是 JSON';
    await writeFile(logPath, lines.join('\n'));
    await expect(cli(['--resume', runDir])).rejects.toThrow(/存檔壞了：第 2 行不是 JSON/);
  });

  it('缺號是壞檔，不是當掉', async () => {
    const runDir = await firstRun();
    const logPath = join(runDir, 'cli.jsonl');
    const lines = (await readFile(logPath, 'utf8')).split('\n').filter((line) => line !== '');
    await writeFile(logPath, `${[lines[0], ...lines.slice(2)].join('\n')}\n`);
    await expect(cli(['--resume', runDir])).rejects.toThrow(/缺號或重號/);
  });

  it('版本比這一版新：不是壞的，是讀不懂', async () => {
    const runDir = await firstRun();
    const headerPath = join(runDir, 'cli.header.json');
    const header = JSON.parse(await readFile(headerPath, 'utf8')) as Record<string, unknown>;
    await writeFile(
      headerPath,
      JSON.stringify({ ...header, version: SESSION_LOG_FORMAT_VERSION + 1 }),
    );
    await expect(cli(['--resume', runDir])).rejects.toThrow(/檔案沒有壞，是比這一版新/);
  });

  it('那個目錄裡沒有這份會話', async () => {
    await expect(cli(['--resume', logs])).rejects.toThrow(/裡沒有會話 "cli"/);
  });
});

describe('旗標', () => {
  it('不配 `--sandbox`：兩個來源不管誰贏，另一個都是靜靜被丟掉', () => {
    expect(() =>
      parseCliArgs(['--resume', 'x', '--workspace', 'w', '--sandbox', 'read-only']),
    ).toThrow(/--resume 不能配 --sandbox/);
    // 沒配 `--workspace` 時也先講這一條，而不是「--sandbox 要配 --workspace」。
    expect(() => parseCliArgs(['--resume', 'x', '--sandbox', 'read-only'])).toThrow(
      /--resume 不能配 --sandbox/,
    );
  });

  it('不配 `--session-log`：續接就寫回那個目錄', () => {
    expect(() => parseCliArgs(['--resume', 'x', '--session-log', 'y'])).toThrow(
      /--resume 不能配 --session-log/,
    );
  });

  it('要給一個目錄', () => {
    expect(() => parseCliArgs(['--resume', ' '])).toThrow(/--resume 要給一個 run 目錄/);
  });

  it('不能在 `--workspace` 底下：續接之後新事件寫回那個目錄', async () => {
    await expect(
      cli(['--workspace', workspace, '--resume', join(workspace, 'logs')]),
    ).rejects.toThrow(/--resume 不能在 --workspace 底下/);
  });
});
