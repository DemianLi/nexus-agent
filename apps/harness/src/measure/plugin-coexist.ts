/**
 * 同一個 plugin 的兩個版本能不能在同一個行程裡並存，以及每「更新」一次會多留多少記憶體——
 * [#1139](https://github.com/DemianLi/nexus-agent/issues/1139)，後台不停機更新的前置驗證。
 *
 * 走的是**產品路徑**：`resolveEntryModule`（出貨載入器真的呼叫的那一個）加 `loadPlugins`，在 `tsx` 底下跑
 * （`serve`／`cli` 的真實啟動方式，沒有 `dist/`）。夾具是一顆照真實形狀生出來的 plugin：一個入口、一個帶模組層級
 * 狀態的輔助檔、一個可調大小的壓艙檔，選配一份**自己版本目錄底下的 `zod`**（模擬新版連同自己的 `node_modules` 一起裝）。
 *
 * 兩種載入方式：
 *
 * - `dir`：`<root>/dir/<version>/index.ts`，每個版本一份完整目錄，用絕對路徑的 file URL `import()`。
 * - `query`：同一個檔，網址後面加 `?v=<n>`。只有那個檔本身重新求值，**它靜態相依的檔仍然共用**。
 *
 * 夾具放在 `/var/tmp` 的 realpath（不是 `os.tmpdir()`）：`assertPrivateModule` 要求祖先鏈只有自己寫得動，
 * macOS 的 `$TMPDIR` 底下那條不一定過；macOS 的 `/var/tmp` 是 symlink，要用它的 realpath（`/private/var/tmp`）才不會被比對絆倒。
 *
 * @module
 */

import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import v8 from 'node:v8';
import vm from 'node:vm';
import { tool } from '@langchain/core/tools';
import { loadPlugins } from '@nexus/core';
import type { LoadResult } from '@nexus/core';
import { z } from 'zod';
import { resolveEntryModule } from '../plugin-config.js';

export type LoadMode = 'dir' | 'query';
/** `module`：入口檔副檔名。 */
export type Ext = 'ts' | 'mjs';

export interface FixtureOptions {
  readonly mode: LoadMode;
  readonly ext: Ext;
  /** 版本標籤，`dir` 模式每個一個目錄；`query` 模式只用來決定 `?v=` 的值。 */
  readonly versions: readonly string[];
  /** 壓艙檔的原始碼大小（KB）。真實 plugin 的 `src/` 在 100–300 KB（含測試）。 */
  readonly ballastKb: number;
  /** 每個版本目錄底下再放一份完整的 `zod`（只有 `dir` 模式有意義）。 */
  readonly privateZod: boolean;
}

/** 一個版本的入口網址，給 `resolveEntryModule` 的 `name`。 */
export interface Fixture {
  readonly root: string;
  readonly urlOf: (version: string) => string;
  readonly cleanup: () => Promise<void>;
}

/** `/var/tmp` 的 realpath：macOS 上是 `/private/var/tmp`（symlink），Linux 上就是它自己。 */
const FIXTURE_PARENT = await realpath('/var/tmp');

/** 壓艙檔：許多不同的小函式加一張字串表，V8 要為每個函式留字節碼與共享資訊。 */
function ballastSource(kb: number, seed: string): string {
  const lines: string[] = [`export const BALLAST_SEED = ${JSON.stringify(seed)};`];
  const strings: string[] = [];
  let size = 0;
  for (let i = 0; size < kb * 1024; i += 1) {
    const fn =
      `export function fn${String(i)}(a, b) {\n` +
      `  const k = a * ${String(i + 3)} + b - ${String(i % 7)};\n` +
      `  if (k > ${String(i * 31)}) return k % ${String(i + 11)};\n` +
      `  return String(k) + ${JSON.stringify(`${seed}-${String(i)}`)};\n}\n`;
    lines.push(fn);
    strings.push(`${seed}-label-${String(i)}-${'x'.repeat(24)}`);
    size += fn.length + strings[strings.length - 1]!.length + 4;
  }
  lines.push(`export const BALLAST = ${JSON.stringify(strings)};`);
  return lines.join('\n');
}

const HELPER = (version: string): string => `
export const STATE = { version: ${JSON.stringify(version)}, calls: 0, ticks: 0 };
export function bump() { STATE.calls += 1; return STATE.calls; }
`;

const INDEX = (ext: Ext, version: string, withZod: boolean): string => `
import { STATE, bump } from './helper.${ext}';
import { BALLAST } from './ballast.${ext}';
${withZod ? "import { z } from 'zod';\nconst SHAPE = z.object({ n: z.number() }).strict();" : 'const SHAPE = null;'}
export default {
  name: 'probe',
  apply(registry, config) {
    const timer = setInterval(() => { STATE.ticks += 1; }, 10);
    timer.unref();
    registry.lifecycle.onDispose(() => { clearInterval(timer); });
    registry.tools.register(config.makeTool('probe_who', () => JSON.stringify({
      url: import.meta.url,
      version: ${JSON.stringify(version)},
      stateVersion: STATE.version,
      calls: bump(),
      ticks: STATE.ticks,
      ballast: BALLAST.length,
      zod: SHAPE === null ? null : SHAPE.safeParse({ n: 1 }).success,
    })));
  },
};
`;

