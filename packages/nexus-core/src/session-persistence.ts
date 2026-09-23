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

import { z } from 'zod';

import type { NexusPlugin } from './plugin.js';
import type { PluginRegistry } from './registry.js';
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
  /**
   * 日誌前面有幾筆**已經在把手那一側了**。省略即 0。
   *
   * 續接（[#251](https://github.com/DemianLi/nexus-agent/issues/251) 的門 A）用它：一份帶
   * seed 開出來的日誌，seed 那幾筆就是從把手讀回來的，再送一次會跟已存的撞號。照 dsh 的
   * `storedCount` ＋ `appendUnstoredSuffix`——只寫還沒存的後綴，第一筆就是那顆
   * `session/end-seed`。
   */
  readonly storedCount?: number;
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
    const storedCount = options.storedCount ?? 0;
    if (!Number.isSafeInteger(storedCount) || storedCount < 0 || storedCount > options.log.length) {
      throw new Error(
        `會話 "${options.log.sessionId}" 的已存筆數 ${String(storedCount)} 對不上日誌長度 ` +
          `${String(options.log.length)}。`,
      );
    }
    this.#pending.push(...options.log.events.slice(storedCount));
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
 * @param options - `cwd` 與 `workspaceRoot` 進 header；`warn` 轉給每個協調器；`resumedRoot`
 *   是續接時 root 那一份**接著寫**的把手與它已存的筆數——給了就不替 root `create`（見
 *   {@link SessionPersistenceCoordinatorOptions.storedCount}）。subagent 那些照常 `create`：
 *   它們是這個行程新開的。
 *
 *   **`resumedRoot` 那條路把這裡建的 header 整個丟掉**，而那正是「續接不回填 `workspaceRoot`」
 *   自動成立的機制（[#504](https://github.com/DemianLi/nexus-agent/issues/504)）：一份舊日誌
 *   接回來之後 header 的 `version` 會升到這一版（那是 `jsonl-session-store.ts` 覆寫的），
 *   但**不會**長出這一格。同一個 run 目錄裡因此可能「root 沒有、subagent 有」——subagent
 *   那些日誌是這個行程新生的，它們的根就是這一次的根，所以那是對的，不要改成回填。
 * @returns `flush()` 把每一份都排空（響亮）；`dispose()` 退訂並收掉每一份（響亮）。
 */
export function attachSessionPersistence(
  sessions: SessionRegistry,
  store: SessionStore,
  options: {
    readonly cwd?: string;
    readonly workspaceRoot?: string;
    readonly warn?: (message: string) => void;
    readonly resumedRoot?: { readonly stored: StoredSession; readonly storedCount: number };
    /**
     * 批次窗口，毫秒。省略即 {@link DEFAULT_PERSISTENCE_WINDOW_MS}。
     *
     * **一路轉發給每一份協調器**——這個行程裡的每一條會話（root 與 subagent）共用同一個
     * 節奏。那是刻意的：窗口描述的是**這一台機器的落盤代價**，不是某一條會話的性質。
     */
    readonly windowMs?: number;
  } = {},
): { flush(): Promise<void>; dispose(): Promise<void> } {
  const coordinators: SessionPersistenceCoordinator[] = [];
  const unobserve = sessions.observe(({ address, log }) => {
    const header: StoredSessionHeader = {
      version: SESSION_LOG_FORMAT_VERSION,
      id: log.sessionId,
      createdAt: Date.now(),
      ...(options.cwd !== undefined && { cwd: options.cwd }),
      // 沒跑在工作區底下就不寫這一格（#504）。**缺席與空字串不是同一件事**：續接的守衛
      // 對「沒記」放行，而對任何記下來的值逐字比。
      ...(options.workspaceRoot !== undefined && { workspaceRoot: options.workspaceRoot }),
      // 血緣：subagent 那些的 id 是 `<root>/<runId>`，root 就是它的父。
      ...(address.kind === 'subagent' && { parentSession: sessions.root.sessionId }),
    };
    const resumed = address.kind === 'root' ? options.resumedRoot : undefined;
    coordinators.push(
      new SessionPersistenceCoordinator({
        log,
        stored: resumed?.stored ?? store.create(header),
        ...(resumed !== undefined && { storedCount: resumed.storedCount }),
        ...(options.warn !== undefined && { warn: options.warn }),
        ...(options.windowMs !== undefined && { windowMs: options.windowMs }),
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

/**
 * `setTimeout` 收得住的最大延遲。
 *
 * **超過它不是「窗口更長」，是窗口消失**：Node 對超出 32 位元的延遲印一行警告然後**立刻**
 * 觸發，於是 `windowMs: 1e10` 的實際行為跟 `windowMs: 0` 一樣——每一顆事件各寫一次。
 * 這個方向的壞值最貴，因為它長得像「我把落盤調得很懶」而實際上是最勤的那一種，所以擋在
 * schema 上，載入期就失敗。
 *
 * 同 `@nexus/plugin-telemetry-otel` 對 `shutdownTimeoutMillis` 的檢查，也同 dsh
 * （`packages/util/timeout/src/index.ts:25` 的 `MAX_TIMER_DELAY_MS`，`ddefc45`）。
 */
export const MAX_PERSISTENCE_WINDOW_MS = 2_147_483_647;

/**
 * 這個條目的 plugin 名。
 *
 * 刻意不是條目的 `id`——id 是使用者的 patch 改得動的字串，同
 * {@link ./tool-result-pruner.ts | TOOL_RESULT_PRUNER_PLUGIN_NAME}。
 */
export const SESSION_PERSISTENCE_PLUGIN_NAME = 'session-persistence';

/**
 * 條目收的設定。一格，`strictObject`：多寫一個欄位是打錯字，不是擴充點。
 *
 * **下限是 0 而不是 1**：`windowMs: 0` 是「不批次，每一顆事件各寫一次」，一個講得出來的
 * 部署選擇（同 dsh `settings-file` 的 `debounceMs`，它的 `z.number().min(0)` 與專門測零值
 * 的那條 spec）。上限見 {@link MAX_PERSISTENCE_WINDOW_MS}。
 */
export const sessionPersistenceConfigSchema = z.strictObject({
  /** 見 {@link DEFAULT_PERSISTENCE_WINDOW_MS}。 */
  windowMs: z
    .number()
    .int()
    .min(0)
    .max(MAX_PERSISTENCE_WINDOW_MS)
    .default(DEFAULT_PERSISTENCE_WINDOW_MS),
});

/** {@link sessionPersistenceConfigSchema} 驗完的形狀。 */
export type SessionPersistenceConfig = z.infer<typeof sessionPersistenceConfigSchema>;

/**
 * 落盤批次窗口的**設定條目**（[#457](https://github.com/DemianLi/nexus-agent/issues/457)／
 * [#529](https://github.com/DemianLi/nexus-agent/issues/529)）。
 *
 * **這一顆不裝功能，只講設定**，`apply` 是空的、也不註冊服務。
 *
 * ## 為什麼是空的 `apply`
 *
 * 同一份出貨清單上，`@nexus/core` 那幾列（#456）的消費者是 `foldRegistry`，**註冊表就在
 * 手上**，所以它們的 `apply` 提供一顆服務、fold 去讀。這一列做不到那件事：它的兩個消費點
 * 是 `cli.ts` 與 `serve.ts` 裡呼叫 {@link attachSessionPersistence} 的那兩行，跑在
 * `createCliAgent` **回來之後**——而那個函式一格註冊表都沒有回傳。
 *
 * 更硬的理由是**壽命**：窗口描述的是那一顆 `SessionStore` 的寫入節奏，而 store 在 serve 上
 * 是**整台伺服器一份**；註冊表在 serve 上是**一條 thread 一份**。拿 per-thread 的服務去供
 * per-process 的資源，第二條 thread 進來那天就對不上了。
 *
 * 所以值由 `apps/harness` 的 `startupSetting` 在起動期解一次、往下傳一份——形狀上仍是
 * 「值從一個地方來」，機制上不是服務。那條退讓登記在 #529 上，射程是 `startupSetting`
 * 的呼叫者。
 *
 * ## 與 dsh 的關係
 *
 * **dsh 對這個值沒有意見。** 它的 `@deepseek-ai/dsh-session-persistence-jsonl` 只收兩格
 * （`root`、`compression`，`packages/session/session-persistence-jsonl/src/index.ts:236-239`，
 * `ddefc45`），沒有批次窗口——因為 dsh 的批次是**呼叫端傳一整批**
 * （`packages/session/session-persistence/src/handle.ts:86-94`：「Append a contiguous batch」），
 * 不是我們這種計時器攢批。所以這一列的形狀抄的是同一份清單上 core 那幾列，不是抄 dsh 的
 * 某一列；這不是「表達不出來」的偏離，是標準沒有這個旋鈕。
 *
 * ## 這一列關不掉
 *
 * `disabled: true` 在載入期當場拋（`apps/harness` 的 `PROTECTED_ENTRY_REASONS`）。理由同
 * 起動期那幾列：`startupSetting` 把關掉的那一列當成沒有那一列，於是回到 schema 的預設值
 * ——落盤照樣批次、照樣是 10 毫秒，只有讀設定的人以為自己關掉了什麼。
 */
export const sessionPersistencePlugin: NexusPlugin<SessionPersistenceConfig> = {
  name: SESSION_PERSISTENCE_PLUGIN_NAME,
  Config: sessionPersistenceConfigSchema,
  apply: (_registry: PluginRegistry, _config: SessionPersistenceConfig): void => {
    // 空的，見檔頭：組裝期沒有消費者，發一顆服務只會讓人以為有人在讀。
  },
};

export default sessionPersistencePlugin;
