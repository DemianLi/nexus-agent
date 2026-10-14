/**
 * serve 把「掛不上的列」記進變更紀錄的那一支（[#1414](https://github.com/DemianLi/nexus-agent/issues/1414)，Part of #1385）。
 *
 * 決議 `.docs/decisions-2026-10-11.md` §3-4 第 13 條（Q27 (b)）：插拔出錯時，結構化錯誤要進稽核紀錄。紀錄多一種只記不折
 * 的 `failed`（`plugin-journal.ts`），這裡是它的寫入者：serve 在三個地方發現某一列掛不上（啟動試組、每條 thread 組裝、
 * 讀清單時新掉的），把整份掉了的列交進來，由這裡決定記不記。
 *
 * ## 記不記：只在紀錄裡
 *
 * - **要記不要記，全由 {@link failureTriggerOf} 判**：那一列在紀錄裡有被接受的改動才記，只被出貨設定或 `--patch` 影響
 *   而掛不上的列照今天只進日誌。這支不自己判。
 * - **去重在鎖裡**：鍵是「列 id ＋ 歸因到的那一筆的 `seq`」（PM 2026-10-13：一筆遷移來的 `insert` 可能同時讓好幾列掛不上，
 *   只用 `seq` 會只記到第一列）。寫之前在鎖裡對現有紀錄再查一次，所以兩個 serve 同時看到同一件事、跨重啟，都只記一次。
 *   鎖外先查一次只是省鎖。
 * - **呼叫端不做記憶**：每次重讀與每次組裝都把整份交進來。`thread-plugin-list.ts` 那幾個「已知掉了」的集合鍵是
 *   「列 id ＋宣告」，宣告改回舊值時（改了又改回去）它不會重試、也就不會再掉，那一次的 `failed` 只有這裡看得到。
 *
 * ## 不建檔、不擋 thread
 *
 * - **紀錄檔不在就什麼都不做、一行日誌都不出**：檔案不在（沒人寫過、`prepareJournal` 沒建成、舊 patch 檔還在待遷移）時，
 *   沒有任何東西指得到這一列。`appendJournalRecord` 在檔案不在時會建，所以先讀、不在就不呼叫它（#1413 的不變量：
 *   沒有紀錄時，serve 的輸出與改動前逐位元組相同）。
 * - **等鎖上限 2 秒**，照 dsh 的預設（`packages/util/atomic-write/src/index.ts:196`），不是寫入口的 30 秒：寫入口持鎖時要
 *   驗證一筆變更、載入模組，這裡持鎖只是追加一行。home 唯讀、鎖被別人拿著，都只記日誌（同一件事只講一次）。
 * - **不 reject**：呼叫端是 thread 的組裝與關閉流程，這裡的失敗不能讓它們多一種結局。
 * - **{@link FailureRecorder.note} 不等寫完**；只有「要拋之前」才 {@link FailureRecorder.flush}（必掛的列掉了，起不來
 *   或那條 thread 建不起來之前，先把那一筆寫進去；等的時間仍以 2 秒為上限）。
 *
 * ## 日誌不帶原因
 *
 * 原因原文只進紀錄（0600）。這支加的日誌只講「記了」「沒寫成」與列 id，不印原因：原因可能引到設定值的一部分。
 * 既有的 `describeDrop` 日誌行照舊（它早就在了）。
 *
 * ## 偏離登記
 *
 * 沿用 #1413 的第 2 條（變更歷史是產品需求，dsh 沒有）：這一種筆與 `rejected` 同屬它。dsh 的 `plugin-manager/changed`
 * 只帶 `reason`（`packages/boot/plugin-manager/src/types.ts:244-246`），沒有「某一列為什麼掛不上」的結構化紀錄。
 *
 * @module
 */

import { assertPrivateFile, JOURNAL_FILE_ROLE } from './plugin-config.js';
import {
  appendJournalRecord,
  failureTriggerOf,
  hasFailedRecord,
  readJournal,
} from './plugin-journal.js';
import type { FailureContext, FailureDiscovery, JournalBody } from './plugin-journal.js';

/** 等鎖的上限：dsh 的預設 2 秒。 */
export const FAILURE_RECORD_WAIT_MS = 2000;

/** 交進來的一列：同 `StartupDrop` 的那幾格，不帶 `entry`。 */
export interface FailedRow {
  readonly id: string;
  /** 模組 specifier（沒寫 id 的 `insert` 列靠它對上紀錄）。 */
  readonly module: string;
  readonly stage: 'module' | 'config' | 'apply' | 'requires';
  /** 原因原文，只進紀錄。 */
  readonly message: string;
  /**
   * 上一次組裝或重讀時這一列還掛著、這一次掉了嗎（#1423）；起點是啟動那一份的結果。上一次就已經掉了是 `false`，
   * 沒有資料就省略。
   */
  readonly newlyDropped?: boolean;
}

