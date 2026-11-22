/**
 * harness 測試的分片與排序看上一輪的耗時（[#2093](https://github.com/DemianLi/nexus-agent/issues/2093)）。
 *
 * vitest 的 `--shard` 照檔名雜湊切、不看耗時，兩片不均（量測見 #2093）；它自己排序時會看結果快取（`results.json`），但 CI 每次都是乾淨的，
 * 沒有快取就退回看檔案大小。這裡讀 {@link DURATIONS_DIR_ENV} 指到的目錄裡的 `results.json`（vitest 自己寫的格式，合併後那一輪各片存一份，
 * 見 `.github/workflows/ci.yml` 的 test-harness），用來：
 *
 * - **分片**：耗時由長到短，每個檔放進目前合計最少的那一片。兩片讀同一份資料、跑同一個算法，所以切法一致。
 * - **排序**：片內由長到短，最慢的檔先開跑，不會壓在最後拖長整片。
 *
 * 資料只影響分得平不平均，不影響跑哪些檔：沒有資料的檔（新加的）照這一輪有資料的檔的耗時中位數估（見 {@link estimate}）；
 * 目錄沒設、讀不到、裡面沒有一份讀得懂的，退回 vitest 內建的雜湊切法與排序（排序時「上一輪失敗的檔先跑」也照內建）；
 * 用耗時排序時只看長短。每個檔恰好落在一片由 `partition` 保證，`test-shard-sequencer.test.ts` 釘住。
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { BaseSequencer } from 'vitest/node';
import type { TestSpecification } from 'vitest/node';

/** 放上一輪 `results.json` 的目錄；CI 的 test-harness 設它，本機不設就照 vitest 內建的做法。 */
export const DURATIONS_DIR_ENV = 'NEXUS_TEST_DURATIONS_DIR';

/**
 * 讀 `dir` 底下每一份 `.json`（vitest `results.json` 的格式：`{ results: [["<project>:<相對路徑>", { duration }], …] }`），
 * 合成「相對路徑 → 毫秒」。讀不到或讀不懂的那一份跳過並記進 `skipped`；同一個檔出現在兩份裡取較長的。
 * @param dir 目錄；讀不到（含不存在）時當成沒有資料。
 * @returns 耗時表與跳過的檔名。
 */
export function readDurations(dir: string): { durations: Map<string, number>; skipped: string[] } {
  const durations = new Map<string, number>();
  const skipped: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return { durations, skipped };
  }
  for (const name of names.sort()) {
    let entries: [string, number][] | undefined;
    try {
      entries = parseResults(readFileSync(join(dir, name), 'utf8'));
    } catch {
      entries = undefined;
    }
    if (entries === undefined) {
      skipped.push(name);
      continue;
    }
    for (const [path, ms] of entries) durations.set(path, Math.max(ms, durations.get(path) ?? 0));
  }
  return { durations, skipped };
}

function parseResults(text: string): [string, number][] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const results = (parsed as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return undefined;
  const entries: [string, number][] = [];
  for (const entry of results as unknown[]) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') return undefined;
    const duration = (entry[1] as { duration?: unknown } | null)?.duration;
    if (typeof duration !== 'number' || !Number.isFinite(duration)) return undefined;
    // key 是 `<project>:<相對路徑>`，harness 沒有具名的 project，前綴是空字串。
    entries.push([entry[0].slice(entry[0].indexOf(':') + 1), Math.max(duration, 0)]);
  }
  return entries;
}

/**
 * 每個檔的估計耗時：有資料用資料；沒有的照 `paths` 裡有資料那些檔的耗時中位數（偶數個取較大的中間值），全都沒有就是 0。
 * @param paths 這一輪要跑的檔（相對路徑）。
 * @param durations 上一輪的耗時。
 * @returns 相對路徑 → 估計毫秒。
 */
export function estimate(
  paths: readonly string[],
  durations: ReadonlyMap<string, number>,
): Map<string, number> {
  const known = paths.flatMap((path) => {
    const ms = durations.get(path);
    return ms === undefined ? [] : [ms];
  });
  known.sort((a, b) => a - b);
  const fallback = known.length === 0 ? 0 : (known[Math.floor(known.length / 2)] ?? 0);
  return new Map(paths.map((path) => [path, durations.get(path) ?? fallback]));
}

/** 由長到短；一樣長照路徑，讓兩片排出來的順序相同。 */
const longestFirst =
  (cost: ReadonlyMap<string, number>) =>
  (a: string, b: string): number =>
    (cost.get(b) ?? 0) - (cost.get(a) ?? 0) || (a < b ? -1 : a > b ? 1 : 0);

/**
 * 照估計耗時切成 `count` 片：由長到短，每個檔放進目前合計最少的那一片（一樣少的取編號小的）。
 * @param paths 這一輪要跑的檔。
 * @param cost 每個檔的估計耗時（{@link estimate}）。
 * @param count 片數。
 * @returns 每一片的檔；每個檔恰好在其中一片。
 */
export function partition(
  paths: readonly string[],
  cost: ReadonlyMap<string, number>,
  count: number,
): string[][] {
  const shards = Array.from({ length: count }, () => ({ total: 0, paths: [] as string[] }));
  for (const path of [...new Set(paths)].sort(longestFirst(cost))) {
    const lightest = shards.reduce((min, shard) => (shard.total < min.total ? shard : min));
    lightest.paths.push(path);
    lightest.total += cost.get(path) ?? 0;
  }
  return shards.map((shard) => shard.paths);
}

/**
 * 分片的整份輸入（每個檔與它的估計耗時）的 SHA-256 前 12 碼。
 * @param cost {@link estimate} 的結果。
 * @returns 十六進位字串。
 */
export function inputDigest(cost: ReadonlyMap<string, number>): string {
  const entries = [...cost].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 12);
}

/** 接進 `vitest.config.ts` 的 `sequence.sequencer`。 */
export class DurationSequencer extends BaseSequencer {
  #cost(files: readonly TestSpecification[]): Map<string, number> | undefined {
    const dir = process.env[DURATIONS_DIR_ENV];
    if (dir === undefined || dir === '') return undefined;
    const { durations, skipped } = readDurations(dir);
    for (const name of skipped) console.warn(`[${DURATIONS_DIR_ENV}] 讀不懂 ${name}，跳過`);
    if (durations.size === 0) return undefined;
    return estimate(
      files.map((file) => this.#path(file)),
      durations,
    );
  }

  #path(file: TestSpecification): string {
    return relative(this.ctx.config.root, file.moduleId).split('\\').join('/');
  }

  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { index, count } = this.ctx.config.shard ?? { index: 1, count: 1 };
    const cost = this.#cost(files);
    if (cost === undefined) {
      const picked = await super.shard(files);
      console.log(
        `[分片 ${String(index)}/${String(count)}] 沒有耗時資料，照檔名雜湊切：本片 ${String(picked.length)} 個檔`,
      );
      return picked;
    }
    const mine = new Set(partition([...cost.keys()], cost, count)[index - 1]);
    const picked = files.filter((file) => mine.has(this.#path(file)));
    // 切法只由這份輸入決定；各片印出來的摘要相同，就是用同一份輸入切的。
    console.log(
      `[分片 ${String(index)}/${String(count)}] 看耗時切：本片 ${String(picked.length)} 個檔，全部 ${String(cost.size)} 個，` +
        `輸入摘要 ${inputDigest(cost)}`,
    );
    return picked;
  }

  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const cost = this.#cost(files);
    if (cost === undefined) return super.sort(files);
    const order = longestFirst(cost);
    return [...files].sort((a, b) => order(this.#path(a), this.#path(b)));
  }
}
