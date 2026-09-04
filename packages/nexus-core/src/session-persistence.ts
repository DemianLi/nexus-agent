/**
 * 持久化的**捕獲協調器**：訂閱一份 {@link ./session-log.ts | SessionLog}，把事件經有界的
 * write-behind 窗口交給 {@link ./session-store.ts | StoredSession}。
 *
 * 形狀照 dsh 的 flush 檢查點（`docs/subsystems/persistence.zh.md`，SHA `d347e703`）：
 * `session/event` 是一個**同步通知**，後端把它路進活躍寫把手的有界窗口而**不阻塞生產方**；
 * 第一顆待處理事件開窗，後續事件加入但**不重置截止時間**。
 *
 * ## 圍堵那一條跟遙測是反的，這是這個模組存在的理由
 *
 * {@link ./session-telemetry-coordinator.ts | SessionTelemetryCoordinator} 是**盡力而為的
 * 旁路**：它圍堵一切，後端壞掉只換一行 warn，因為遙測不能有能力扳倒 agent loop。
 * **持久化不是旁路，它有耐久屏障。** dsh 的規則是：背景寫入被拒時**按序保留對應事件、
 * 暫停自動路徑、經 logger 報告；下一次顯式 flush 重試，並向它的呼叫方響亮地拒絕**。
 *
 * 抄前者而不翻這一條，複製出來的就是
 * [#170](https://github.com/DemianLi/nexus-agent/issues/170) 那個形狀——寫失敗了，
 * 沒有人聽得見。
 *
 * **而且這裡有一個會讓它靜默的機關要繞開。** `SessionLog.#publish` 把 listener 的回傳值
 * 包進 `Promise.resolve(returned).catch(...)`，所以一個 reject 掉的 listener 只換來一行
 * 「觀察者 reject 了」——跟一個壞掉的觀察者長得**一模一樣**。所以這裡的 listener
 * {@link SessionPersistenceCoordinator} 自己吞下寫入失敗（保留、暫停、warn），
 * **耐久失敗唯一響亮的出口是 {@link SessionPersistenceCoordinator.flush}**。
 *
 * @see [#172](https://github.com/DemianLi/nexus-agent/issues/172)
 * @module
 */

import type { SessionEvent, SessionLog } from './session-log.js';
import { SESSION_LOG_FORMAT_VERSION } from './session-store.js';
import type { SessionStore, StoredSession, StoredSessionHeader } from './session-store.js';
import type { SessionRegistry } from './session-registry.js';

/** 第一顆待處理事件開的批次窗口，毫秒。 */
export const DEFAULT_PERSISTENCE_WINDOW_MS = 10;

export interface SessionPersistenceCoordinatorOptions {
  /** 要落盤的日誌。 */
  readonly log: SessionLog;
  /** 收事件的把手。**這裡擁有它**——{@link SessionPersistenceCoordinator.dispose} 會關掉它。 */
  readonly stored: StoredSession;
  /**
   * 背景寫入被拒時往哪裡講。省略即 `console.warn`。
   *
   * **這一行是「自動路徑暫停了」的唯一外顯**，測試靠它驗暫停真的發生過——而不是靠
   * 觀察一次沒有徵兆的靜默。
   */
  readonly warn?: (message: string) => void;
  /** 批次窗口，毫秒。省略即 {@link DEFAULT_PERSISTENCE_WINDOW_MS}。 */
  readonly windowMs?: number;
}

/**
 * 一份日誌一個。
 *
 * 建構當下**先把日誌裡已經有的東西排進待處理佇列**再訂閱後續——`subscribe` 明文不補發
 * 歷史，而協調器晚於日誌成立是常態（日誌在註冊表建構時就開好了）。
 */
export class SessionPersistenceCoordinator {
  readonly #stored: StoredSession;
  readonly #warn: (message: string) => void;
  readonly #windowMs: number;
  /** 還沒被接受的事件，**照 seq 排**。寫入失敗時整批留在頭上，順序不動。 */
  readonly #pending: SessionEvent[] = [];
  #unsubscribe: (() => void) | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** 飛在空中的那一次排空。同一時間只有一次。 */
  #inflight: Promise<void> | undefined;
  /**
   * 自動路徑暫停的理由，沒暫停時是 `undefined`。
   *
   * 暫停之後**不再開新的窗口**——重試歸下一次顯式 {@link flush}。這是 dsh 的
   * 「暂停自动路径」：背景一直重試只會把同一個失敗刷成一片 warn。
   */
  #paused: Error | undefined;
  #disposed = false;

