/**
 * **會話日誌的位元組額度**（[#2115](https://github.com/DemianLi/nexus-agent/issues/2115)）：一個行程同時讀進記憶體的會話日誌，
 * 合計不能超過一個上限。超過的**在讀之前**就拒收（{@link SessionLogTooLargeError}），不讓一條大日誌把整個行程拖死。
 *
 * 為什麼要這一道：續接與唯讀打開都把整份日誌讀成一個 Buffer、再解析成整個事件陣列，第一句還要把整段歷史組成請求，成本是日誌
 * 大小的十倍上下（量測：#2205，摘要在 `docs/operations.md`〈會話日誌額度〉）。先撞到的可能是 V8 heap，也可能是 cgroup，超過時
 * 行程都是整個死掉。#1493 的用量警告只講不擋，而且跟著取樣開關（出廠關著）；thread 條數上限（`maxThreads`）也不看大小。
 *
 * **一本帳、兩種持有時間：**
 * - **續接**佔到那份會話的把手關掉為止（thread 撤掉、閒置逐出、關機）：載入之後事件還握在記憶體裡，讀完就還的話，
 *   第二條大的會被放進來，兩條一起把行程撐死。開著的 thread 佔的加上這一份放不下，就當場拒收（`busy`），**不排隊**：
 *   佔著的是活著的 thread，不會自己很快還回來（同 thread 條數上限，#1476）。只是正在讀的唯讀佔著的話，等它們讀完，
 *   而且排在所有唯讀前面（已經排隊的與之後才來的）：側欄剛好在讀別的日誌，不該讓打開一條 thread 失敗。
 * - **唯讀**（列表、冷讀、引用候選、背景子代理的冷檢查）：讀完、解析完就還。暫時放不下但等
 *   別的唯讀讀完就放得下的，**排隊等**；連續接佔掉的都扣掉之後還是放不下的，拒收。
 *
 * 單份上限就是這本帳的總容量：一份超過它的，什麼時候都不收（`too-large`）。總容量的出廠值見 {@link defaultLogBudgetBytes}。
 * 帳只記續接當下的大小：開著之後長出來的不入帳，長過容量由存放處講一行（#2215）。
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
  /**
   * {@link limitBytes} 已經算出來就回它，還沒算回 `undefined`，不替它算：出廠容量要在起動完才算，寫入路徑不能把它提早算定（#2215）。
   */
  readonly knownLimitBytes: number | undefined;
  /**
   * 續接：佔到 `release` 為止。只是正在讀的唯讀佔著的話等它們讀完，排在所有唯讀前面（已經排隊的與之後才來的）；
   * 開著的 thread 佔的加上這一份放不下的，reject {@link SessionLogTooLargeError}，不等；排隊中途前面的續接佔進來而變成
   * 放不下的也是。
   */
  holdForSession(id: string, logBytes: number): Promise<SessionLogReservation>;
  /**
   * 唯讀：讀完就 `release`。等別的唯讀讀完就放得下的排隊（先來先放）；等不到的 reject {@link SessionLogTooLargeError}，
   * 排隊中途續接佔進來而變成等不到的也是。
   */
  reserveForRead(id: string, logBytes: number): Promise<SessionLogReservation>;
}

/**
 * 每 1 位元組日誌，serve 打開它、送完兩句時行程記憶體（RSS）最多漲多少。量的是最壞的小行形狀（#2205）：1g／4g 容器實測
 * 9.1–11.7 倍，取 13。1g 算出約 58 MiB，比實測活得下來的 64.5 MiB 低；額度內 55.9 MiB 那格 RSS 峰值 925 MiB。
 * 唯讀路徑也用這個數，對它們偏保守。
 */
export const RSS_BYTES_PER_LOG_BYTE = 13;
/**
 * 同 {@link RSS_BYTES_PER_LOG_BYTE}，量的是 V8 heap 扣掉起動已用：活得下來與死掉的格子把活物件的倍率夾在 6.6–7.6，500 毫秒取樣的
 * 已用峰值最高 7.9，取 11。照範本的 70% 配 heap，1g 與 4g 都是這一項先卡住：1g 約 56 MiB（64.5 MiB 那格 heap 已用到 86%），
 * 4g 約 250 MiB（269 MiB 那格用到 76%、323 MiB 那格用到 90%）。
 */
