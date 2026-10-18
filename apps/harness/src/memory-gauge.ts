/**
 * serve 的**記憶體量具**（[#1490](https://github.com/DemianLi/nexus-agent/issues/1490)，「底座保險絲」第 3 級之前的量測卡）。
 *
 * **只讀、只講，不做任何動作**：不拒收、不逐出、不下架。讀三個來源，各自獨立，讀不到的那個明說「讀不到」與原因，**不回 0**
 * ——0 是一個答案，「不知道」不是：
 *
 * 1. **行程自己**：`process.memoryUsage()` 的 RSS 與 heap。到處讀得到。
 * 2. **容器上限**：Linux 的 cgroup。v2 讀 `memory.current`／`memory.max`，v1 讀 `memory.usage_in_bytes`／`memory.limit_in_bytes`；
 *    沒有 cgroup（macOS、沒掛 `/sys/fs/cgroup`）就是讀不到。`max`（v2）或一個大到不合理的數字（v1）是「沒設上限」，與讀不到分開講。
 * 3. **主機**：Linux 的 `/proc/meminfo` 的 `MemAvailable`（核心估的「不必換出就能給新程式用的量」）；沒有 `/proc/meminfo`
 *    才退到 `os.freemem()`，並在行裡標出是哪一種——macOS 的 `os.freemem()` 不含可回收的快取，會比實際少，兩種數字不能直接比。
 *
 * ## 偏離 dsh：產品需求超出 dsh
 *
 * dsh `1517a4db` **沒有執行期的記憶體監看**，並在背景工作准入的決策紀錄裡否決了行程級記憶體預算；它的記憶體只在 CI 量
 * （`scripts/run-memory-pressure-bench.ts`，無 swap 的 cgroup 模擬 4／8 GB 機器，`docs/defensive-patterns/general.zh.md:184`）。
 * 這支量具是 serve 跑在多人共用的內網主機上、需要知道「自己多大」和「主機還剩多少」才有的需求，登記為理由 2。
 * 它刻意只做 dsh 沒做的那一半——**看**；看了之後做什麼（第 0 級警告、第 3 級下架插件）等量測的數字出來由 demian 決定。
 *
 * @module
 */

import { readFile } from 'node:fs/promises';
import { freemem, totalmem } from 'node:os';

/** 一個來源的讀數：讀到了，或讀不到與原因。 */
export type Reading<T> =
  ({ readonly ok: true } & T) | { readonly ok: false; readonly reason: string };

/** 行程自己。 */
export interface ProcessMemory {
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
  readonly heapTotalBytes: number;
}

/** 容器上限（cgroup）。`limitBytes` 是 `null` 表示**讀到了、而且沒設上限**。 */
export interface CgroupMemory {
  readonly version: 1 | 2;
  readonly currentBytes: number;
  readonly limitBytes: number | null;
}

/** 主機。`source` 說明數字怎麼來的，兩種不能直接比。 */
export interface HostMemory {
  readonly source: 'MemAvailable' | 'os.freemem';
  readonly availableBytes: number;
  readonly totalBytes: number;
}

/** 一次讀數：三個來源各自獨立。 */
export interface MemoryReading {
  readonly process: ProcessMemory;
  readonly cgroup: Reading<CgroupMemory>;
  readonly host: Reading<HostMemory>;
}

/** 量具讀外界的縫，測試換掉。 */
export interface MemoryGaugeDeps {
  readonly readText: (path: string) => Promise<string>;
  readonly processMemory: () => ProcessMemory;
  readonly freemem: () => number;
  readonly totalmem: () => number;
}

/** cgroup v1 沒設上限時，`memory.limit_in_bytes` 是一個接近 2^63 的數字；超過它就當沒設。 */
const CGROUP_V1_UNLIMITED_FROM = 2 ** 60;

const defaultDeps: MemoryGaugeDeps = {
  readText: (path) => readFile(path, 'utf8'),
  processMemory: () => {
    const usage = process.memoryUsage();
    return {
      rssBytes: usage.rss,
      heapUsedBytes: usage.heapUsed,
      heapTotalBytes: usage.heapTotal,
    };
  },
  freemem,
  totalmem,
};

