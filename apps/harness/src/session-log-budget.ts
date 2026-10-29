/**
 * **會話日誌的位元組額度**（[#2115](https://github.com/DemianLi/nexus-agent/issues/2115)）：一個行程同時讀進記憶體的會話日誌，
 * 合計不能超過一個上限。超過的**在讀之前**就拒收（{@link SessionLogTooLargeError}），不讓一條大日誌把整個行程拖死。
 *
 * 為什麼要這一道：續接與唯讀打開都把整份日誌讀成一個 Buffer、再解析成整個事件陣列，成本是日誌大小的好幾倍
 * （量測：#2115，摘要在 `docs/operations.md`〈會話日誌額度〉）。Buffer 在 V8 heap 外，cgroup 會先殺。#1493 的用量警告只講
 * 不擋，而且跟著取樣開關（出廠關著）；thread 條數上限（`maxThreads`）也不看大小。
 *
 * **一本帳、兩種持有時間：**
 * - **續接**佔到那份會話的把手關掉為止（thread 撤掉、閒置逐出、關機）：載入之後事件還握在記憶體裡，讀完就還的話，
 *   第二條大的會被放進來，兩條一起把行程撐死。放不下就當場拒收（`busy`），**不排隊**：佔著的是活著的 thread，
 *   不會自己很快還回來（同 thread 條數上限，#1476）。
 * - **唯讀**（列表、冷讀、引用候選、背景子代理的冷檢查）：讀完、解析完就還。暫時放不下但等
 *   別的唯讀讀完就放得下的，**排隊等**；連續接佔掉的都扣掉之後還是放不下的，拒收。
 *
 * 單份上限就是這本帳的總容量：一份超過它的，什麼時候都不收（`too-large`）。總容量的出廠值見 {@link defaultLogBudgetBytes}。
 */
import { constrainedMemory } from 'node:process';
import { totalmem } from 'node:os';
import { getHeapStatistics } from 'node:v8';
import { SessionLogTooLargeError } from '@nexus/core';

/** 一筆佔用。`release` 可以叫很多次，只有第一次算。 */
export interface SessionLogReservation {
  release(): void;
}

/** 見檔頭。 */
export interface SessionLogBudget {
  /** 總容量（位元組）；`Infinity` 是不限。 */
  readonly limitBytes: number;
  /** 續接：佔到 `release` 為止。放不下就拋 {@link SessionLogTooLargeError}，不等。 */
  holdForSession(id: string, logBytes: number): SessionLogReservation;
  /**
   * 唯讀：讀完就 `release`。等別的唯讀讀完就放得下的排隊（先來先放）；等不到的 reject {@link SessionLogTooLargeError}，
   * 排隊中途續接佔進來而變成等不到的也是。
   */
  reserveForRead(id: string, logBytes: number): Promise<SessionLogReservation>;
}

/**
 * 每 1 位元組日誌，serve 打開它時行程記憶體（RSS）最多漲多少。量的是 serve 經 `threadFor` 打開一條大 thread
 * （1g／4g 容器、長行與小行兩種形狀，實測 5.2–6.4 倍，量測：#2115），取最壞的那一格再留餘裕。
 * 存檔層自己只要約 2.5 倍（#2075），多出來的是組裝 agent 那一段；唯讀路徑也用這個數，對它們偏保守。
 */
export const RSS_BYTES_PER_LOG_BYTE = 7;
/** 同 {@link RSS_BYTES_PER_LOG_BYTE}，量的是 V8 heap 已用的峰值（實測 3.7–4.6 倍）。 */
export const HEAP_BYTES_PER_LOG_BYTE = 5;

/** {@link defaultLogBudgetBytes} 讀的量。**只給測試換**。 */
export interface MemoryReadings {
  /** 行程能用的記憶體上限：cgroup 的上限，沒有就是主機總量。 */
  readonly memoryLimitBytes: number;
  /** 現在的 RSS。 */
  readonly rssBytes: number;
  readonly heapLimitBytes: number;
  readonly heapUsedBytes: number;
}

/** 這個行程現在的 {@link MemoryReadings}。`constrainedMemory()` 沒有上限時回 0（macOS）或比主機還大的數，兩種都退到主機總量。 */
export function readMemory(): MemoryReadings {
  const host = totalmem();
  const constrained = constrainedMemory();
  const heap = getHeapStatistics();
  return {
    memoryLimitBytes: constrained > 0 && constrained < host ? constrained : host,
    rssBytes: process.memoryUsage.rss(),
    heapLimitBytes: heap.heap_size_limit,
    heapUsedBytes: heap.used_heap_size,
  };
}

/**
 * 出廠的總容量：剩下的記憶體（上限減掉現在的 RSS）與剩下的 heap（heap 上限減掉現在已用），各除以自己的倍率，取小的。
 * 讀的是叫它當下的量，所以呼叫方要在起動完、還沒讀任何會話日誌時叫；serve 與 {@link processSessionLogBudget} 都等第一次
 * 用到才叫。
 *
 * @param readings - 預設讀這個行程自己的。
 * @returns 位元組，至少 0。
 */
