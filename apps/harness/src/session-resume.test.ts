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

import { SESSION_LOG_FORMAT_VERSION, SessionAlreadyOwnedError } from '@nexus/core';
import type { SessionEvent } from '@nexus/core';
import { GOAL_COMMAND_NAME } from '@nexus/plugin-goal';
import {
  PLAN_ALREADY_ACTIVE_MESSAGE,
  PLAN_COMMAND_NAME,
  PLAN_ENTERED_MESSAGE,
} from '@nexus/plugin-plan-mode';

import { parseCliArgs, RESUMED_PLAN_MODE_NOTICE, runCli } from './cli.js';
import { ResumeCwdConflictError } from './resume-guards.js';
import { openJsonlSessionStore } from './jsonl-session-store.js';
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

/**
 * 跑一次 CLI；`lines` 給了就是 REPL，餵完就結束。
 *
 * `cwd` 不給就是這個行程的 `process.cwd()`——`firstRun` 寫進 header 的也是它。
 */
async function cli(argv: readonly string[], lines = '/exit\n', cwd?: string) {
  const { printer, stdout, stderr } = recorder();
  const input = new PassThrough();
  input.end(lines);
  await runCli({
    argv: [...argv],
    input,
    output: new PassThrough(),
    printer,
    ...(cwd !== undefined && { cwd }),
  });
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
    expect(stdout).toContain('對話從頭開始');
    expect(stderr).not.toContain('[不變量]');
  });

  it('對照：同一個工作區不給 `--resume`，起始那一格是 workspace-write', async () => {
    await firstRun();
    const { stdout } = await cli(['--workspace', workspace]);
    expect(stdout).toContain('起始 mode: workspace-write，');
    expect(stdout).not.toContain('從續接的日誌來');
  });
});