/** 錯誤的簡短原因（`ENOENT` 這類碼優先，沒有就用訊息）。 */
function reasonOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return error instanceof Error ? error.message : String(error);
}

/** 解一個檔案內容裡的非負整數（前後空白可有）；不是就回 `undefined`。 */
function parseBytes(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : undefined;
}

async function readCgroupV2(deps: MemoryGaugeDeps): Promise<Reading<CgroupMemory>> {
  let current: string;
  try {
    current = await deps.readText('/sys/fs/cgroup/memory.current');
  } catch (error: unknown) {
    return { ok: false, reason: reasonOf(error) };
  }
  const currentBytes = parseBytes(current);
  if (currentBytes === undefined) {
    return { ok: false, reason: 'memory.current 不是整數' };
  }
  let max: string;
  try {
    max = await deps.readText('/sys/fs/cgroup/memory.max');
  } catch (error: unknown) {
    return { ok: false, reason: `memory.max ${reasonOf(error)}` };
  }
  if (max.trim() === 'max') return { ok: true, version: 2, currentBytes, limitBytes: null };
  const limitBytes = parseBytes(max);
  if (limitBytes === undefined) return { ok: false, reason: 'memory.max 不是整數也不是 max' };
  return { ok: true, version: 2, currentBytes, limitBytes };
}