  constructor(options: SessionPersistenceCoordinatorOptions) {
    this.#stored = options.stored;
    this.#warn =
      options.warn ??
      ((message) => {
        console.warn(message);
      });
    this.#windowMs = options.windowMs ?? DEFAULT_PERSISTENCE_WINDOW_MS;
    this.#pending.push(...options.log.events);
    this.#unsubscribe = options.log.subscribe((event) => {
      this.#pending.push(event);
      this.#schedule();
    });
    this.#schedule();
  }

  /** 還沒被後端接受的筆數。暫停期間它不會歸零——那正是「按序保留」的外顯。 */
  get pending(): number {
    return this.#pending.length;
  }

  /** 自動路徑現在是不是暫停著。 */
  get paused(): boolean {
    return this.#paused !== undefined;
  }

  /**
   * 耐久屏障：排空到完全停穩，再要後端把東西真的寫下去。
   *
   * **這是唯一會響亮拒絕的地方。** 背景那條路被拒時只保留與 warn，下一次 flush 重試；
   * 重試再失敗，錯誤就往呼叫方走。
   *
   * @throws 排空或後端的 flush 失敗。
   */
  async flush(): Promise<void> {
    this.#cancelTimer();
    // 排到停穩：`#drain` 每次只送出當下看得到的那一批，中途進來的下一圈再送。
    while (this.#pending.length > 0) await this.#run();
    await this.#stored.flush();
    this.#paused = undefined;
  }

  /**
   * 收掉：退訂、做最後一次 flush、關掉把手。呼叫第二次是 no-op。
   *
   * **會拒絕**，而且刻意的：收尾時吞掉寫入失敗，等於讓一次靜默的資料遺失看起來像正常
   * 關機。這跟遙測那個「後端 reject 只換一行 warn」的 `dispose` 是相反的選擇，理由見
   * 模組說明。
   *
   * @throws 最後那次 flush 或 `close()` 失敗。
   */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#cancelTimer();
    try {
      await this.flush();
    } finally {
      await this.#stored.close();
    }
  }

  /** 開窗。**第一顆開，後續的加入但不重置截止時間**（dsh 同條）。暫停期間不開。 */
  #schedule(): void {
    if (this.#disposed || this.#paused !== undefined) return;
    if (this.#timer !== undefined || this.#pending.length === 0) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      // 背景這條路不拒絕給任何人——失敗已經在 `#drain` 裡保留、暫停並 warn 過了。
      // 不接住它會變成 unhandled rejection，在 Node 預設設定下直接殺掉行程。
      void this.#run().catch(() => {});
    }, this.#windowMs);
    // 一個等著寫的批次不該讓行程活下去。
    this.#timer.unref?.();
  }

  #cancelTimer(): void {
    if (this.#timer === undefined) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** 序列化排空：同一時間只有一次 append 在飛。 */
  #run(): Promise<void> {
    this.#inflight ??= this.#drain().finally(() => {
      this.#inflight = undefined;
    });
    return this.#inflight;
  }

  /**
   * 把當下看得到的整批送出去。成功就從佇列前面移掉那麼多筆。
   *
   * 失敗時**整批留在頭上**（順序不動）、暫停自動路徑、warn 一行，然後往上拋——呼叫端
   * 是 {@link flush}（要聽見）或窗口（吞掉）。
   */
  async #drain(): Promise<void> {
    while (this.#pending.length > 0) {
      const batch = this.#pending.slice();
      try {
        await this.#stored.append(batch);
      } catch (error: unknown) {
        const failure = error instanceof Error ? error : new Error(String(error));
        this.#paused = failure;
        this.#warn(
          `會話日誌寫入被拒，${this.#pending.length} 筆保留、自動寫入暫停，` +
            `下一次 flush 會重試：${failure.message}`,
        );
        throw failure;
      }
      // 等待期間可能又進來幾筆，所以移掉的是「送出去的那些」而不是全部。
      this.#pending.splice(0, batch.length);
    }
  }
}

/**
 * 把一次組裝的**每一份**會話日誌接上持久化。
 *
 * **接在註冊表上，不是接在一份日誌上。** 這是 dsh 的形狀（消費者訂的是 session 註冊表：
 * `for (const session of ctx.sessions.list()) …` 加 `ctx.on('session/created', …)`），
 * 也是這裡唯一正確的選擇：subagent 的日誌是**第一次有人要寫的時候才出生的**
 * （`SessionRegistry` 的偏離 1），接在進入點會漏掉它們，而且漏得沒有徵兆。
 *
 * @param sessions - 這次組裝的會話註冊表。
 * @param store - 後端。
 * @param options - `cwd` 進 header；`warn` 轉給每個協調器。
 * @returns `flush()` 把每一份都排空（響亮）；`dispose()` 退訂並收掉每一份（響亮）。
 */
export function attachSessionPersistence(
  sessions: SessionRegistry,
  store: SessionStore,
  options: { readonly cwd?: string; readonly warn?: (message: string) => void } = {},
): { flush(): Promise<void>; dispose(): Promise<void> } {
  const coordinators: SessionPersistenceCoordinator[] = [];
  const unobserve = sessions.observe(({ address, log }) => {
    const header: StoredSessionHeader = {
      version: SESSION_LOG_FORMAT_VERSION,
      id: log.sessionId,
      createdAt: Date.now(),
      ...(options.cwd !== undefined && { cwd: options.cwd }),
      // 血緣：subagent 那些的 id 是 `<root>/<runId>`，root 就是它的父。
      ...(address.kind === 'subagent' && { parentSession: sessions.root.sessionId }),
    };
    coordinators.push(
      new SessionPersistenceCoordinator({
        log,
        stored: store.create(header),
        ...(options.warn !== undefined && { warn: options.warn }),
      }),
    );
  });
  return {
    async flush() {
      for (const coordinator of [...coordinators]) await coordinator.flush();
    },
    async dispose() {
      unobserve();
      // 倒著收，同 `agent-factory.ts` 收 runner 的順序。
      for (const coordinator of [...coordinators].reverse()) await coordinator.dispose();
      coordinators.length = 0;
    },
  };
}
