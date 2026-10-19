/**
 * serve 的**記憶體量具**（[#1490](https://github.com/DemianLi/nexus-agent/issues/1490)，「底座保險絲」第 3 級之前的量測卡）。
 *
 * **只讀、只講，不做任何動作**：不拒收、不逐出、不下架。讀三個來源，各自獨立，讀不到的那個明說「讀不到」與原因，**不回 0**
 * ——0 是一個答案，「不知道」不是：
 *
 * 1. **行程自己**：`process.memoryUsage()` 的 RSS 與 heap。到處讀得到；拋了也明說。
 * 2. **容器上限**：Linux 的 cgroup。**先解 `/proc/self/cgroup`，讀行程自己所在的那個 cgroup**，不是掛載根：
 *    v2 取 `0::<路徑>` 那一行、讀 `/sys/fs/cgroup/<路徑>/memory.current`／`memory.max`；v1 取 controller 含 `memory` 的那一行、
 *    讀 `/sys/fs/cgroup/memory/<路徑>/memory.usage_in_bytes`／`memory.limit_in_bytes`；hybrid（兩種都有）先試 v2，
 *    v2 的檔案不在（沒有 memory controller）再試 v1。systemd 底下的裸機行程在 `/system.slice/…`，docker 預設的私有 cgroupns
 *    看到的路徑是 `/`，兩者都讀對；寫死掛載根的話，前者會誤報「沒有 cgroup」，v1 主機則會讀到整台機器的量卻說「沒設上限」。
 *    `max`（v2）或一個大到不合理的數字（v1）是「沒設上限」，與讀不到分開講；沒設上限時若 `process.constrainedMemory()`
 *    （libuv 讀的，dsh 的註解說它也反映上層 cgroup）報了一個比主機記憶體小的限制，另外寫出「行程受限」——上限可能設在這個
 *    cgroup 的祖先身上。macOS 上它回 0，不當成限制，也不印 0。
 * 3. **主機**：Linux 的 `/proc/meminfo` 的 `MemAvailable`（核心估的「不必換出就能給新程式用的量」）；沒有 `/proc/meminfo`
 *    才退到 `os.freemem()`，行尾標出是哪一種與為什麼退——macOS 的 `os.freemem()` 不含可回收的快取，會比實際少，兩種數字不能直接比。
 *
 * ## 偏離 dsh：產品需求超出 dsh
 *
 * dsh（`687f282e`）**沒有執行期的記憶體監看**：它的記憶體只在 CI 量（`scripts/run-memory-pressure-bench.ts`，
 * 無 swap 的 cgroup 模擬 4／8 GB 機器，`docs/defensive-patterns/general.zh.md:184`）。
 * 這支量具是 serve 跑在多人共用的內網主機上、需要知道「自己多大」和「主機還剩多少」才有的需求，登記為理由 2。
 * 它刻意只做 dsh 沒做的那一半——**看**；看了之後做什麼（第 0 級警告、第 3 級下架插件）等量測的數字出來由 demian 決定。
 *
 * 讀 cgroup 的方法**不在**這條偏離裡，照 dsh `run-memory-pressure-bench.ts:63-66`：先解 `/proc/self/cgroup` 的 `0::` 行，
 * `join('/sys/fs/cgroup', 路徑, 檔名)`，並用 `process.constrainedMemory()`。多出來的只有 v1／hybrid 的讀法——dsh 的 bench 只認 v2，
 * 我們的部署目標主機不保證是 v2，所以補上，同樣登記為理由 2。
 *
 * @module
 */

import { readFile } from 'node:fs/promises';
import { freemem, totalmem } from 'node:os';
import { posix } from 'node:path';

/** 一個來源的讀數：讀到了，或讀不到與原因。 */
export type Reading<T> =
  ({ readonly ok: true } & T) | { readonly ok: false; readonly reason: string };

/** 行程自己。 */
export interface ProcessMemory {
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
  readonly heapTotalBytes: number;
}

/**
 * 容器上限（cgroup）。`limitBytes` 是 `null` 表示**讀到了、而且這個 cgroup 自己沒設上限**；
 * `constrainedBytes` 有值表示 `process.constrainedMemory()` 報了一個比主機記憶體小的限制（可能設在祖先 cgroup 上）。
 */
export interface CgroupMemory {
  readonly version: 1 | 2;
  /** 行程所在的 cgroup 路徑（`/proc/self/cgroup` 給的）。 */
  readonly path: string;
  readonly currentBytes: number;
  readonly limitBytes: number | null;
  readonly constrainedBytes?: number;
}