/** 在 `/var/tmp` 底下生一份夾具。 */
export async function makeFixture(options: FixtureOptions): Promise<Fixture> {
  const root = await mkdtemp(join(FIXTURE_PARENT, 'nexus-coexist-'));
  const zodDir = options.privateZod
    ? join(await realpath(join(import.meta.dirname, '../../node_modules/zod')))
    : undefined;
  const write = async (dir: string, version: string): Promise<void> => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `helper.${options.ext}`), HELPER(version));
    await writeFile(join(dir, `ballast.${options.ext}`), ballastSource(options.ballastKb, version));
    await writeFile(
      join(dir, `index.${options.ext}`),
      INDEX(options.ext, version, zodDir !== undefined),
    );
    await writeFile(join(dir, 'package.json'), '{"type":"module"}');
    if (zodDir !== undefined)
      await cp(zodDir, join(dir, 'node_modules', 'zod'), { recursive: true });
  };
  if (options.mode === 'dir') {
    for (const version of options.versions) await write(join(root, 'dir', version), version);
  } else {
    // query 模式只有一份檔；它的版本標籤固定，`?v=` 才是區分。
    await write(join(root, 'query'), 'query');
  }
  const urlOf = (version: string): string =>
    options.mode === 'dir'
      ? pathToFileURL(join(root, 'dir', version, `index.${options.ext}`)).href
      : `${pathToFileURL(join(root, 'query', `index.${options.ext}`)).href}?v=${version}`;
  return {
    root,
    urlOf,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** 一個「thread」：載入一個版本，回傳 registry 的 handle 與呼叫它那顆工具的方式。 */
export interface Thread {
  readonly result: LoadResult;
  readonly invoke: () => Promise<Record<string, unknown>>;
  readonly dispose: () => Promise<void>;
}

/** 照產品路徑組一個 thread：`resolveEntryModule` → `loadPlugins`。 */
export async function openThread(url: string): Promise<Thread> {
  const entry = await resolveEntryModule({
    name: url,
    config: {
      makeTool: (name: string, run: () => string) =>
        tool(run, { name, description: '回報被哪個版本的程式碼服務', schema: z.object({}) }),
    },
  });
  const result = await loadPlugins([entry]);
  const resolved = result.registry.tools.resolve('probe_who');
  if (resolved === undefined) throw new Error('probe_who 沒有註冊');
  return {
    result,
    invoke: async () =>
      JSON.parse(String(await resolved.value.invoke({}))) as Record<string, unknown>,
    dispose: () => result.dispose(),
  };
}

export interface CoexistReport {
  readonly mode: LoadMode;
  readonly ext: Ext;
  /** 兩個版本的 plugin 物件不是同一個。 */
  readonly distinctPluginObjects: boolean;
  /** 兩個 thread 並行呼叫，各自拿到自己版本的回應。 */
  readonly eachThreadServedByOwnVersion: boolean;
  /** 模組層級狀態不共用：A 呼叫的次數沒有被算到 B 上。 */
  readonly moduleStateIsolated: boolean;
  /** A 結束（dispose）之後，舊版的計時器停了、也沒有任何程式碼再被呼叫。 */
  readonly oldVersionQuietAfterDispose: boolean;
  /** 原始觀察，附在 issue 上。 */
  readonly evidence: Record<string, unknown>;
}

/** 並存、各被不同 thread 使用、舊版不再被呼叫——三件事一次量。 */
export async function verifyCoexistence(
  options: Omit<FixtureOptions, 'versions'>,
): Promise<CoexistReport> {
  const fixture = await makeFixture({ ...options, versions: ['v1', 'v2'] });
  try {
    const a = await openThread(fixture.urlOf('v1'));
    const b = await openThread(fixture.urlOf('v2'));
    // 並行呼叫：A 兩次、B 一次，交錯。
    const [a1, b1, a2] = await Promise.all([a.invoke(), b.invoke(), a.invoke()]);
    // 正對照：兩顆都還活著、等一下，B 的計時器要真的在跳，後面「A 之後不跳了」才有意義。
    await new Promise((resolve) => setTimeout(resolve, 60));
    const bTicksLive = (await b.invoke()).ticks as number;
    const pluginA = a.result.entries[0]!.plugin;
    const pluginB = b.result.entries[0]!.plugin;
    await a.dispose();
    // 舊版的計時器（10 ms 一跳）停了嗎：等一段時間，看 STATE.ticks 還長不長。這裡借 B 的呼叫看 B 自己的，
    // 看 A 的得再呼叫 A——但 A 已經 dispose，工具還握在手上，呼叫它不算「被再呼叫」，只是量它的計時器。
    const ticksRightAfter = (await a.invoke()).ticks as number;
    await new Promise((resolve) => setTimeout(resolve, 120));
    const callsBeforeB = (await b.invoke()).calls as number;
    const ticksLater = (await a.invoke()).ticks as number;
    const callsAfterB = (await b.invoke()).calls as number;
    await b.dispose();
    const evidence = {
      a1,
      a2,
      b1,
      bTicksLive,
      ticksRightAfter,
      ticksLater,
      callsBeforeB,
      callsAfterB,
    };
    return {
      mode: options.mode,
      ext: options.ext,
      distinctPluginObjects: pluginA !== pluginB,
      // 入口檔自己的 `import.meta.url` 帶著載入時的網址（含 `?v=`），兩種模式都分得出是哪一次載入服務的。
      eachThreadServedByOwnVersion:
        String(a1.url) === fixture.urlOf('v1') &&
        String(a2.url) === fixture.urlOf('v1') &&
        String(b1.url) === fixture.urlOf('v2'),
      // B 的第一次呼叫就是它自己的第 1 次，A 的第二次呼叫是它的第 2 次；輔助檔共用的話這兩個數字會被對方墊高。
      moduleStateIsolated: b1.calls === 1 && a2.calls === 2,
      oldVersionQuietAfterDispose: bTicksLive > 0 && ticksLater === ticksRightAfter,
      evidence,
    };
  } finally {
    await fixture.cleanup();
  }
}

/** 單次取樣。 */
export interface MemorySample {
  readonly update: number;
  readonly heapUsedMb: number;
  readonly rssMb: number;
  readonly externalMb: number;
  readonly codeSpaceMb: number;
}

export interface AccumulationOptions extends Omit<FixtureOptions, 'versions'> {
  /** 更新幾次（載入幾個不同版本）。 */
  readonly updates: number;
  /** 每幾次取一次樣。 */
  readonly sampleEvery: number;
  /** 對照組：每次都載同一個網址（模組快取命中），預期零累積，用來證明量具量得到。 */
  readonly sameUrlControl?: boolean;
}

const MB = 1024 * 1024;

function forcedGc(): () => void {
  v8.setFlagsFromString('--expose-gc');
  return vm.runInNewContext('gc') as () => void;
}

/** 連續「更新」N 次，每次載入、呼叫一次、dispose，量強制回收之後的堆與 RSS。 */
export async function measureAccumulation(options: AccumulationOptions): Promise<MemorySample[]> {
  const versions = Array.from({ length: options.updates }, (_, i) => `v${String(i + 1)}`);
  const fixture = await makeFixture({ ...options, versions });
  const gc = forcedGc();
  const sample = (update: number): MemorySample => {
    gc();
    gc();
    const usage = process.memoryUsage();
    const code = v8.getHeapSpaceStatistics().find((space) => space.space_name === 'code_space');
    return {
      update,
      heapUsedMb: usage.heapUsed / MB,
      rssMb: usage.rss / MB,
      externalMb: usage.external / MB,
      codeSpaceMb: (code?.space_used_size ?? 0) / MB,
    };
  };
  try {
    // 第 0 列是暖機後的基線：先載一次第一個版本（把共用的 @nexus/core、langchain 等相依與 tsx 的快取熱起來），
    // 再量；之後每次都換一個**新**版本。
    const warm = await openThread(fixture.urlOf(versions[0]!));
    await warm.invoke();
    await warm.dispose();
    const samples: MemorySample[] = [sample(0)];
    for (let i = 1; i <= options.updates; i += 1) {
      const version = options.sameUrlControl === true ? versions[0]! : versions[i - 1]!;
      const thread = await openThread(fixture.urlOf(version));
      await thread.invoke();
      await thread.dispose();
      if (i % options.sampleEvery === 0 || i === options.updates) samples.push(sample(i));
    }
    return samples;
  } finally {
    await fixture.cleanup();
  }
}

/** 最小平方線性擬合：每次更新增加多少（斜率）與擬合優度。 */
export function fitSlope(
  samples: readonly MemorySample[],
  pick: (s: MemorySample) => number,
): {
  perUpdateMb: number;
  r2: number;
} {
  const xs = samples.map((s) => s.update);
  const ys = samples.map(pick);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
    syy += (ys[i]! - my) ** 2;
  }
  return {
    perUpdateMb: sxx === 0 ? 0 : sxy / sxx,
    r2: sxx === 0 || syy === 0 ? 1 : (sxy * sxy) / (sxx * syy),
  };
}