async function readCgroupV1(deps: MemoryGaugeDeps): Promise<Reading<CgroupMemory>> {
  let usage: string;
  try {
    usage = await deps.readText('/sys/fs/cgroup/memory/memory.usage_in_bytes');
  } catch (error: unknown) {
    return { ok: false, reason: reasonOf(error) };
  }
  const currentBytes = parseBytes(usage);
  if (currentBytes === undefined) {
    return { ok: false, reason: 'memory.usage_in_bytes 不是整數' };
  }
  let limit: string;
  try {
    limit = await deps.readText('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  } catch (error: unknown) {
    return { ok: false, reason: `memory.limit_in_bytes ${reasonOf(error)}` };
  }
  const raw = limit.trim();
  if (!/^\d+$/.test(raw)) return { ok: false, reason: 'memory.limit_in_bytes 不是整數' };
  // v1 的「沒設上限」是一個接近 2^63 的數字，可能超過 2^53，所以用 BigInt 比。
  const limitBytes = BigInt(raw) >= BigInt(CGROUP_V1_UNLIMITED_FROM) ? null : Number(raw);
  return { ok: true, version: 1, currentBytes, limitBytes };
}

/**
 * 讀 cgroup：先試 v2，v2 不在再試 v1。兩個都讀不到時，原因帶上 v2 那一個（現代 Linux 的常態），
 * 並註明 v1 也不在，免得管理者以為只試了一種。
 */
async function readCgroup(deps: MemoryGaugeDeps): Promise<Reading<CgroupMemory>> {
  const v2 = await readCgroupV2(deps);
  if (v2.ok) return v2;
  const v1 = await readCgroupV1(deps);
  if (v1.ok) return v1;
  return { ok: false, reason: `沒有 cgroup，v2：${v2.reason}；v1：${v1.reason}` };
}

/** 解 `/proc/meminfo` 裡 `Name:   12345 kB` 這種行的 kB 值，換成位元組。 */
function meminfoBytes(text: string, name: string): number | undefined {
  const line = text.split('\n').find((candidate) => candidate.startsWith(`${name}:`));
  if (line === undefined) return undefined;
  const match = /^\S+:\s+(\d+)\s*kB\s*$/.exec(line);
  if (match === null) return undefined;
  const kilobytes = Number(match[1]);
  return Number.isSafeInteger(kilobytes) ? kilobytes * 1024 : undefined;
}

async function readHost(deps: MemoryGaugeDeps): Promise<Reading<HostMemory>> {
  let text: string | undefined;
  try {
    text = await deps.readText('/proc/meminfo');
  } catch {
    text = undefined;
  }
  if (text !== undefined) {
    const available = meminfoBytes(text, 'MemAvailable');
    const total = meminfoBytes(text, 'MemTotal');
    if (available !== undefined && total !== undefined) {
      return { ok: true, source: 'MemAvailable', availableBytes: available, totalBytes: total };
    }
  }
  // 沒有 /proc/meminfo（macOS），或舊核心沒有 MemAvailable：退到 os.freemem()，並在讀數上標出來。
  try {
    return {
      ok: true,
      source: 'os.freemem',
      availableBytes: deps.freemem(),
      totalBytes: deps.totalmem(),
    };
  } catch (error: unknown) {
    return { ok: false, reason: reasonOf(error) };
  }
}

/**
 * 讀一次。三個來源各自接住自己的失敗，不會因為一個讀不到就整次失敗。
 *
 * @param deps - 讀外界的縫；省略即真的 `fs`、`process`、`os`。
 * @returns 三個來源的讀數。
 */
export async function readMemory(deps: MemoryGaugeDeps = defaultDeps): Promise<MemoryReading> {
  const [cgroup, host] = await Promise.all([readCgroup(deps), readHost(deps)]);
  return { process: deps.processMemory(), cgroup, host };
}

/** 位元組換成 MiB 字串，一位小數。 */
function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/**
 * 把一次讀數寫成一行日誌。三個來源寫在同一行，讀不到的那個寫「讀不到（原因）」。
 *
 * @param reading - {@link readMemory} 的結果。
 * @returns 一行文字，不含換行。
 */
export function formatMemoryLine(reading: MemoryReading): string {
  const proc = `行程 RSS ${mib(reading.process.rssBytes)}、heap ${mib(reading.process.heapUsedBytes)}／${mib(reading.process.heapTotalBytes)}`;
  const cgroup = reading.cgroup.ok
    ? `cgroup v${String(reading.cgroup.version)} ${mib(reading.cgroup.currentBytes)}／${
        reading.cgroup.limitBytes === null ? '沒設上限' : mib(reading.cgroup.limitBytes)
      }`
    : `cgroup 讀不到（${reading.cgroup.reason}）`;
  const host = reading.host.ok
    ? `主機可用 ${mib(reading.host.availableBytes)}／${mib(reading.host.totalBytes)}（${reading.host.source}）`
    : `主機讀不到（${reading.host.reason}）`;
  return `記憶體：${proc}；${cgroup}；${host}`;
}

/** 跑著的量具。 */
export interface RunningMemoryGauge {
  /** 停掉計時器。可重複呼叫。 */
  stop(): void;
}

/** {@link startMemoryGauge} 的選項。 */
export interface MemoryGaugeOptions {
  /** 兩次寫日誌之間的毫秒數；起動時另外立刻寫一行。 */
  readonly intervalMs: number;
  /** 日誌往哪寫（serve 的 `log`）。 */
  readonly log: (line: string) => void;
  /** 讀外界的縫；省略即真的。 */
  readonly deps?: MemoryGaugeDeps;
}

/**
 * 起量具：立刻寫一行（起動那一行），之後每 `intervalMs` 毫秒一行。
 *
 * - 計時器 `unref`：量具不會把 serve 撐著不退出。
 * - 前一次還沒讀完不疊下一次（讀本機檔案很快，但卡住的檔案系統不該讓請求堆起來）。
 * - 讀取本身不拋；`log` 拋了也接住，量具壞不該連累 serve。
 *
 * @param options - 見 {@link MemoryGaugeOptions}。
 * @returns 停止用的把手。
 */
export function startMemoryGauge(options: MemoryGaugeOptions): RunningMemoryGauge {
  const { intervalMs, log, deps } = options;
  let stopped = false;
  let busy = false;
  const tick = async (): Promise<void> => {
    if (stopped || busy) return;
    busy = true;
    try {
      const reading = await readMemory(deps);
      if (!stopped) log(formatMemoryLine(reading));
    } catch {
      // 量具不影響 serve：讀不到或日誌拋了都吞掉，下一次再試。
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
