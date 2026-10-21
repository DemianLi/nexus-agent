/**
 * glob pattern 大括號上限的單元測試：量法（深度、組合、範圍、略過的字元、沒關的組，各附上限 ±1；長度上限；深度超過就停）
 * 與包 backend 的那一層（超過就不叫 backend）。經 `createNexusAgent` 的接線在 `apps/harness/src/glob-pattern-limit.test.ts`。
 */

import { describe, expect, it } from 'vitest';
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
