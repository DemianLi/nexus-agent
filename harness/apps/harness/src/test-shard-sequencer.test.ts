/**
 * `test-shard-sequencer.ts`：資料只影響分得平不平均，不影響跑哪些檔（#2093）。
 *
 * 「每個檔恰好落在一片」對四種資料各驗一次：讀得懂的、讀不懂的、缺新檔的、有一份讀不到（子目錄）的；目錄不存在時要跟 vitest 內建的雜湊切法一模一樣。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BaseSequencer } from 'vitest/node';
import type { TestSpecification, Vitest } from 'vitest/node';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DURATIONS_DIR_ENV,
  DurationSequencer,
  estimate,
  inputDigest,
  partition,
  readDurations,
} from './test-shard-sequencer.js';

const ROOT = '/repo/apps/harness';
const PATHS = Array.from({ length: 40 }, (_, i) => `src/f${String(i).padStart(2, '0')}.test.ts`);

const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 一個耗時目錄，每個參數一份檔。 */
function durationsDir(...files: string[]): string {
  const dir = mkdtempSync('/var/tmp/nexus-shard-durations-');
  temporary.push(dir);
  files.forEach((text, i) => {
    writeFileSync(join(dir, `results-${String(i + 1)}.json`), text);
  });
  return dir;
}

const results = (entries: Record<string, number>): string =>
  JSON.stringify({
    version: '4.1.11',
    results: Object.entries(entries).map(([path, duration]) => [
      `:${path}`,
      { duration, failed: false },
    ]),
  });

/** 跟 CI 一樣：兩片各建一個 sequencer、各自切，回兩片的檔。 */
async function shards(paths: readonly string[], count = 2): Promise<string[][]> {
  const files = paths.map((path) => ({ moduleId: `${ROOT}/${path}` }) as TestSpecification);
  const out: string[][] = [];
  for (let index = 1; index <= count; index++) {
    const ctx = { config: { root: ROOT, shard: { index, count } } } as unknown as Vitest;
    const picked = await new DurationSequencer(ctx).shard(files);
    out.push(picked.map((file) => file.moduleId.slice(ROOT.length + 1)));
  }
  return out;
}

function expectExactCover(split: string[][], paths: readonly string[]): void {
  const all = split.flat();
  expect(all).toHaveLength(paths.length);
  expect(new Set(all)).toEqual(new Set(paths));
}

/** 前三個檔各 60 秒、其餘約 1.0–2.4 秒的固定耗時表：大檔夠大，切錯就看得出兩片不均。 */
const uneven = Object.fromEntries(PATHS.map((path, i) => [path, i < 3 ? 60_000 : 1_000 + i * 37]));

describe('partition', () => {
  it('每個檔恰好在一片：聯集是全部、交集是空的；重複的路徑只算一次', () => {
    const cost = estimate(PATHS, new Map(Object.entries(uneven)));
    for (const count of [1, 2, 3, 7]) {
      const split = partition([...PATHS, PATHS[0] ?? ''], cost, count);
      expect(split).toHaveLength(count);
      expectExactCover(split, PATHS);
    }
  });

  it('看耗時：三個 60 秒的大檔不會擠在同一片，兩片合計差不到最大的那一個檔', () => {
    const cost = estimate(PATHS, new Map(Object.entries(uneven)));
    const split = partition(PATHS, cost, 2);
    const totals = split.map((paths) =>
      paths.reduce((sum, path) => sum + (cost.get(path) ?? 0), 0),
    );
    expect(Math.abs((totals[0] ?? 0) - (totals[1] ?? 0))).toBeLessThan(60_000);
    expect(
      split.map((paths) => paths.filter((path) => (cost.get(path) ?? 0) === 60_000).length).sort(),
    ).toEqual([1, 2]);
  });

  it('耗時一樣的檔：不論輸入順序，切法都一樣（兩片各自切，不能因順序不同而分歧）', () => {
    const cost = new Map(PATHS.map((path) => [path, 1_000]));
    expect(partition([...PATHS].reverse(), cost, 2)).toEqual(partition(PATHS, cost, 2));
  });

  it('沒有資料的檔照已知耗時的中位數估', () => {
    const cost = estimate(
      ['a', 'b', 'c', 'new'],
      new Map([
        ['a', 10],
        ['b', 30],
        ['c', 20],
      ]),
    );
    expect(cost.get('new')).toBe(20);
  });
});

