/**
 * serve 的**記憶體用量警告**（[#1493](https://github.com/DemianLi/nexus-agent/issues/1493)，「底座保險絲」第 0 級；
 * demian 2026-10-18 拍板 Q1–Q4）。接在 {@link readMemory}（#1490 的量具）每次讀數之後，把讀數和一道門檻比：
 * **只警告，不做任何動作**——不拒收、不逐出、不下架。
 *
 * ## 結構：來源 × 狀態機
 *
 * - **來源**（{@link PressureSource}）把一次讀數換成「用量百分比」，或「讀不到與原因」。今天只有一個
 *   （{@link memoryUsageSource}，Q1(a)：cgroup 上限優先、其次行程受限、最後主機）；之後多一個來源（例如 heap 比例）或
 *   少一種來源（例如主機的 `os.freemem` 不算），是改來源清單，不是改狀態機。
 * - **狀態機**（{@link createMemoryPressureWatch}）每個來源各一份狀態，互不影響：
 *   - 嚴格超過門檻（`>`）講一次「警告」；之後不重複。
 *   - 降到「門檻 − {@link PRESSURE_HYSTERESIS_POINTS}」**以下**（嚴格小於）講一次「已恢復」；門檻附近來回不洗版（Q3）。
 *   - **讀不到就不判斷、不警告，也不把讀不到當成 0**（借 dsh `terminal-controller/src/retention.ts:119`、`:122`：檢查失敗記成 `state: 'unknown'`，不是 `idle` 就不收，活動狀態未知時不動作）。
 *     從可讀變成不可讀時講一次原因（起動時就讀不到也講一次），不可讀期間狀態保持不變——讀不到不算恢復，回來時接續。
 *   - 同一個來源的「依據」換了（例如 cgroup 消失、改看主機），分母的意思變了，狀態重來。
 *
 * ## 偏離 dsh：產品需求超出 dsh（理由 2）
 *
 * dsh（`687f282e`）沒有執行期的記憶體監看。這是 serve 跑在多人共用的內網主機上、需要在爆之前通知管理者才有的需求。
 * 只借上面「讀不到就不判斷」的形狀（dsh `retention.ts:119` 檢查失敗記成 `state: 'unknown'`、`:122` 不是 `idle` 就不收）。
 *
 * @module
 */

import { mib } from './memory-gauge.js';
import type { MemoryReading } from './memory-gauge.js';

/** 降回來要低於「門檻 − 這個數」才算恢復（百分點）。 */
export const PRESSURE_HYSTERESIS_POINTS = 5;

/** 一個來源這次讀到了：用量百分比，與它是拿什麼量的。 */
export interface PressureLevel {
  readonly kind: 'level';
  /** 分母的出處，寫進警告（`cgroup v2 /`、`主機 MemAvailable`）。換了就是另一種數字，狀態機會重來。 */
  readonly basis: string;
  /** 用量百分比，沒有上限截斷（可以超過 100）。 */
  readonly percent: number;
  /** 給人看的分子分母，例如 `692.0 MiB／1024.0 MiB`。 */
  readonly detail: string;
}

/** 一個來源這次讀不到。 */
export interface PressureUnreadable {
  readonly kind: 'unreadable';
  readonly reason: string;
}

export type PressureMeasurement = PressureLevel | PressureUnreadable;

/** 把一次讀數換成一個用量百分比的來源。 */
export interface PressureSource {
  /** 狀態機以它區分來源，不重複。 */
  readonly id: string;
  /** 警告裡這個來源叫什麼，例如 `記憶體用量`。 */
  readonly label: string;
  measure(reading: MemoryReading): PressureMeasurement;
}

/** 警告裡寫的 serve 現況。 */
export interface PressureContext {
  readonly threadCount: number;
  readonly maxThreads?: number;
}

/**
 * Q1(a)：**有 cgroup 上限時用 cgroup，沒有時用主機。**
 *
 * 1. cgroup 讀到而且自己設了上限：`memory.current ÷ memory.max`。
 * 2. cgroup 讀到、自己沒設，但 `process.constrainedMemory()` 報了一個更小的限制（上限可能在祖先 cgroup）：
 *    `memory.current ÷ 那個限制`（量具的 `行程受限`）。
 * 3. 其餘（沒有 cgroup，例如 macOS；或有、但哪裡都沒設上限）：主機的 `(總量 − 可用) ÷ 總量`，**可用**必須是 `/proc/meminfo` 的
 *    `MemAvailable`。主機退到 `os.freemem()`（沒有 `/proc/meminfo`）時**當成讀不到**：它不含可回收的快取，用量會天生偏高
 *    （#1464 的 macOS 機器閒置時就顯示約 93%），拿去和門檻比會一直誤報。Q1(a) 指定的公式本來就是 `MemAvailable`（PM 採納，#1493）。
 *    **副作用：macOS 上 cgroup 和主機都不可用，所以整個不警告**，只在起動時講一次原因。
 * 4. 都讀不到：讀不到，原因把兩邊的都寫出來。
 *
 * `memory.current` 含 page cache，所以**會高估**（沒扣 `inactive_file`，照拍板）：#1490 實測在 1g 容器高於行程 RSS 約 28 MiB、4g 約 170 MiB。
 * 後果：長期跑下來 page cache 會把讀數推高後停在高處，警告響一次之後可能一直不恢復（Q3 是越過才講一次，代價只有那一行日誌）。
 */
