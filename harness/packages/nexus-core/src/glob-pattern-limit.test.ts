/**
 * glob pattern 大括號上限的單元測試：量法（深度、組合、範圍、略過的字元、沒關的組，各附上限 ±1；長度上限；深度超過就停）、
 * 包 backend 的那一層（超過就不叫 backend），與子行程裡對真的 `fast-glob` 送 `{1..900}{1..900}`（拿掉上限就 OOM）。經 `createNexusAgent` 的
 * 接線在 `apps/harness/src/glob-pattern-limit.test.ts`。
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GLOB_PATTERN_MAX_DEPTH,
  GLOB_PATTERN_MAX_EXPANSIONS,
  GLOB_PATTERN_MAX_LENGTH,
  GLOB_PATTERN_TOO_COMPLEX,
  globPatternWithinLimits,
  limitGlobPatterns,
  measureGlobPattern,
} from './glob-pattern-limit.js';

const MAX = GLOB_PATTERN_MAX_EXPANSIONS;

/** `braces` 直接略過的兩個字元。 */
const BOM = String.fromCharCode(0xfeff);
const NBSP = String.fromCharCode(0xa0);

/** 巢狀 `n` 層：`{a,{a,…x…}}`。 */
function nested(n: number): string {
  return `${'{a,'.repeat(n)}x${'}'.repeat(n)}`;
}

/** `n` 組 `{a,b}` 串接：展開 2^n 個。 */
function pairs(n: number): string {
  return '{a,b}'.repeat(n);
}

/** 一組 `n` 個選項：展開 `n` 個。 */
function alternatives(n: number): string {
  return `{${Array.from({ length: n }, (_, i) => `f${i}`).join(',')}}`;
}