describe('readDurations', () => {
  it('合併多份、去掉 project 前綴；同一個檔取較長的；讀不懂的那份跳過', () => {
    const dir = durationsDir(
      results({ 'src/a.test.ts': 5 }),
      results({ 'src/a.test.ts': 9, 'src/b.test.ts': 2 }),
      '{',
      JSON.stringify({ version: '4.1.11' }),
      JSON.stringify({ results: [[':src/c.test.ts', { duration: 'slow' }]] }),
    );
    const { durations, skipped } = readDurations(dir);
    expect(Object.fromEntries(durations)).toEqual({ 'src/a.test.ts': 9, 'src/b.test.ts': 2 });
    expect(skipped).toEqual(['results-3.json', 'results-4.json', 'results-5.json']);
  });

  it('目錄不存在：沒有資料，也不丟錯', () => {
    expect(readDurations('/var/tmp/nexus-shard-durations-does-not-exist').durations.size).toBe(0);
  });
});

describe('DurationSequencer.shard（兩片各切一次，跟 CI 一樣）', () => {
  it('讀得懂：每個檔恰好在一片，三個大檔分到兩片；兩片印出同一個輸入摘要', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv(DURATIONS_DIR_ENV, durationsDir(results(uneven)));
    const split = await shards(PATHS);
    expectExactCover(split, PATHS);
    expect(split.every((paths) => paths.some((path) => (uneven[path] ?? 0) === 60_000))).toBe(true);
    const digests = log.mock.calls.map(
      ([line]) => /輸入摘要 ([0-9a-f]{12})$/.exec(String(line))?.[1],
    );
    expect(digests).toHaveLength(2);
    expect(digests[0]).toBeDefined();
    expect(digests[1]).toBe(digests[0]);
    log.mockRestore();
  });

  it('輸入摘要：檔或耗時差一個就不同，順序無關', () => {
    const base = new Map([
      ['a', 1],
      ['b', 2],
    ]);
    expect(inputDigest(new Map([...base].reverse()))).toBe(inputDigest(base));
    expect(inputDigest(new Map([...base, ['c', 0]]))).not.toBe(inputDigest(base));
    expect(
      inputDigest(
        new Map([
          ['a', 1],
          ['b', 3],
        ]),
      ),
    ).not.toBe(inputDigest(base));
  });

  it('快取不存在：跟 vitest 內建的雜湊切法一模一樣', async () => {
    vi.stubEnv(DURATIONS_DIR_ENV, '/var/tmp/nexus-shard-durations-does-not-exist');
    const split = await shards(PATHS);
    vi.unstubAllEnvs();
    const files = PATHS.map((path) => ({ moduleId: `${ROOT}/${path}` }) as TestSpecification);
    const hashed = await Promise.all(
      [1, 2].map(async (index) => {
        const ctx = { config: { root: ROOT, shard: { index, count: 2 } } } as unknown as Vitest;
        return (await new BaseSequencer(ctx).shard(files)).map((file) =>
          file.moduleId.slice(ROOT.length + 1),
        );
      }),
    );
    expect(split).toEqual(hashed);
    expectExactCover(split, PATHS);
  });

  it('讀不懂：退回雜湊切法，每個檔照樣恰好在一片', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv(
      DURATIONS_DIR_ENV,
      durationsDir('not json', JSON.stringify({ results: [['x', {}]] })),
    );
    expectExactCover(await shards(PATHS), PATHS);
    expect(warn).toHaveBeenCalledTimes(4);
    warn.mockRestore();
  });

  it('缺新檔：資料裡沒有的檔照樣分到其中一片', async () => {
    const old = Object.fromEntries(Object.entries(uneven).slice(0, 30));
    vi.stubEnv(DURATIONS_DIR_ENV, durationsDir(results({ ...old, 'src/deleted.test.ts': 99_000 })));
    expectExactCover(await shards(PATHS), PATHS);
  });

  it('讀不到的那一份（名字像 .json 的子目錄）跳過，不丟錯', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = durationsDir(results(uneven));
    mkdirSync(join(dir, 'nested.json'));
    vi.stubEnv(DURATIONS_DIR_ENV, dir);
    expectExactCover(await shards(PATHS), PATHS);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('nested.json'));
    warn.mockRestore();
  });
});

describe('DurationSequencer.sort', () => {
  it('片內由長到短', async () => {
    vi.stubEnv(
      DURATIONS_DIR_ENV,
      durationsDir(results({ 'src/a.test.ts': 1, 'src/b.test.ts': 3, 'src/c.test.ts': 2 })),
    );
    const ctx = { config: { root: ROOT } } as unknown as Vitest;
    const files = ['a', 'b', 'c'].map(
      (name) => ({ moduleId: `${ROOT}/src/${name}.test.ts` }) as TestSpecification,
    );
    const sorted = await new DurationSequencer(ctx).sort(files);
    expect(sorted.map((file) => file.moduleId.slice(ROOT.length + 1))).toEqual([
      'src/b.test.ts',
      'src/c.test.ts',
      'src/a.test.ts',
    ]);
  });
});
