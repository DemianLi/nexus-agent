/**
 * 會話事件日誌——一份 per-session 的 append-only 序列，`seq` 由日誌長度決定。
 *
 * **這一層存在的理由是序號要有一個擁有者。**
 * [#89](https://github.com/DemianLi/nexus-agent/issues/89) 的決議是 (B)：遙測的 ledger
 * 記錄要鏡像會話事件、靠 `(session.id, seq)` 去重，而在這之前 nexus 沒有任何一個
 * append-only 序列可以鏡像——checkpointer 是 `MemorySaver`，只存狀態不存事件。
 *
 * **`seq` 出自 `this.#events.length`，不出自任何傳輸層。** 這不是風格選擇，是調研
 * 六個專案之後唯一的共同做法（見 `.docs/session-event-log-survey.md`）：dsh
 * `seq: this.log.length`、SWE-agent `n_step = len(self.trajectory) + 1`、
 * Codex CLI 由 recorder 自己持有 `ordinal`、Gemini CLI 每次寫入回讀磁碟重算。
 * **沒有一個拿 UI／傳輸層的計數器當耐久序號。**
 *
 * 反面教材同樣量到了：唯一 UI 與 API 各存一份的 Cline，兩份都沒有序號——它沒掉進
 * 「兩套編號」的坑，是因為它根本沒編號。所以
 * {@link ../../../apps/harness/src/thread-pump.ts | ThreadPump} 的 `#seq`
 * **要繼續留著、也不要去讀這裡的號**：那個是傳輸層給瀏覽器排序去重用的，這裡的是耐久
 * 序號，兩個號兩個工作。讓其中一個去冒充另一個，正是 (A) 被否掉的理由。
 *
 * **這一版刻意不記訊息內容。** 兩條路拿得到的顆粒度不一樣——web 那條經
 * `streamEvents` 收到的是 `messages` **分片**，CLI 那條經 `stream(['updates'])` 收到的是
 * **完整訊息**。要把兩者記成同一種事件，得在某一側重組，而重組出來的東西是合成的、
 * 不是量到的。v1 只收兩條路都**原樣**產得出來的那個交集：turn 邊界、中斷、失敗。
 * 補訊息是後面的事，補的時候要先講清楚顆粒度怎麼對齊。
 */

/** 這一版收得下的事件種類。**加種類要同時回答「兩條路都產得出來嗎」。** */
export type SessionEventType = 'turn/start' | 'turn/end' | 'turn/failed' | 'interrupt/raised';

/** 每一種事件帶什麼。 */
export interface SessionEventMap {
  /** 一輪開始。`resume` 是回覆核准，它沒有使用者說的話。 */
  'turn/start': { readonly kind: 'message'; readonly text: string } | { readonly kind: 'resume' };
  /** 一輪正常結束——**跑完與停在核准點都算**，停在核准點時前面會有一顆 `interrupt/raised`。 */
  'turn/end': Record<string, never>;
  /** 一輪拋錯結束。只留訊息，堆疊不進日誌。 */
  'turn/failed': { readonly message: string };
  /** 掛上了一顆等人回答的中斷。 */
  'interrupt/raised': { readonly interruptId: string };
}