describe('量法', () => {
  it('常見的 pattern 照常放行', () => {
    expect(measureGlobPattern('**/*.{ts,tsx}')).toEqual({ depth: 1, expansions: 2 });
    expect(measureGlobPattern('{src,test}/**/*.{js,jsx,ts,tsx,json}')).toEqual({
      depth: 1,
      expansions: 10,
    });
    expect(measureGlobPattern('*.md')).toEqual({ depth: 0, expansions: 1 });
    expect(globPatternWithinLimits('**/*.{ts,tsx}')).toBe(true);
  });

  it('巢狀深度：上限那一層放行，多一層就拒', () => {
    expect(measureGlobPattern(nested(GLOB_PATTERN_MAX_DEPTH))).toEqual({
      depth: GLOB_PATTERN_MAX_DEPTH,
      expansions: GLOB_PATTERN_MAX_DEPTH + 1,
    });
    expect(globPatternWithinLimits(nested(GLOB_PATTERN_MAX_DEPTH))).toBe(true);
    expect(measureGlobPattern(nested(GLOB_PATTERN_MAX_DEPTH + 1))).toEqual({
      depth: GLOB_PATTERN_MAX_DEPTH + 1,
      expansions: Infinity,
    });
    expect(globPatternWithinLimits(nested(GLOB_PATTERN_MAX_DEPTH + 1))).toBe(false);
  });

  it('深度一超過上限就停，不掃完整段', () => {
    const n = 20_000;
    const pattern = `${'{'.repeat(n)}1..2${'}..3'.repeat(n)}`;
    expect(pattern.length).toBeGreaterThan(100_000);
    expect(measureGlobPattern(pattern)).toEqual({
      depth: GLOB_PATTERN_MAX_DEPTH + 1,
      expansions: Infinity,
    });
  });

  it('長度：上限那個字元數放行，多一個就拒', () => {
    expect(globPatternWithinLimits('a'.repeat(GLOB_PATTERN_MAX_LENGTH))).toBe(true);
    expect(globPatternWithinLimits('a'.repeat(GLOB_PATTERN_MAX_LENGTH + 1))).toBe(false);
  });

  it('組合：串接相乘、選項相加，剛好上限放行，多一個就拒', () => {
    expect(measureGlobPattern(pairs(8)).expansions).toBe(256);
    expect(measureGlobPattern(pairs(9)).expansions).toBe(512);
    expect(measureGlobPattern('{a,{b,c}}{x,y}').expansions).toBe(6);
    expect(globPatternWithinLimits(alternatives(MAX))).toBe(true);
    expect(globPatternWithinLimits(alternatives(MAX + 1))).toBe(false);
    expect(globPatternWithinLimits(pairs(8))).toBe(true);
    expect(globPatternWithinLimits(pairs(9))).toBe(false);
  });

  it('範圍：個數照 fill-range 算，剛好上限放行，多一個就拒', () => {
    expect(measureGlobPattern('{a..e}').expansions).toBe(5);
    expect(measureGlobPattern('{5..1}').expansions).toBe(5);
    expect(measureGlobPattern('{1..10..3}').expansions).toBe(4);
    expect(measureGlobPattern('{1..10..0}').expansions).toBe(10);
    expect(globPatternWithinLimits(`{1..${MAX}}`)).toBe(true);
    expect(globPatternWithinLimits(`{1..${MAX + 1}}`)).toBe(false);
    expect(globPatternWithinLimits(`{1..${2 * MAX - 1}..2}`)).toBe(true);
    expect(globPatternWithinLimits(`{1..${2 * MAX + 1}..2}`)).toBe(false);
    expect(globPatternWithinLimits('{1..16}{1..16}')).toBe(true);
    expect(globPatternWithinLimits('{1..16}{1..17}')).toBe(false);
  });

  it('範圍的 `..` 中間夾著 braces 略過的字元，照樣算範圍，上限 ±1', () => {
    for (const skipped of [BOM, NBSP]) {
      expect(measureGlobPattern(`{1.${skipped}.${MAX}}`).expansions).toBe(MAX);
      expect(globPatternWithinLimits(`{1.${skipped}.${MAX}}`)).toBe(true);
      expect(globPatternWithinLimits(`{1.${skipped}.${MAX + 1}}`)).toBe(false);
    }
  });

  it('沒關的組：各段相乘，上限 ±1', () => {
    expect(measureGlobPattern('{{1..16},{1..16}').expansions).toBe(256);
    expect(globPatternWithinLimits('{{1..16},{1..16}')).toBe(true);
    expect(globPatternWithinLimits('{{1..16},{1..17}')).toBe(false);
    expect(globPatternWithinLimits(`{{1..${MAX}}`)).toBe(true);
    expect(globPatternWithinLimits(`{{1..${MAX + 1}}`)).toBe(false);
  });

  it('不認得的範圍寫法一律當成超過上限', () => {
    expect(measureGlobPattern('{1.5..9}').expansions).toBe(Infinity);
    expect(measureGlobPattern('{ 1..3}').expansions).toBe(Infinity);
    expect(measureGlobPattern('{a..9}').expansions).toBe(Infinity);
    // 有逗號就不是範圍。
    expect(measureGlobPattern('{1..9,x}').expansions).toBe(2);
  });

  it('字面的大括號不算：跳脫、方括號、引號裡', () => {
    expect(measureGlobPattern(`\\${pairs(9)}`).expansions).toBe(256);
    expect(measureGlobPattern(`[${pairs(9)}]`).expansions).toBe(1);
    expect(measureGlobPattern(`"${pairs(9)}"`).expansions).toBe(1);
  });

  it('小括號裡的逗號不切分，`}` 也收不了小括號', () => {
    expect(measureGlobPattern('{a,(b,c)}').expansions).toBe(2);
    expect(measureGlobPattern('{a,(}),b}').expansions).toBe(3);
  });
});

/** backend 替身：記下每次呼叫的方法、參數與 `this`。 */
function fakeBackend() {
  const calls: { method: string; args: unknown[]; self: unknown }[] = [];
  const backend = {
    marker: 'backend',
    glob(this: unknown, ...args: unknown[]) {
      calls.push({ method: 'glob', args, self: this });
      return Promise.resolve({ files: [] });
    },
    grep(this: unknown, ...args: unknown[]) {
      calls.push({ method: 'grep', args, self: this });
      return Promise.resolve({ matches: [] });
    },
  };
  return { backend, calls };
}