export const memoryUsageSource: PressureSource = {
  id: 'memory-usage',
  label: '記憶體用量',
  measure(reading) {
    const { cgroup, host } = reading;
    if (cgroup.ok) {
      const limit = cgroup.limitBytes ?? cgroup.constrainedBytes;
      if (limit !== undefined && limit > 0) {
        return {
          kind: 'level',
          basis: `cgroup v${String(cgroup.version)} ${cgroup.path}${cgroup.limitBytes === null ? '（行程受限）' : ''}`,
          percent: (cgroup.currentBytes / limit) * 100,
          detail: `${mib(cgroup.currentBytes)}／${mib(limit)}`,
        };
      }
    }
    if (host.ok && host.source === 'MemAvailable') {
      if (host.totalBytes <= 0) return { kind: 'unreadable', reason: '主機的總記憶體是 0' };
      const used = host.totalBytes - host.availableBytes;
      return {
        kind: 'level',
        basis: `主機 ${host.source}`,
        percent: (used / host.totalBytes) * 100,
        detail: `已用 ${mib(used)}／${mib(host.totalBytes)}`,
      };
    }
    const cgroupSide = cgroup.ok ? 'cgroup 沒設上限' : `cgroup 讀不到（${cgroup.reason}）`;
    const hostSide = host.ok
      ? `主機沒有 MemAvailable（${host.fallbackReason ?? '原因不明'}），退到 os.freemem 不含可回收快取、不能當分母`
      : `主機讀不到（${host.reason}）`;
    return { kind: 'unreadable', reason: `${cgroupSide}；${hostSide}` };
  },
};

/** {@link createMemoryPressureWatch} 的選項。 */
export interface MemoryPressureWatchOptions {
  /** 警告門檻，1 到 99 的整數（設定那一層已驗，這裡再擋一次）。 */
  readonly thresholdPercent: number;
  /** 要看的來源，id 不可重複。 */
  readonly sources: readonly PressureSource[];
  /** serve 現況，警告時才讀。拋了就不寫那一句，不影響警告本身。 */
  readonly context: () => PressureContext;
}

/** 跑著的判斷。 */
export interface MemoryPressureWatch {
  /**
   * 看一次讀數。
   *
   * @param reading - {@link readMemory} 的結果。
   * @returns 這次要寫進日誌的行（沒有狀態變化就是空的）。不拋。
   */
  observe(reading: MemoryReading): readonly string[];
}

interface SourceState {
  /** `undefined`＝還沒看過。 */
  readable: boolean | undefined;
  basis: string | undefined;
  high: boolean;
}

function contextSentence(read: () => PressureContext): string {
  let context: PressureContext;
  try {
    context = read();
  } catch {
    return '';
  }
  const limit = context.maxThreads === undefined ? '' : `（上限 ${String(context.maxThreads)}）`;
  return `serve 現在有 ${String(context.threadCount)} 條 thread${limit}。`;
}

/**
 * 建一個判斷。狀態在閉包裡，一個 serve 一份。
 *
 * @param options - 見 {@link MemoryPressureWatchOptions}。
 * @returns 見 {@link MemoryPressureWatch}。
 */
export function createMemoryPressureWatch(
  options: MemoryPressureWatchOptions,
): MemoryPressureWatch {
  const { thresholdPercent, sources, context } = options;
  if (!Number.isInteger(thresholdPercent) || thresholdPercent < 1 || thresholdPercent > 99) {
    throw new RangeError(`記憶體警告門檻要是 1 到 99 的整數，收到 ${String(thresholdPercent)}`);
  }
  const ids = new Set(sources.map((source) => source.id));
  if (ids.size !== sources.length) throw new Error('記憶體警告的來源 id 不可重複');
  const recoverBelow = thresholdPercent - PRESSURE_HYSTERESIS_POINTS;
  const states = new Map<string, SourceState>(
    sources.map((source) => [source.id, { readable: undefined, basis: undefined, high: false }]),
  );

  return {
    observe(reading) {
      const lines: string[] = [];
      for (const source of sources) {
        const state = states.get(source.id);
        if (state === undefined) continue;
        let measurement: PressureMeasurement;
        try {
          measurement = source.measure(reading);
        } catch (error: unknown) {
          measurement = {
            kind: 'unreadable',
            reason: error instanceof Error ? error.message : String(error),
          };
        }
        if (measurement.kind === 'level' && !Number.isFinite(measurement.percent)) {
          measurement = {
            kind: 'unreadable',
            reason: `算出來的百分比不是數字（${measurement.detail}）`,
          };
        }
        if (measurement.kind === 'unreadable') {
          if (state.readable !== false) {
            lines.push(
              `[記憶體] ${source.label}讀不到（${measurement.reason}），這個來源不判斷用量門檻，讀到了再接續。`,
            );
          }
          state.readable = false;
          continue;
        }
        state.readable = true;
        if (state.basis !== undefined && state.basis !== measurement.basis) state.high = false;
        state.basis = measurement.basis;
        const percent = `${measurement.percent.toFixed(1)}%`;
        if (!state.high && measurement.percent > thresholdPercent) {
          state.high = true;
          lines.push(
            `[記憶體] 警告：${source.label}（${measurement.basis}）${percent}，超過門檻 ${String(thresholdPercent)}%（${measurement.detail}）。` +
              `${contextSentence(context)}下一步：調低 thread-capacity 的 maxThreads，或縮短 idleEvictAfterMs（改了要重啟 serve）；` +
              '門檻是 memory-gauge 那一列的 warnAtPercent。',
          );
        } else if (state.high && measurement.percent < recoverBelow) {
          state.high = false;
          lines.push(
            `[記憶體] 已恢復：${source.label}（${measurement.basis}）${percent}，低於 ${String(recoverBelow)}%（${measurement.detail}）。`,
          );
        }
      }
      return lines;
    },
  };
}
