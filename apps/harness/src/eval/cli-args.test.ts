/**
 * 兩個 eval 進入點共用的命令列解析。
 *
 * **這些斷言以前寫不出來。** 解析邏輯原本住在 `compare-cli.ts`，而那個檔尾巴有一行
 * top-level `await main(...)` —— `import` 它就會當場開始跑一輪真的比較（要 key、要錢、
 * 要幾十分鐘）。搬到 `cli-args.ts` 之後才有辦法在 CI 裡零憑證地測。
 */

import { describe, expect, it } from 'vitest';
import { parseCases, parseModels, parseSamples } from './cli-args.js';
import { BENCHMARK } from './dataset.js';

const MODELS = [
  { label: 'a', modelId: 'x/a' },
  { label: 'b', modelId: 'x/b' },
  { label: 'c', modelId: 'x/c' },
] as const;

describe('parseSamples', () => {
  it('沒給就是 1', () => {
    expect(parseSamples([])).toBe(1);
  });

  it('讀得到正整數', () => {
    expect(parseSamples(['--samples', '6'])).toBe(6);
  });

  it.each([['0'], ['-1'], ['1.5'], ['abc'], ['']])('%s 不是正整數，當場拋', (raw) => {
    expect(() => parseSamples(['--samples', raw])).toThrow(/正整數/);
  });

  it('旗標在最後、沒帶值也拋 —— 不要默默當成 1 跑完整輪', () => {
    expect(() => parseSamples(['--samples'])).toThrow(/正整數/);
  });
});

describe('parseCases', () => {
  it('沒給就是整份資料集', () => {
    expect(parseCases([])).toEqual(BENCHMARK);
  });

  it('認不得的 id 當場拋，不默默略過', () => {
    // 默默略過的話會跑了個比預期少的子集，而報表上看不出來少了哪一題。
    expect(() => parseCases(['--cases', 'echo-once,nope'])).toThrow(/認不得/);
  });

  it('拋出來的訊息要指名是哪個 id 打錯了', () => {
    expect(() => parseCases(['--cases', 'nope'])).toThrow(/nope/);
  });

  it('依資料集的順序跑，不依打字的順序', () => {
    // 報表的列順序不該隨手打的參數而變。
    const reversed = [...BENCHMARK]
      .map((entry) => entry.id)
      .reverse()
      .join(',');
    expect(parseCases(['--cases', reversed]).map((entry) => entry.id)).toEqual(
      BENCHMARK.map((entry) => entry.id),
    );
  });

  it('吃得下空白', () => {
    expect(parseCases(['--cases', ' echo-once , write-then-read ']).map((c) => c.id)).toEqual([
      'echo-once',
      'write-then-read',
    ]);
  });

  it('後面接著另一個旗標時拋，不把旗標當成 id', () => {
    expect(() => parseCases(['--cases', '--samples', '3'])).toThrow(/逗號/);
  });
});

describe('parseModels', () => {
  it('沒給就是全部', () => {
    expect(parseModels([], MODELS)).toEqual(MODELS);
  });

  it('挑得出子集', () => {
    expect(parseModels(['--models', 'a,c'], MODELS).map((m) => m.label)).toEqual(['a', 'c']);
  });

  it('依清單的順序，不依打字的順序', () => {
    expect(parseModels(['--models', 'c,a'], MODELS).map((m) => m.label)).toEqual(['a', 'c']);
  });

  it('認不得的短名當場拋 —— 理由同 --cases', () => {
    expect(() => parseModels(['--models', 'a,zzz'], MODELS)).toThrow(/zzz/);
  });

  it('後面接著另一個旗標時拋', () => {
    expect(() => parseModels(['--models', '--cases'], MODELS)).toThrow(/逗號/);
  });
});