describe('包 backend 的那一層', () => {
  const shapes = {
    巢狀: nested(GLOB_PATTERN_MAX_DEPTH + 1),
    組合: pairs(9),
    範圍: `{1..${MAX + 1}}`,
  };

  for (const [shape, pattern] of Object.entries(shapes)) {
    it(`${shape}超過上限：glob 回錯誤，backend 一次都沒叫`, async () => {
      const { backend, calls } = fakeBackend();
      const limited = limitGlobPatterns(backend);
      expect(await limited.glob(pattern, '/')).toEqual({ error: GLOB_PATTERN_TOO_COMPLEX });
      expect(calls).toEqual([]);
    });
  }

  it('上限之內原樣轉交，參數與 `this` 不變；其餘方法不看', async () => {
    const { backend, calls } = fakeBackend();
    const limited = limitGlobPatterns(backend);
    await limited.glob('**/*.{ts,tsx}', '/src');
    await limited.grep('needle', '/', pairs(9), null);
    expect(calls).toEqual([
      { method: 'glob', args: ['**/*.{ts,tsx}', '/src'], self: backend },
      { method: 'grep', args: ['needle', '/', pairs(9), null], self: backend },
    ]);
    expect(limited.marker).toBe('backend');
  });
});

/**
 * 子行程的本體：基座的 `CompositeBackend` 在 `/plugin/` 掛一個 `FilesystemBackend`（插件用 `backend.mount()` 掛上的形狀），
 * 外面包 {@link limitGlobPatterns}（同 `foldRegistry`），印出 `glob` 的結果。
 */
const CHILD = `
import { CompositeBackend, FilesystemBackend, StateBackend } from 'deepagents';
const [moduleUrl, rootDir, pattern] = process.argv.slice(1);
const { limitGlobPatterns } = await import(moduleUrl);
const mounted = new CompositeBackend(new StateBackend(), {
  '/plugin/': new FilesystemBackend({ rootDir, virtualMode: true }),
});
process.stdout.write(JSON.stringify(await limitGlobPatterns(mounted).glob(pattern, '/plugin/')));
`;

/** 子行程的 V8 heap 上限（MB）。拿掉上限時 `{1..900}{1..900}` 在這裡一定撐不住。 */
const CHILD_HEAP_MB = 128;

interface ChildRun {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * 小 heap 的子行程跑一次 `glob`。
 *
 * @param rootDir - `FilesystemBackend` 的根。
 * @param pattern - 送進 `glob` 的 pattern。
 * @returns 結束碼、訊號與輸出。
 */
function runChild(rootDir: string, pattern: string): Promise<ChildRun> {
  const moduleUrl = new URL('./glob-pattern-limit.ts', import.meta.url).href;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        `--max-old-space-size=${CHILD_HEAP_MB}`,
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        CHILD,
        moduleUrl,
        rootDir,
        pattern,
      ],
      // `-e` 腳本裡的 `deepagents` 與 `--import tsx` 從 cwd 解析，所以 cwd 要在本套件。
      { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

describe('子行程：插件掛上的 FilesystemBackend', () => {
  let rootDir = '';

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'nexus-glob-limit-'));
    await writeFile(join(rootDir, 'a.txt'), 'hi');
  });

  afterAll(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('對照：上限之內，真的 fast-glob 找得到檔', async () => {
    const run = await runChild(rootDir, '*.txt');
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ files: [{ path: '/plugin/a.txt' }] });
  }, 60_000);

  // 拿掉上限時，fast-glob 的大括號展開在這個 heap 裡 OOM，子行程不是 0 結束，這條就紅。
  it(`\`{1..900}{1..900}\`：${CHILD_HEAP_MB} MB 的 heap 照常結束，拿到固定的工具錯誤`, async () => {
    const run = await runChild(rootDir, '{1..900}{1..900}');
    expect({ code: run.code, signal: run.signal }).toEqual({ code: 0, signal: null });
    expect(JSON.parse(run.stdout)).toEqual({ error: GLOB_PATTERN_TOO_COMPLEX });
    expect(run.stderr).toBe('');
  }, 60_000);
});
