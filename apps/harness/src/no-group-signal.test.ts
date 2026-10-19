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

describe('isAlive 只把 ESRCH 當成「不在了」', () => {
  it('ESRCH 回 false、EPERM 回 true（在，屬於別人）、其他錯照丟，不讓 toBe(false) 假通過', () => {
    const kill = vi.spyOn(process, 'kill');
    const failWith = (code: string) =>
      kill.mockImplementationOnce(() => {
        throw Object.assign(new Error(code), { code });
      });
    failWith('ESRCH');
    expect(isAlive(4242)).toBe(false);
    failWith('EPERM');
    expect(isAlive(4242)).toBe(true);
    failWith('EINVAL');
    expect(() => isAlive(4242)).toThrow('EINVAL');
    kill.mockReturnValueOnce(true);
    expect(isAlive(4242)).toBe(true);
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

/** 把註解換成同樣長度的空白（保留位移與行號）：註解裡寫的 `process.kill(` 不是呼叫。 */
function stripComments(text: string): string {
  const blank = (match: string): string => match.replace(/[^\n]/gu, ' ');
  return text.replace(/\/\*[\s\S]*?\*\//gu, blank).replace(/(?<![:'"`\\])\/\/[^\n]*/gu, blank);
}

interface KillSite {
  /** 這個呼叫在（去掉註解的）原始碼裡的位移。 */
  readonly offset: number;
  /** pid 那一格的運算式，頂層逗號切開、不含前後空白。 */
  readonly pid: string;
  /** 訊號那一格；沒寫是空字串。 */
  readonly signal: string;
}

/**
 * 取出每一個 `process.kill(<pid>, <signal>)`（含 `globalThis.process.kill`、`global.process.kill`）。括號配對、頂層逗號切開，所以
 * pid 那一格可以是任意運算式。前面不能是 `.` 或識別字元：`server.process.kill('SIGINT')` 是 ChildProcess 的方法，不是全域 `process.kill`
 * （那個才吃 pid）。
 */
function killSites(text: string): KillSite[] {
  const sites: KillSite[] = [];
  let from = 0;
  for (;;) {
    const found = /(?<![\w$.])(?:(?:globalThis|global)\.)?process\.kill\(/u.exec(text.slice(from));
    if (found === null) return sites;
    const at = from + found.index;
    let depth = 1;
    let index = at + found[0].length;
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
    sites.push({ offset: at, pid: (args[0] ?? '').trim(), signal: (args[1] ?? '').trim() });
    from = index;
  }
}

/**
 * 把 `process.kill` 取出來另外叫的寫法：解構（`const { kill } = process`）、指派（`const k = process.kill`、`.bind`）、
 * 具名匯入（`import { kill } from 'node:process'`）。這些之後的呼叫長得像裸的 `kill(…)`，上面的掃描看不到，所以寫法本身就算違規。
 */
function killAliases(text: string): string[] {
  const patterns = [
    /\{[^}]*\bkill\b[^}]*\}\s*=\s*(?:(?:globalThis|global)\.)?process\b/gu,
    /=\s*(?:(?:globalThis|global)\.)?process\.kill\b(?!\()/gu,
    /import\s*\{[^}]*\bkill\b[^}]*\}\s*from\s*['"](?:node:)?process['"]/gu,
  ];
  return patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[0]));
}

/** 本地的 pid 守衛：呼叫之前（同一段函式）出現過的 `Number.isInteger(pid) && pid > 1`。 */
const LOCAL_PID_GUARD = /Number\.isInteger\(pid\)\s*&&\s*pid\s*>\s*1/u;

/** 這個呼叫點可以放行嗎：訊號 0（只探測、不送）；或 pid 是變數 `pid`，而且它之前 600 個字元內有本地守衛。 */
function allowedKill(text: string, site: KillSite): boolean {
  if (site.signal === '0') return true;
  if (site.pid !== 'pid') return false;
  return LOCAL_PID_GUARD.test(text.slice(Math.max(0, site.offset - 600), site.offset));
}

describe('不繞過 helper 直接送非 0 訊號', () => {
  it('測試原始碼裡的 process.kill(…, 非 0 訊號) 只出現在 test-pids.fixture.ts，或這個呼叫之前有本地的 pid > 1 檢查；也不得把 process.kill 取出來另叫', () => {
    const repo = fileURLToPath(new URL('../../..', import.meta.url));
    const offenders: string[] = [];
    let checked = 0;
    for (const file of sourceFiles()) {
      if (file.endsWith('no-group-signal.test.ts')) continue;
      const text = stripComments(readFileSync(file, 'utf8'));
      const sites = killSites(text).filter((site) => site.signal !== '0');
      const aliases = killAliases(text);
      if (sites.length > 0) checked += 1;
      if (file.endsWith('test-pids.fixture.ts')) continue;
      // 以呼叫點為單位：同一個檔案裡有一處守衛，不替其他裸的呼叫放行。
      for (const site of sites) {
        if (!allowedKill(text, site)) {
          offenders.push(`${relative(repo, file)}：process.kill(${site.pid}, ${site.signal})`);
        }
      }
      for (const alias of aliases)
        offenders.push(`${relative(repo, file)}：把 process.kill 取出來另叫（${alias}）`);
    }
    // 前提：掃得到東西（掃描器壞了回空集合，這條就是空測試）。
    expect(checked).toBeGreaterThanOrEqual(3);
    expect(offenders).toEqual([]);
  });

  describe('掃描器看得出各種違規寫法', () => {
    const offending = (text: string): string[] => {
      const clean = stripComments(text);
      return [
        ...killSites(clean)
          .filter((site) => site.signal !== '0' && !allowedKill(clean, site))
          .map((site) => `kill(${site.pid},${site.signal})`),
        ...killAliases(clean).map((alias) => `alias:${alias}`),
      ];
    };

    it('直接 process.kill(Number(讀到的字串), SIGKILL)', () => {
      expect(offending("process.kill(Number(await readFile(f, 'utf8')), 'SIGKILL');")).toEqual([
        "kill(Number(await readFile(f, 'utf8')),'SIGKILL')",
      ]);
      expect(killSites('process.kill(pid, 0);')).toMatchObject([{ pid: 'pid', signal: '0' }]);
      expect(killSites('process.kill(pid, signal)')).toMatchObject([{ signal: 'signal' }]);
    });

    it('同一個檔案有一處守衛，不替另一處裸的呼叫放行（以呼叫點為單位）', () => {
      const guarded =
        "if (!(Number.isInteger(pid) && pid > 1)) throw new Error('x');\nprocess.kill(pid, 'SIGKILL');\n";
      expect(offending(guarded)).toEqual([]);
      const far = `${guarded}${'// 隔了很遠\n'.repeat(80)}process.kill(other, 'SIGKILL');\n`;
      expect(offending(far)).toEqual(["kill(other,'SIGKILL')"]);
      const later = `process.kill(pid, 'SIGKILL');\nif (!(Number.isInteger(pid) && pid > 1)) throw new Error('x');\n`;
      expect(offending(later)).toEqual(["kill(pid,'SIGKILL')"]);
    });

    it('globalThis.process.kill、global.process.kill 也算；ChildProcess 的 server.process.kill 不算', () => {
      expect(offending("globalThis.process.kill(pid, 'SIGKILL');")).toHaveLength(1);
      expect(offending("global.process.kill(pid, 'SIGKILL');")).toHaveLength(1);
      expect(offending("server.process.kill('SIGINT');")).toEqual([]);
    });

    it('解構、指派、具名匯入取出來的 kill 算違規', () => {
      expect(offending('const { kill } = process;')).toHaveLength(1);
      expect(offending('const { pid, kill } = globalThis.process;')).toHaveLength(1);
      expect(offending('const k = process.kill;')).toHaveLength(1);
      expect(offending('const k = process.kill.bind(process);')).toHaveLength(1);
      expect(offending("import { kill } from 'node:process';")).toHaveLength(1);
    });

    it('註解裡的 process.kill( 不是呼叫；字串裡的（driver 腳本）照算', () => {
      expect(offending("// process.kill(0, 'SIGKILL')\n/* process.kill(0, 'SIGKILL') */")).toEqual(
        [],
      );
      expect(offending("const driver = `process.kill(0, 'SIGKILL')`;")).toHaveLength(1);
    });
  });
});