export function defaultLogBudgetBytes(readings: MemoryReadings = readMemory()): number {
  const byRss = (readings.memoryLimitBytes - readings.rssBytes) / RSS_BYTES_PER_LOG_BYTE;
  const byHeap = (readings.heapLimitBytes - readings.heapUsedBytes) / HEAP_BYTES_PER_LOG_BYTE;
  return Math.max(0, Math.floor(Math.min(byRss, byHeap)));
}

/**
 * 開一本帳。
 *
 * @param limit - 總容量（位元組，`Infinity` 是不限），或第一次用到時才算容量的函式：serve 在起動完之前就要把帳交給存放處，
 *   出廠容量卻要等起動完、RSS 是 serve 自己的底時才算（{@link defaultLogBudgetBytes}）。
 * @throws `RangeError` 容量不是 0 以上的數（給函式的話，在第一次用到時拋）。
 */
export function createSessionLogBudget(limit: number | (() => number)): SessionLogBudget {
  let resolved: number | undefined;
  const capacity = (): number => {
    if (resolved === undefined) {
      const value = typeof limit === 'function' ? limit() : limit;
      if (Number.isNaN(value) || value < 0) {
        throw new RangeError(`會話日誌的位元組額度要是 0 以上的數，拿到 ${String(value)}`);
      }
      resolved = value;
    }
    return resolved;
  };
  if (typeof limit === 'number') capacity();
  let heldBySessions = 0;
  let heldByReads = 0;
  const waiting: {
    readonly id: string;
    readonly bytes: number;
    readonly grant: () => void;
    readonly refuse: (error: SessionLogTooLargeError) => void;
  }[] = [];

  const reservation = (onRelease: () => void): SessionLogReservation => {
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        onRelease();
      },
    };
  };
  // 先來先放：排頭放不下，後面的也不插隊（不讓一份大的被一串小的餓死）。續接佔得更多之後，連唯讀都還掉也放不下的
  // 先拒掉：它們要等的是 thread 撤掉，不是別的讀完，排著只會擋住後面的。
  const drain = () => {
    for (let index = waiting.length - 1; index >= 0; index -= 1) {
      const entry = waiting[index]!;
      if (heldBySessions + entry.bytes > capacity()) {
        waiting.splice(index, 1);
        entry.refuse(
          new SessionLogTooLargeError(
            entry.id,
            'busy',
            entry.bytes,
            capacity(),
            heldBySessions + heldByReads,
          ),
        );
      }
    }
    while (waiting.length > 0 && heldBySessions + heldByReads + waiting[0]!.bytes <= capacity()) {
      waiting.shift()!.grant();
    }
  };
  const readReservation = (bytes: number) => {
    heldByReads += bytes;
    return reservation(() => {
      heldByReads -= bytes;
      drain();
    });
  };

  return {
    get limitBytes() {
      return capacity();
    },
    holdForSession(id, logBytes) {
      const limitBytes = capacity();
      if (logBytes > limitBytes) {
        throw new SessionLogTooLargeError(id, 'too-large', logBytes, limitBytes, 0);
      }
      const held = heldBySessions + heldByReads;
      if (held + logBytes > limitBytes) {
        throw new SessionLogTooLargeError(id, 'busy', logBytes, limitBytes, held);
      }
      heldBySessions += logBytes;
      drain();
      return reservation(() => {
        heldBySessions -= logBytes;
        drain();
      });
    },
    reserveForRead(id, logBytes) {
      let limitBytes: number;
      try {
        limitBytes = capacity();
      } catch (error: unknown) {
        return Promise.reject(error);
      }
      if (logBytes > limitBytes) {
        return Promise.reject(
          new SessionLogTooLargeError(id, 'too-large', logBytes, limitBytes, 0),
        );
      }
      if (heldBySessions + logBytes > limitBytes) {
        return Promise.reject(
          new SessionLogTooLargeError(
            id,
            'busy',
            logBytes,
            limitBytes,
            heldBySessions + heldByReads,
          ),
        );
      }
      if (waiting.length === 0 && heldBySessions + heldByReads + logBytes <= limitBytes) {
        return Promise.resolve(readReservation(logBytes));
      }
      return new Promise((resolve, reject) => {
        waiting.push({
          id,
          bytes: logBytes,
          grant: () => resolve(readReservation(logBytes)),
          refuse: reject,
        });
      });
    },
  };
}

let processBudget: SessionLogBudget | undefined;

/**
 * 沒給 `logBudget` 的存放處共用的那一本（CLI 的 run 目錄、量測工具）：記憶體是整個行程一份，同一個行程裡不另開第二本。
 * serve 自己照 `thread-capacity` 開一本，不用這個。第一次用到時照 {@link defaultLogBudgetBytes} 算容量。
 */
export function processSessionLogBudget(): SessionLogBudget {
  processBudget ??= createSessionLogBudget(() => defaultLogBudgetBytes());
  return processBudget;
}