/** 主機。`source` 說明數字怎麼來的，兩種不能直接比；退到 `os.freemem` 時 `fallbackReason` 說為什麼不是 `MemAvailable`。 */
export interface HostMemory {
  readonly source: 'MemAvailable' | 'os.freemem';
  readonly availableBytes: number;
  readonly totalBytes: number;
  readonly fallbackReason?: string;
}

/** 一次讀數：三個來源各自獨立。 */
export interface MemoryReading {
  readonly process: Reading<ProcessMemory>;
  readonly cgroup: Reading<CgroupMemory>;
  readonly host: Reading<HostMemory>;
}

/** 量具讀外界的縫，測試換掉。 */
export interface MemoryGaugeDeps {
  readonly readText: (path: string) => Promise<string>;
  readonly processMemory: () => ProcessMemory;
  readonly freemem: () => number;
  readonly totalmem: () => number;
  /** `process.constrainedMemory()`；舊 Node 沒有這支就是 `undefined`。 */
  readonly constrainedMemory: () => number | undefined;
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
  constrainedMemory: () =>
    typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : undefined,
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

/** 一個讀檔的結果：內容，或「檔案不在」與其他原因分開。 */
type FileRead =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'missing'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string };

async function readFileOnce(deps: MemoryGaugeDeps, path: string): Promise<FileRead> {
  try {
    return { kind: 'text', text: await deps.readText(path) };
  } catch (error: unknown) {
    const reason = `${path} ${reasonOf(error)}`;
    return reasonOf(error) === 'ENOENT' ? { kind: 'missing', reason } : { kind: 'failed', reason };
  }
}

/** `/proc/self/cgroup` 解出來的兩條路徑；沒有的那種是 `undefined`。 */
interface SelfCgroup {
  readonly v2?: string;
  readonly v1Memory?: string;
}

function parseSelfCgroup(text: string): SelfCgroup {
  let v2: string | undefined;
  let v1Memory: string | undefined;
  for (const line of text.split('\n')) {
    const first = line.indexOf(':');
    const second = first === -1 ? -1 : line.indexOf(':', first + 1);
    if (second === -1) continue;
    const hierarchy = line.slice(0, first);
    const controllers = line.slice(first + 1, second);
    const path = line.slice(second + 1).trim();
    if (hierarchy === '0' && controllers === '') v2 = path;
    else if (controllers.split(',').includes('memory')) v1Memory = path;
  }
  return { ...(v2 === undefined ? {} : { v2 }), ...(v1Memory === undefined ? {} : { v1Memory }) };
}

/** 把 `/proc/self/cgroup` 的路徑接到掛載點底下；不是絕對路徑或含 `..` 的不接（核心不會給，檔案被換掉的話寧可讀不到）。 */
function underRoot(base: string, cgroupPath: string): string | undefined {
  if (!cgroupPath.startsWith('/') || cgroupPath.split('/').includes('..')) return undefined;
  return posix.join(base, cgroupPath);
}

type Attempt =
  | { readonly kind: 'ok'; readonly memory: CgroupMemory }
  | { readonly kind: 'missing'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string };

async function attemptV2(deps: MemoryGaugeDeps, cgroupPath: string): Promise<Attempt> {
  const dir = underRoot('/sys/fs/cgroup', cgroupPath);
  if (dir === undefined) return { kind: 'failed', reason: `cgroup 路徑不合法：${cgroupPath}` };
  const currentPath = posix.join(dir, 'memory.current');
  const current = await readFileOnce(deps, currentPath);
  if (current.kind !== 'text') return current;
  const currentBytes = parseBytes(current.text);
  if (currentBytes === undefined) return { kind: 'failed', reason: `${currentPath} 不是整數` };
  const maxPath = posix.join(dir, 'memory.max');
  const max = await readFileOnce(deps, maxPath);
  if (max.kind !== 'text') return { kind: 'failed', reason: max.reason };
  if (max.text.trim() === 'max') {
    return {
      kind: 'ok',
      memory: { version: 2, path: cgroupPath, currentBytes, limitBytes: null },
    };
  }
  const limitBytes = parseBytes(max.text);
  if (limitBytes === undefined) {
    return { kind: 'failed', reason: `${maxPath} 不是整數也不是 max` };
  }
  return { kind: 'ok', memory: { version: 2, path: cgroupPath, currentBytes, limitBytes } };
}

