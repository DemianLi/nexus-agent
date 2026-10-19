/**
 * 測試裡不能有「pid 讀成 0 就殺掉整個行程群組」的路徑（[#1712](https://github.com/DemianLi/nexus-agent/issues/1712)）。
 *
 * 症狀：本機跑 harness 全套，跑到一半無聲消失，沒有摘要、連外層 shell 的 `; echo DONE=$?` 都沒跑到，同一棵樹重跑就全綠。
 * 原因：`ripgrep-host-exit.test.ts`／`git-host-exit.test.ts` 的假子行程用 `writeFileSync` 寫 pid 檔（先建出空檔、後寫字），driver 一看到檔案存在就
 * `process.exit(0)`，子行程被收掉的時機剛好落在兩步之間，檔案就是空的；測試 `Number(讀到的字串)` 得 0，`afterEach` 對 pid 0 送
 * `SIGKILL`——pid 0 是呼叫者自己的行程群組，vitest 主行程、全部 worker 與外層 shell 一起被殺。
 *
 * 三層：這個檔案釘 helper 本身（不合法的 pid 丟錯、不送）、pid 檔寫到一半讀不到半截、以及整棵測試原始碼不得繞過 helper 直接送非 0 訊號。
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertSignalablePid,
  isAlive,
  parsePid,
  readPidFile,
  signalPid,
} from './test-pids.fixture.js';

const temporary: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('不合法的 pid 不送訊號', () => {
  it.each([0, 1, -1, -4242, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number('')])(
    'signalPid(%s, SIGKILL) 丟錯，process.kill 一次都沒被呼叫',
    (pid) => {
      const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
      expect(() => signalPid(pid, 'SIGKILL')).toThrow(RangeError);
      expect(() => isAlive(pid)).toThrow(RangeError);
      expect(kill).not.toHaveBeenCalled();
    },
  );

  it('Number("")、Number("  ") 就是 0：parsePid 擋下', () => {
    expect(Number('')).toBe(0);
    expect(() => parsePid('', 'pid 檔')).toThrow(/不是 pid/u);
    expect(() => parsePid('  \n', 'pid 檔')).toThrow(/不是 pid/u);
    expect(() => parsePid('0', 'pid 檔')).toThrow(RangeError);
    expect(() => parsePid('-5', 'pid 檔')).toThrow(/不是 pid/u);
    expect(parsePid('4242\n', 'pid 檔')).toBe(4242);
  });

  it('合法的 pid 照送；行程已經不在（ESRCH）回 false，其他錯照丟', () => {
    const kill = vi.spyOn(process, 'kill');
    kill.mockReturnValueOnce(true);
    expect(signalPid(4242, 'SIGKILL')).toBe(true);
    expect(kill).toHaveBeenCalledWith(4242, 'SIGKILL');
    kill.mockImplementationOnce(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    expect(signalPid(4242, 'SIGKILL')).toBe(false);
    kill.mockImplementationOnce(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    });
    expect(() => signalPid(4242, 'SIGKILL')).toThrow('denied');
    expect(() => assertSignalablePid(2)).not.toThrow();
  });
});

describe('pid 檔存在不代表有內容', () => {
  it('檔案先是空的、稍後才寫進 pid：readPidFile 等到完整的才回，不回 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-pid-file-'));
    temporary.push(dir);
    const file = join(dir, 'pid');
    writeFileSync(file, '');
    setTimeout(() => writeFileSync(file, '31337'), 80);
    expect(await readPidFile(file, 5_000)).toBe(31337);
  });

  it('寫的人死在兩步之間、檔案永遠是空的：逾時丟錯，不是回 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-pid-file-'));
    temporary.push(dir);
    const file = join(dir, 'pid');
    writeFileSync(file, '');
    await expect(readPidFile(file, 150)).rejects.toThrow(/等不到.*完整 pid/u);
  });
});

/** 整棵測試原始碼（harness 與各套件），略過產物與相依。 */
function sourceFiles(): string[] {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const repo = join(here, '..', '..', '..');
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'lib' || name === 'dist' || name === '.cordis')
        continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(test|fixture)\.ts$/u.test(name)) out.push(path);
    }
  };
  walk(join(repo, 'apps', 'harness', 'src'));
  for (const pkg of readdirSync(join(repo, 'packages'))) {
    const src = join(repo, 'packages', pkg, 'src');
    try {
      walk(src);
    } catch {
      // 這個套件沒有 src。
    }
  }
  return out;
}

/** 取出每一個 `process.kill(<pid>, <signal>)` 的第二個引數（括號配對、頂層逗號切開，所以 pid 那一格可以是任意運算式）。 */
function killCalls(text: string): string[] {
  const calls: string[] = [];
  let from = 0;
  for (;;) {
    // 前面不能是 `.` 或識別字元：`server.process.kill('SIGINT')` 是 ChildProcess 的方法，不是全域 `process.kill`（那個才吃 pid）。
    const found = /(?<![\w.])process\.kill\(/u.exec(text.slice(from));
    if (found === null) return calls;
    const at = from + found.index;
    let depth = 1;
    let index = at + 'process.kill('.length;
    const args: string[] = [];
    let start = index;
    for (; index < text.length && depth > 0; index += 1) {
      const char = text[index];
      if (char === '(' || char === '[' || char === '{') depth += 1;
      else if (char === ')' || char === ']' || char === '}') {
        depth -= 1;
        if (depth === 0) args.push(text.slice(start, index));
      } else if (char === ',' && depth === 1) {
        args.push(text.slice(start, index));
        start = index + 1;
      }
    }
    calls.push((args[1] ?? '').trim());
    from = index;
  }
}

describe('不繞過 helper 直接送非 0 訊號', () => {
  it('測試原始碼裡的 process.kill(…, 非 0 訊號) 只出現在 test-pids.fixture.ts，或同一個檔案裡有 pid > 1 的整數檢查', () => {
    const repo = fileURLToPath(new URL('../../..', import.meta.url));
    const offenders: string[] = [];
    let checked = 0;
    for (const file of sourceFiles()) {
      if (file.endsWith('no-group-signal.test.ts')) continue;
      const text = readFileSync(file, 'utf8');
      const signals = killCalls(text).filter((signal) => signal !== '0');
      if (signals.length === 0) continue;
      checked += 1;
      if (file.endsWith('test-pids.fixture.ts')) continue;
      if (text.includes('Number.isInteger(pid) && pid > 1')) continue;
      offenders.push(`${relative(repo, file)}：${signals.join('、')}`);
    }
    // 前提：掃得到東西（掃描器壞了回空集合，這條就是空測試）。
    expect(checked).toBeGreaterThanOrEqual(3);
    expect(offenders).toEqual([]);
  });

  it('掃描器看得出違規：一段直接 process.kill(Number(讀到的字串), SIGKILL) 會被抓到', () => {
    expect(killCalls("process.kill(Number(await readFile(f, 'utf8')), 'SIGKILL');")).toEqual([
      "'SIGKILL'",
    ]);
    expect(killCalls('process.kill(pid, 0);')).toEqual(['0']);
    expect(killCalls('process.kill(pid, signal)')).toEqual(['signal']);
  });
});