export const HEAP_BYTES_PER_LOG_BYTE = 11;

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
 * 讀的是叫它當下的量，所以呼叫方要在起動完、還沒讀任何會話日誌時叫；serve、CLI（{@link sessionLogBudgetFromSetting}）
 * 與 {@link processSessionLogBudget} 都等第一次用到才叫。
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
  interface Waiter {
    readonly id: string;
    readonly bytes: number;
    readonly grant: () => void;
    readonly refuse: (error: SessionLogTooLargeError) => void;
  }
  // 續接排在唯讀前面：續接等的只是正在讀的那幾份讀完，排在唯讀後面的話，一串唯讀就能讓打開一條 thread 一直等。
  const waitingSessions: Waiter[] = [];
  const waitingReads: Waiter[] = [];

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
  const busy = (id: string, bytes: number) =>
    new SessionLogTooLargeError(id, 'busy', bytes, capacity(), heldBySessions);
  // 只有開著的 thread 佔的加上這一份放不下，才是等不到：那要等 thread 撤掉，不是等別的讀完，排著只會擋住後面的。
  const refuseUnreachable = (queue: Waiter[]) => {
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const entry = queue[index]!;
      if (heldBySessions + entry.bytes > capacity()) {
        queue.splice(index, 1);
        entry.refuse(busy(entry.id, entry.bytes));
      }
    }
  };
  const fits = (bytes: number) => heldBySessions + heldByReads + bytes <= capacity();
  // 每一排都先來先放：排頭放不下，後面的也不插隊（不讓一份大的被一串小的餓死）。續接放進來一份，排著的續接與唯讀
  // 都可能從此等不到：每放一份續接就重篩排著的續接，續接放完再篩一次唯讀。唯讀要等續接排空才放。
  const drain = () => {
    for (;;) {
      refuseUnreachable(waitingSessions);
      if (waitingSessions.length === 0 || !fits(waitingSessions[0]!.bytes)) break;
      waitingSessions.shift()!.grant();
    }
    refuseUnreachable(waitingReads);
    if (waitingSessions.length > 0) return;
    while (waitingReads.length > 0 && fits(waitingReads[0]!.bytes)) waitingReads.shift()!.grant();
  };
  const sessionReservation = (bytes: number) => {
    heldBySessions += bytes;
    return reservation(() => {
      heldBySessions -= bytes;
      drain();
    });
  };
  const readReservation = (bytes: number) => {
    heldByReads += bytes;
    return reservation(() => {
      heldByReads -= bytes;
      drain();
    });
  };
  const admit = (
    id: string,
    logBytes: number,
    queue: Waiter[],
    ahead: readonly Waiter[][],
    grant: (bytes: number) => SessionLogReservation,
  ): Promise<SessionLogReservation> => {
    let limitBytes: number;
    try {
      limitBytes = capacity();
    } catch (error: unknown) {
      return Promise.reject(error);
    }
    if (logBytes > limitBytes) {
      return Promise.reject(new SessionLogTooLargeError(id, 'too-large', logBytes, limitBytes, 0));
    }
    if (heldBySessions + logBytes > limitBytes) return Promise.reject(busy(id, logBytes));
    if (ahead.every((waiting) => waiting.length === 0) && fits(logBytes)) {
      const granted = grant(logBytes);
      // 續接佔進來之後，排著的唯讀可能再也等不到。
      drain();
      return Promise.resolve(granted);
    }
    return new Promise((resolve, reject) => {
      queue.push({ id, bytes: logBytes, grant: () => resolve(grant(logBytes)), refuse: reject });
    });
  };

  return {
    get limitBytes() {
      return capacity();
    },
    get knownLimitBytes() {
      return resolved;
    },
    holdForSession: (id, logBytes) =>
      admit(id, logBytes, waitingSessions, [waitingSessions], sessionReservation),
    reserveForRead: (id, logBytes) =>
      admit(id, logBytes, waitingReads, [waitingSessions, waitingReads], readReservation),
  };
}

/**
 * 照 `thread-capacity` 的 `sessionLogBudgetMiB` 開一本：不寫是第一次用到時照 {@link defaultLogBudgetBytes} 算，正整數是那麼多
 * MiB，`0` 是不限。serve 與 CLI 都從這裡開，同一個設定在兩邊是同一個意思。
 */
export function sessionLogBudgetFromSetting(configuredMiB: number | undefined): SessionLogBudget {
  if (configuredMiB === undefined) return createSessionLogBudget(() => defaultLogBudgetBytes());
  return createSessionLogBudget(
    configuredMiB === 0 ? Number.POSITIVE_INFINITY : configuredMiB * 1024 * 1024,
  );
}

let processBudget: SessionLogBudget | undefined;

/**
 * 沒給 `logBudget` 的存放處共用的那一本（量測工具、沒給 `openStore` 的引用候選）：記憶體是整個行程一份，同一個行程裡不另開第二本。
 * serve 與 CLI 照 `thread-capacity` 各開一本（{@link sessionLogBudgetFromSetting}），不用這個。這一本第一次用到時照 {@link defaultLogBudgetBytes} 算容量。
 */
export function processSessionLogBudget(): SessionLogBudget {
  processBudget ??= createSessionLogBudget(() => defaultLogBudgetBytes());
  return processBudget;
}