/** 日誌裡的一筆。凍過的，拿到之後改不動。 */
export interface SessionEvent<T extends SessionEventType = SessionEventType> {
  readonly type: T;
  /** 這一筆在這份日誌裡的位置。**append 當下由長度決定**，一個 session 內單調遞增。 */
  readonly seq: number;
  /** Unix epoch 毫秒。 */
  readonly time: number;
  readonly data: SessionEventMap[T];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * 深拷貝成純 JSON，**拷不動就當場拋**。
 *
 * 這一條是 fail-closed 的，照 dsh `Session.append` 的
 * `snapshotJsonValue`（`packages/core/session/src/index.ts`）。**存參考會讓日誌變成活的**
 * ——LangGraph 的 payload 帶的是 `BaseMessage` 實例，存進去之後別人改那顆訊息，
 * 歷史就跟著被改寫，而且沒有任何徵兆。所以這裡連 class 實例都不收，只認
 * null / boolean / 有限 number / string / 陣列 / 純物件。
 */
function snapshotJsonValue(value: unknown, path: string, seen: Set<object>): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`會話事件的 ${path} 是 ${String(value)}，JSON 表達不出來`);
    }
    return value;
  }
  if (typeof value === 'object' && seen.has(value)) {
    throw new TypeError(`會話事件的 ${path} 繞回自己，日誌不收循環參考`);
  }
  if (Array.isArray(value)) {
    seen.add(value);
    const copy = value.map((entry, index) => snapshotJsonValue(entry, `${path}[${index}]`, seen));
    seen.delete(value);
    return copy;
  }
  if (isPlainObject(value)) {
    seen.add(value);
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      copy[key] = snapshotJsonValue(entry, `${path}.${key}`, seen);
    }
    seen.delete(value);
    return copy;
  }
  throw new TypeError(
    `會話事件的 ${path} 是 ${value === undefined ? 'undefined' : typeof value}，日誌只收純 JSON`,
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

/** 日誌的觀察者。**同步呼叫，在事件已經進到日誌之後**。 */
export type SessionLogListener = (event: SessionEvent) => void;

/** 建一份日誌時可以換掉的東西。 */
export interface SessionLogOptions {
  /**
   * 某個 listener 拋錯或 reject 時往哪裡講。省略即 `console.warn`。
   *
   * 這是一個縫而不是寫死 `console`，因為「listener 拋了但日誌沒事」這件事**只能靠它
   * 驗**——圍堵成功的外顯就是這一行 warn，沒有它測試只能斷言「沒拋」，斷言不到
   * 「有被記下來」。
   */
  readonly onListenerError?: (message: string) => void;
}

/**
 * 一個 session 一份。
 *
 * **`append` 會同步回呼觀察者，所以它帶著一道重入防護。** 順序照 dsh 的
 * `Session.append`（`references/deepseek-harness/packages/core/session/src/index.ts:614-654`）：
 * **先驗 → 先算好 listener 清單 → 推進日誌 → 才回呼**。觀察者被叫到的時候，日誌裡
 * 已經有這一筆了——遙測協調器讀 `event.seq` 當去重鍵，看到的必須是已定案的日誌。
 *
 * 三道防護，三個不同的東西：
 *
 * 1. **重入**——回呼裡再 `append` 直接拋。listener 清單是在推進前就凍住的，回呼中途
 *    插進來的那一筆會拿到一份算舊了的清單、而且會讓「誰看到什麼」變成呼叫順序的
 *    函數。dsh 拋的是 `session append cannot reenter while another append is being
 *    published`，同一件事。
 * 2. **圍堵**——每個 listener 各自 try / catch，拋錯只換來一行 warn。遙測是盡力而為的
 *    旁路，**不能有能力扳倒 agent loop**。
 * 3. **不中斷**——前一個 listener 拋錯不影響後面的。照 dsh 的
 *    `invokeContainedSessionObservers`：一個訂閱者壞掉不該餓死其他訂閱者。
 */
export class SessionLog {
  readonly #sessionId: string;
  readonly #events: SessionEvent[] = [];
  readonly #listeners = new Set<SessionLogListener>();
  readonly #onListenerError: (message: string) => void;
  /** 正在回呼中。重入防護唯一的狀態。 */
  #publishing = false;

  constructor(sessionId: string, options: SessionLogOptions = {}) {
    this.#sessionId = sessionId;
    this.#onListenerError =
      options.onListenerError ??
      ((message) => {
        console.warn(message);
      });
  }

  /** 這份日誌屬於誰。遙測的 `session.id` 就是它。 */
  get sessionId(): string {
    return this.#sessionId;
  }

  /** 目前為止的全部事件，照 `seq` 排。**回的是副本**，拿去改動不到日誌。 */
  get events(): readonly SessionEvent[] {
    return [...this.#events];
  }

  /** 目前的長度，也就是下一筆會拿到的 `seq`。 */
  get length(): number {
    return this.#events.length;
  }

  /**
   * 訂閱後續的事件。**不補發歷史**——訂閱之前的那些要自己讀 {@link events}，
   * 協調器就是這樣接上一份已經有內容的日誌的。
   *
   * @param listener - 每筆事件進到日誌之後被同步呼叫；拋錯會被圍堵成一行 warn。
   * @returns 只退訂這一次的冪等函式。
   */
  subscribe(listener: SessionLogListener): () => void {
    this.#listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#listeners.delete(listener);
    };
  }

  /**
   * 記一筆，回傳記進去的那一筆。
   *
   * @throws `data` 帶了 JSON 表達不出來的東西（class 實例、函式、`undefined`、
   *   `NaN`、循環參考）——**當場拋，日誌不變**。
   * @throws 在某個 listener 的回呼裡被呼叫——重入防護，見 class 註解。
   */
  append<T extends SessionEventType>(type: T, data: SessionEventMap[T]): SessionEvent<T> {
    // 先驗再推進：拷不動的話這一筆整個不算，日誌不會留下半筆。
    const snapshot = snapshotJsonValue(data, `${type} 的 data`, new Set()) as SessionEventMap[T];
    if (this.#publishing) {
      throw new Error(
        `會話 "${this.#sessionId}" 的 append 不能在另一次 append 的回呼裡重入` +
          `（想記的是 "${type}"）。要在觀察到事件之後再記一筆，把它排到下一個 tick。`,
      );
    }
    const event = deepFreeze<SessionEvent<T>>({
      type,
      seq: this.#events.length,
      time: Date.now(),
      data: snapshot,
    });
    // 清單先凍住：回呼期間的訂閱／退訂不影響這一輪看得到誰。
    const listeners = [...this.#listeners];
    this.#events.push(event);
    if (listeners.length === 0) return event;
    this.#publishing = true;
    try {
      for (const listener of listeners) this.#publish(listener, event);
    } finally {
      this.#publishing = false;
    }
    return event;
  }

  /** 叫一個 listener，把它的同步例外與非同步 reject 都收成一行 warn。 */
  #publish(listener: SessionLogListener, event: SessionEvent): void {
    try {
      const returned: unknown = listener(event);
      // 型別上 listener 回 void，但 JS 那側塞得進 async 函式——不接住的話它的 reject
      // 會變成 unhandled rejection，在 Node 預設設定下是直接殺掉整個行程。
      void Promise.resolve(returned).catch((error: unknown) => {
        this.#onListenerError(
          `會話 "${this.#sessionId}" 的 ${event.type} 觀察者 reject 了：${String(error)}`,
        );
      });
    } catch (error: unknown) {
      this.#onListenerError(
        `會話 "${this.#sessionId}" 的 ${event.type} 觀察者拋了：${String(error)}`,
      );
    }
  }
}