async function attemptV1(deps: MemoryGaugeDeps, cgroupPath: string): Promise<Attempt> {
  const dir = underRoot('/sys/fs/cgroup/memory', cgroupPath);
  if (dir === undefined) return { kind: 'failed', reason: `cgroup 路徑不合法：${cgroupPath}` };
  const usagePath = posix.join(dir, 'memory.usage_in_bytes');
  const usage = await readFileOnce(deps, usagePath);
  if (usage.kind !== 'text') return usage;
  const currentBytes = parseBytes(usage.text);
  if (currentBytes === undefined) return { kind: 'failed', reason: `${usagePath} 不是整數` };
  const limitPath = posix.join(dir, 'memory.limit_in_bytes');
  const limit = await readFileOnce(deps, limitPath);
  if (limit.kind !== 'text') return { kind: 'failed', reason: limit.reason };
  const raw = limit.text.trim();
  if (!/^\d+$/.test(raw)) return { kind: 'failed', reason: `${limitPath} 不是整數` };
  // v1 的「沒設上限」是一個接近 2^63 的數字，可能超過 2^53，所以用 BigInt 比。
  const limitBytes = BigInt(raw) >= BigInt(CGROUP_V1_UNLIMITED_FROM) ? null : Number(raw);
  return { kind: 'ok', memory: { version: 1, path: cgroupPath, currentBytes, limitBytes } };
}

/** 沒設上限時，`process.constrainedMemory()` 若報了比主機小的限制就帶上（上限可能在祖先 cgroup）。 */
function withConstrained(memory: CgroupMemory, deps: MemoryGaugeDeps): CgroupMemory {
  if (memory.limitBytes !== null) return memory;
  try {
    const constrained = deps.constrainedMemory();
    if (constrained === undefined || !Number.isFinite(constrained) || constrained <= 0) {
      return memory;
    }
    return constrained < deps.totalmem() ? { ...memory, constrainedBytes: constrained } : memory;
  } catch {
    return memory;
  }
}

/**
 * 讀行程自己所在的 cgroup（見檔頭第 2 點）。「沒有 cgroup」這種說法只在**每一條路都是檔案不在**時才用；
 * 有別的失敗（權限、內容壞掉）就照實講是哪個檔怎麼了。
 */
async function readCgroup(deps: MemoryGaugeDeps): Promise<Reading<CgroupMemory>> {
  const self = await readFileOnce(deps, '/proc/self/cgroup');
  if (self.kind !== 'text') {
    return {
      ok: false,
      reason:
        self.kind === 'missing'
          ? `${self.reason}（沒有 cgroup：不是 Linux，或沒掛 /proc）`
          : self.reason,
    };
  }
  const { v2, v1Memory } = parseSelfCgroup(self.text);
  if (v2 === undefined && v1Memory === undefined) {
    return {
      ok: false,
      reason: '/proc/self/cgroup 沒有 v2 的 0:: 行，也沒有 memory controller 的行',
    };
  }
  const reasons: string[] = [];
  let everyMissing = true;
  if (v2 !== undefined) {
    const result = await attemptV2(deps, v2);
    if (result.kind === 'ok') return { ok: true, ...withConstrained(result.memory, deps) };
    // v2 的檔案不在（hybrid：v2 沒有 memory controller）才換 v1；別的失敗照實講。
    if (result.kind === 'failed') return { ok: false, reason: result.reason };
    reasons.push(result.reason);
  }
  if (v1Memory !== undefined) {
    const result = await attemptV1(deps, v1Memory);
    if (result.kind === 'ok') return { ok: true, ...withConstrained(result.memory, deps) };
    if (result.kind === 'failed') everyMissing = false;
    reasons.push(result.reason);
  }
  const joined = reasons.join('；');
  return { ok: false, reason: everyMissing ? `沒有 cgroup：${joined}` : joined };
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
  // 為什麼沒用 `MemAvailable`：帶進日誌那一行，管理者才分得出是 macOS 還是 /proc 壞了。
  let fallbackReason: string;
  const meminfo = await readFileOnce(deps, '/proc/meminfo');
  if (meminfo.kind === 'text') {
    const available = meminfoBytes(meminfo.text, 'MemAvailable');
    const total = meminfoBytes(meminfo.text, 'MemTotal');
    if (available !== undefined && total !== undefined) {
      return { ok: true, source: 'MemAvailable', availableBytes: available, totalBytes: total };
    }
    fallbackReason = '/proc/meminfo 沒有 MemAvailable 或 MemTotal';
  } else {
    fallbackReason = meminfo.reason;
  }
  try {
    return {
      ok: true,
      source: 'os.freemem',
      availableBytes: deps.freemem(),
      totalBytes: deps.totalmem(),
      fallbackReason,
    };
  } catch (error: unknown) {
    return { ok: false, reason: `${fallbackReason}；os.freemem ${reasonOf(error)}` };
  }
}