/**
 * 把掉了的列（`StartupDrop`）換成 {@link FailedRow}。不帶 `entry`：那是組裝用的物件，不進紀錄。
 *
 * **第二個參數必填**（#1423 審查）：可省略的話，呼叫端漏接「新掉的列 id」照樣編得過，而漏了的後果是新規則靜靜不作用。
 * 啟動那幾處沒有「上一次」可比，明寫 `undefined`。
 *
 * @param drops - 掉了的列。
 * @param newlyDropped - 這一次新掉的列 id；沒有「上一次」可比（啟動）就是 `undefined`，每一列都不帶 `newlyDropped`。
 */
export function failedRowsOf(
  drops: readonly Pick<FailedRow, 'id' | 'module' | 'stage' | 'message'>[],
  newlyDropped: ReadonlySet<string> | undefined,
): FailedRow[] {
  return drops.map(({ id, module, stage, message }) => ({
    id,
    module,
    stage,
    message,
    ...(newlyDropped !== undefined && { newlyDropped: newlyDropped.has(id) }),
  }));
}

/** 記錄器。 */
export interface FailureRecorder {
  /** 排進去就回，不等寫完。 */
  note(rows: readonly FailedRow[], at: FailureDiscovery): void;
  /** 等排進去的都處理完（含失敗）。不 reject。 */
  flush(): Promise<void>;
}

/** {@link createFailureRecorder} 的輸入。 */
export interface FailureRecorderOptions {
  /** 紀錄檔的完整路徑。 */
  readonly path: string;
  /** 行程的有效帳號。 */
  readonly effective: string;
  /** 伺服器日誌。 */
  readonly log: (line: string) => void;
  /** 算 `at`，測試給固定的。 */
  readonly now?: () => Date;
  /** 等鎖多久，省略即 {@link FAILURE_RECORD_WAIT_MS}。 */
  readonly waitMs?: number;
}

/**
 * 建一支記錄器。
 *
 * @param options - 紀錄檔、帳號、日誌。
 * @returns 記錄器。
 */
export function createFailureRecorder(options: FailureRecorderOptions): FailureRecorder {
  const { path, effective, log } = options;
  const waitMs = options.waitMs ?? FAILURE_RECORD_WAIT_MS;
  // 「沒寫成」那一句，同一列歸因到同一筆只講一次：home 唯讀時不要每條 thread 都講一遍。
  const complained = new Set<string>();
  let tail: Promise<void> = Promise.resolve();

  function complain(id: string, seq: number, error: unknown): void {
    const key = `${id}\0${String(seq)}`;
    if (complained.has(key)) return;
    complained.add(key);
    const why = error instanceof Error ? error.message : String(error);
    // 錯誤文字是檔案系統或鎖的，不是設定值；原因原文不在這裡。
    log(
      `[變更紀錄] ${id} 掛不上，但這一筆 failed 沒寫成（歸因到紀錄第 ${String(seq)} 筆）：${why}`,
    );
  }

  async function handle(rows: readonly FailedRow[], at: FailureDiscovery): Promise<void> {
    if (rows.length === 0) return;
    let records;
    try {
      records = readJournal(path, {
        check: (file) => assertPrivateFile(file, JOURNAL_FILE_ROLE),
      })?.records;
    } catch {
      // 紀錄壞了、權限不對：讀清單那一步早就拋過，這裡不再多講一次。
      return;
    }
    // 紀錄檔不在：沒有任何東西指得到這一列；`appendJournalRecord` 在檔案不在時會建，所以這裡不能往下走。
    if (records === undefined) return;
    const deadline = Date.now() + waitMs;
    for (const row of rows) {
      const context: FailureContext = {
        discoveredAt: at,
        stage: row.stage,
        ...(row.newlyDropped !== undefined && { newlyDropped: row.newlyDropped }),
      };
      const trigger = failureTriggerOf(records, row, context);
      if (trigger === undefined || hasFailedRecord(records, row.id, trigger)) continue;
      try {
        const written = await appendJournalRecord(
          path,
          {
            actor: { kind: 'serve', effective },
            ...(options.now !== undefined && { now: options.now }),
            // 截半行的警告：讀端那一步已經講過，這裡不重複。
            warn: () => undefined,
            check: (file) => assertPrivateFile(file, JOURNAL_FILE_ROLE),
            waitMs: Math.max(0, deadline - Date.now()),
          },
          // **去重在鎖裡**，用現有的那份紀錄：鎖外查的那次可能已經過時（另一個 serve、或上一條 thread 剛寫了同一筆）。
          (current): JournalBody | undefined => {
            const seq = failureTriggerOf(current, row, context);
            if (seq === undefined || hasFailedRecord(current, row.id, seq)) return undefined;
            return {
              op: 'failed',
              id: row.id,
              triggerSeq: seq,
              stage: row.stage,
              reason: row.message,
            };
          },
        );
        if (written !== undefined) {
          log(
            `[變更紀錄] ${row.id} 掛不上，已記成第 ${String(written.seq)} 筆 failed` +
              `（歸因到紀錄第 ${String(trigger)} 筆，掉在「${row.stage}」；原因原文在紀錄裡）`,
          );
        }
      } catch (error) {
        complain(row.id, trigger, error);
      }
    }
  }

  return {
    note(rows, at) {
      if (rows.length === 0) return;
      const batch = [...rows];
      tail = tail.then(() => handle(batch, at)).catch(() => undefined);
    },
    flush() {
      return tail;
    },
  };
}