describe('計劃模式跟著回來', () => {
  /**
   * `plan/mode` 是第一顆要**熬過** `session/end-seed` 的狀態——別的配套入口都在那顆標記上
   * 重設，所以「在 end-seed 歸零」是這一帶最順手寫錯的那一種。驗收要接**兩次**：第二次
   * 讀到的日誌上有兩顆標記，而模式得跨過兩顆。
   */
  it('上一次開了計劃模式，接回來還在；再接一次也還在', async () => {
    await cli(['--workspace', workspace, '--session-log', logs], `/${PLAN_COMMAND_NAME}\n/exit\n`);
    const entries = await readdir(logs);
    const runDir = join(logs, entries[0]!);

    const once = await cli(
      ['--workspace', workspace, '--resume', runDir],
      `/${PLAN_COMMAND_NAME}\n/exit\n`,
    );
    expect(once.stdout).toContain(PLAN_ALREADY_ACTIVE_MESSAGE);
    // **接回來的是一個 CLI 收不了核准的狀態**：計劃交不出去，唯一的出路是人打 `/plan off`。
    // 以前這個狀態跨不過重啟，現在跨得過，所以要在一開始就講，不是等模型被拒了才知道。
    expect(once.stdout).toContain(RESUMED_PLAN_MODE_NOTICE);
    const twice = await cli(
      ['--workspace', workspace, '--resume', runDir],
      `/${PLAN_COMMAND_NAME}\n/exit\n`,
    );
    expect(twice.stdout).toContain(PLAN_ALREADY_ACTIVE_MESSAGE);
    expect(twice.stderr).not.toContain('[不變量]');

    const events = await readLog(join(runDir, 'cli.jsonl'));
    expect(events.filter((event) => event.type === 'session/end-seed')).toHaveLength(2);
    // 開過一次，之後兩次都是「已經在裡面」——只有一顆。
    expect(events.filter((event) => event.type === 'plan/mode')).toEqual([
      expect.objectContaining({ data: { active: true } }),
    ]);
  });

  it('對照：同一個工作區不給 `--resume`，計劃模式是關的，也不講那一行', async () => {
    await cli(['--workspace', workspace, '--session-log', logs], `/${PLAN_COMMAND_NAME}\n/exit\n`);
    const { stdout } = await cli(['--workspace', workspace], `/${PLAN_COMMAND_NAME}\n/exit\n`);
    expect(stdout).toContain(PLAN_ENTERED_MESSAGE);
    expect(stdout).not.toContain(RESUMED_PLAN_MODE_NOTICE);
  });

  it('接回來的計劃模式是關的：不講那一行', async () => {
    await cli(
      ['--workspace', workspace, '--session-log', logs],
      `/${PLAN_COMMAND_NAME}\n/${PLAN_COMMAND_NAME} off\n/exit\n`,
    );
    const runDir = join(logs, (await readdir(logs))[0]!);
    const { stdout } = await cli(['--workspace', workspace, '--resume', runDir]);
    expect(stdout).not.toContain(RESUMED_PLAN_MODE_NOTICE);
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

describe('接第二次', () => {
  /**
   * 續接 → 做事 → 離開 → 再續接，是一般使用者的路徑。第二次讀到的是**自己這一版蓋過的
   * header**，seed 裡已經有一顆 end-seed，而配套入口要認的是**最後那一顆**。
   */
  it('中間有做事：兩顆 end-seed，第二次接回來的是第二段的狀態', async () => {
    const runDir = await firstRun();
    await cli(
      ['--workspace', workspace, '--resume', runDir],
      `/${SANDBOX_COMMAND_NAME} workspace-write\n說點什麼\n/exit\n`,
    );
    const { stdout, stderr } = await cli(
      ['--workspace', workspace, '--resume', runDir],
      `/${SANDBOX_COMMAND_NAME}\n說點什麼\n/exit\n`,
    );

    expect(stdout).toContain('起始 mode: workspace-write（從續接的日誌來）');
    expect(stderr).not.toContain('[不變量]');
    const after = await readLog(join(runDir, 'cli.jsonl'));
    expect(after.map((event) => event.seq)).toEqual(after.map((_, index) => index));
    expect(after.filter((event) => event.type === 'session/end-seed')).toHaveLength(2);
  });

  /**
   * 帶 `--workspace` 走不到這一格：沙箱控制器每次起來都寫一顆 `sandbox/mode`，seed 不會停在
   * end-seed。所以用一次**沒有 fence** 的跑——日誌上一顆模式都沒有，續接也不必配
   * `--workspace`。
   */
  it('中間什麼都沒做：seed 已經停在 end-seed，不再補第二顆', async () => {
    await cli(['--session-log', logs], `/${GOAL_COMMAND_NAME} 把測試修綠\n/exit\n`);
    const entries = await readdir(logs);
    expect(entries).toHaveLength(1);
    const runDir = join(logs, entries[0]!);
    await cli(['--resume', runDir]);
    const once = await readLog(join(runDir, 'cli.jsonl'));
    await cli(['--resume', runDir]);
    const twice = await readLog(join(runDir, 'cli.jsonl'));

    expect(twice).toEqual(once);
    expect(twice.at(-1)).toMatchObject({ type: 'session/end-seed' });
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

/**
 * 寫租約的端到端那一半（鎖本身的行為在 `session-lease.test.ts`）：CLI 撞上別人握著時在
 * 什麼都還沒起來之前就講，而且自己拋錯時不把鎖留在手上。
 */
describe('寫租約', () => {
  it('另一個把手握著：擋下、檔案沒被動；它放了之後接得回來', async () => {
    const runDir = await firstRun();
    const holder = await openJsonlSessionStore({ directory: runDir }).resume('cli');
    const log = join(runDir, 'cli.jsonl');
    const before = await readFile(log, 'utf8');

    await expect(cli(['--workspace', workspace, '--resume', runDir])).rejects.toThrow(
      SessionAlreadyOwnedError,
    );
    expect(await readFile(log, 'utf8')).toBe(before);

    await holder.stored.close();
    await cli(['--workspace', workspace, '--resume', runDir]);
  });

  /**
   * 續接在讀之前就拿了租約，要到日誌掛上之後才有人收。中間拋錯的話 CLI 行程退出、kernel
   * 會放——但同一個行程裡緊接著再接一次，就會撞上自己沒放的鎖。
   */
  it('續接之後、日誌掛上之前拋錯：鎖放掉了，同一個行程馬上再接一次接得回來', async () => {
    const runDir = await firstRun();
    await expect(cli(['--resume', runDir])).rejects.toThrow(/--resume 要配 --workspace/);
    const { stdout } = await cli(
      ['--workspace', workspace, '--resume', runDir],
      `/${SANDBOX_COMMAND_NAME}\n/exit\n`,
    );
    expect(stdout).toContain('read-only');
  });
});

/**
 * 組合一致：照 dsh 的 `ApiSessionCwdConflict`，**只抄得到 cwd 這一格**（理由在
 * `ResumeCwdConflictError` 的註解）。
 *
 * 擋下的兩條都要斷言**檔案一個位元組都沒動**——擋在讀回之後、第一次寫之前，才是「什麼都
 * 還沒起來」；晚一步的話 `session/end-seed` 已經寫進一份不屬於這個目錄的日誌。
 */
describe('屬於哪個目錄', () => {
  /** run 目錄裡 root 那一份的兩個檔。 */
  async function rootFiles(runDir: string) {
    const entries = await readdir(runDir);
    const header = entries.filter((name) => name.endsWith('.header.json'));
    const log = entries.filter((name) => name.endsWith('.jsonl'));
    expect(header).toHaveLength(1);
    expect(log).toHaveLength(1);
    return { header: join(runDir, header[0]!), log: join(runDir, log[0]!) };
  }

  it('換了目錄：擋下，訊息帶兩個目錄，檔案沒被動', async () => {
    const runDir = await firstRun();
    const { header, log } = await rootFiles(runDir);
    // 前提：header 記的就是這個行程的目錄，不然下面那一條「換了」證不了什麼。
    expect(JSON.parse(await readFile(header, 'utf8')).cwd).toBe(process.cwd());
    const before = await readFile(log, 'utf8');

    await expect(
      cli(['--workspace', workspace, '--resume', runDir], '/exit\n', workspace),
    ).rejects.toThrow(`屬於 ${process.cwd()}，不是 ${workspace}`);
    expect(await readFile(log, 'utf8')).toBe(before);
    // 擋下的時候續接那把租約已經拿了——比對要在清理的 try 裡面，同一個行程回到對的目錄
    // 馬上再接一次才接得回來。
    await cli(['--workspace', workspace, '--resume', runDir]);
  });

  it('header 沒記 cwd：一樣擋下，不猜', async () => {
    const runDir = await firstRun();
    const { header, log } = await rootFiles(runDir);
    const { cwd: _dropped, ...rest } = JSON.parse(await readFile(header, 'utf8')) as Record<
      string,
      unknown
    >;
    await writeFile(header, JSON.stringify(rest));
    const before = await readFile(log, 'utf8');

    await expect(cli(['--workspace', workspace, '--resume', runDir])).rejects.toThrow(
      /沒記下它屬於哪個目錄/,
    );
    expect(await readFile(log, 'utf8')).toBe(before);
  });

  /**
   * **目錄先認，沙箱那道後判。** 換了目錄又沒給 `--workspace` 時兩道都會響，講的要是目錄：
   * 目錄不對的話，日誌裡記的模式是哪一格都不該拿來判，「要配 --workspace」是一句誤導的指示。
   */
  it('換了目錄又沒給 `--workspace`：講的是目錄，不是 `--workspace`', async () => {
    const runDir = await firstRun();
    await expect(cli(['--resume', runDir], '/exit\n', workspace)).rejects.toThrow(
      ResumeCwdConflictError,
    );
  });

  /** 對照：明著給同一個目錄接得回來——證明上面那條擋的是目錄，不是「給了 cwd」這件事。 */
  it('對照：同一個目錄明著給，接得回來', async () => {
    const runDir = await firstRun();
    const { stdout } = await cli(
      ['--workspace', workspace, '--resume', runDir],
      `/${SANDBOX_COMMAND_NAME}\n/exit\n`,
      process.cwd(),
    );
    expect(stdout).toContain('read-only');
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

  it('上一次有 `--workspace`，這一次沒給：接回來的模式會靜靜蒸發，所以擋下', async () => {
    const runDir = await firstRun();
    await expect(cli(['--resume', runDir])).rejects.toThrow(
      /--resume 要配 --workspace：.*沙箱模式 read-only/,
    );
  });

  it('不能在 `--workspace` 底下：續接之後新事件寫回那個目錄', async () => {
    await expect(
      cli(['--workspace', workspace, '--resume', join(workspace, 'logs')]),
    ).rejects.toThrow(/--resume 不能在 --workspace 底下/);
  });
});