function readProcess(deps: MemoryGaugeDeps): Reading<ProcessMemory> {
  try {
    return { ok: true, ...deps.processMemory() };
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
  return { process: readProcess(deps), cgroup, host };
}

/** 位元組換成 MiB 字串，一位小數。 */
export function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/**
 * 把一次讀數寫成一行日誌。三個來源寫在同一行，讀不到的那個寫「讀不到（原因）」。
 *
 * @param reading - {@link readMemory} 的結果。
 * @returns 一行文字，不含換行。
 */
export function formatMemoryLine(reading: MemoryReading): string {
  const proc = reading.process.ok
    ? `行程 RSS ${mib(reading.process.rssBytes)}、heap 已用 ${mib(reading.process.heapUsedBytes)}／已提交 ${mib(reading.process.heapTotalBytes)}`
    : `行程讀不到（${reading.process.reason}）`;
  let cgroup: string;
  if (reading.cgroup.ok) {
    const limit = reading.cgroup.limitBytes === null ? '沒設上限' : mib(reading.cgroup.limitBytes);
    const upper =
      reading.cgroup.constrainedBytes === undefined
        ? ''
        : `（行程受限 ${mib(reading.cgroup.constrainedBytes)}，上限可能在上層 cgroup）`;
    cgroup = `cgroup v${String(reading.cgroup.version)} ${reading.cgroup.path} ${mib(reading.cgroup.currentBytes)}／${limit}${upper}`;
  } else {
    cgroup = `cgroup 讀不到（${reading.cgroup.reason}）`;
  }
  const host = reading.host.ok
    ? `主機可用 ${mib(reading.host.availableBytes)}／${mib(reading.host.totalBytes)}（${reading.host.source}${
        reading.host.fallbackReason === undefined ? '' : `；${reading.host.fallbackReason}`
      }）`
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
  /** 日誌往哪寫（serve 的 `log`，info 等級）。 */
  readonly log: (line: string) => void;
  /**
   * `onReading` 回的警告往哪寫（serve 的 `warn`，warn 等級，#1534）；省略就走 `log`。
   * 門檻調到 warn 的主機只留警告以上，用量警告正是最不該被濾掉的那一行。
   */
  readonly warn?: (line: string) => void;
  /** 讀外界的縫；省略即真的。 */
  readonly deps?: MemoryGaugeDeps;
  /**
   * 每次讀數寫完那一行之後，把讀數交給這支，它回的行接著寫進日誌（[#1493](https://github.com/DemianLi/nexus-agent/issues/1493)，
   * 用量警告）。量具自己不認識門檻。拋了就吞掉：警告壞了不該連累記憶體那一行，也不該連累 serve。
   */
  readonly onReading?: (reading: MemoryReading) => readonly string[];
}

/**
 * 起量具：立刻寫一行（起動那一行），之後每 `intervalMs` 毫秒一行。
 *
 * - 計時器 `unref`：量具不會把 serve 撐著不退出。
 * - 前一次還沒讀完不疊下一次（讀本機檔案很快，但卡住的檔案系統不該讓請求堆起來）。
 * - 讀取本身不拋（三個來源各自接住）；`log` 拋了也接住，量具壞不該連累 serve。
 *
 * @param options - 見 {@link MemoryGaugeOptions}。
 * @returns 停止用的把手。
 */
export function startMemoryGauge(options: MemoryGaugeOptions): RunningMemoryGauge {
  const { intervalMs, log, deps, onReading } = options;
  const warn = options.warn ?? log;
  let stopped = false;
  let busy = false;
  const tick = async (): Promise<void> => {
    if (stopped || busy) return;
    busy = true;
    try {
      const reading = await readMemory(deps);
      if (!stopped) {
        log(formatMemoryLine(reading));
        if (onReading !== undefined) {
          for (const line of onReading(reading)) warn(line);
        }
      }
    } catch {
      // 量具不影響 serve：`log` 拋了就吞掉，下一次再試。讀數本身的失敗不會走到這裡，已經寫進那一行了。
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
