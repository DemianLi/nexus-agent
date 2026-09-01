/**
 * 會話註冊表：**一次組裝裡所有會話日誌的擁有者**，以及訂閱它們的那一面。
 *
 * ## 它補的是什麼
 *
 * 在這之前，一份 `SessionLog` 是各進入點自己 `new` 出來的，而三個消費者——不變量
 * runner、`sessions` 參與者 runner、遙測協調器——由組裝點**逐份手接**。那個形狀有一個
 * 說不出口的假設：一次組裝只有一份日誌。subagent 要有自己的一份，那個假設就破了，而破掉
 * 的方式是靜默的：第二份日誌不重接就沒有不變量檢查、沒有參與者、也不進遙測，三件事都
 * 沒有任何徵兆。
 *
 * **dsh 沒有這個問題，而且不是因為它更小心。** 它的消費者訂的是 session **註冊表**，
 * 不是一份 session：
 *
 * ```ts
 * // packages/core/session/src/invariant.ts:218-220（SHA 0a53fb55bea101816fa226bb964ae2bed71c343b）
 * for (const session of ctx.sessions.list()) seedSession(session)
 * ctx.on('session/created', (session) => { seedSession(session) }, { global: true })
 * ```
 *
 * `packages/core/tools/src/invariant.ts:76-77`、`llm-retry`、`time-context`、`schedule`
 * 逐字同型；遙測的 coordinator 檔頭寫的是 “subscribes to the session firehose” 加
 * “sweeps already-live sessions”；投影是 `ctx.sessionProjections.register(...)` 註冊一次、
 * 讀的時候才 per session 求值。而 subagent 的 session 就是一般的 session——
 * `subagent-spawn-in-process` 的檔頭寫著子代理跑在 **“the same cordis context”** 上，
 * 同一個 context 就是同一批訂閱者。
 *
 * **所以「第二份日誌要不要接上那三個消費者」在標準那側不是一個問題**，它是這個註冊表
 * 不存在造出來的問題。這個模組把它取消掉，而不是回答它。調研見
 * `.docs/subagent-session-log-survey.md`。
 *
 * ## 與 dsh 的偏離，兩條
 *
 * 1. **日誌在第一次要寫的時候才出生，不是在 spawn 的時候。** dsh 的 subagent provider
 *    自己呼叫 `createAgent`，session 是 spawn 的產物。**我們沒有那個 spawn 點**——
 *    subagent 是基座的 `task` middleware 跑的，它不通知任何人。退到：
 *    {@link SessionRegistry.open} 由 {@link ./session-address.ts | 身分} 懶建。
 *
 *    代價講明白：**一個從頭到尾沒寫過日誌的 subagent 不會有日誌**，所以它不會出現在
 *    `list()` 裡，遙測上也看不到它跑過。那是「少了一筆」，不是「跟別人混在一起」——
 *    這條路上唯一不能接受的失敗是後者。
 * 2. **session 不會中途關掉。** dsh 的 session 有 `dispose`，子代理跑完它就走了。我們
 *    看不到「跑完」這件事（同上，沒有 spawn 點就沒有 join 點），所以每一份日誌活到整個
 *    註冊表被丟掉為止，也就是一次組裝的壽命。**這是刻意的**：猜一個結束時機的代價是把
 *    還在寫的日誌收掉，而那會讓寫入靜默失敗。
 *
 * @module
 */

import { SessionLog } from './session-log.js';
import type { SessionLogOptions } from './session-log.js';
import { sessionAddressKey } from './session-address.js';
import type { SessionAddress } from './session-address.js';

/** 註冊表裡的一份會話。 */
export interface SessionEntry {
  /** 這一份屬於誰。 */
  readonly address: SessionAddress;
  /** 它的日誌。**寫得動**——同 `registry.sessions` 那條路交出去的東西。 */
  readonly log: SessionLog;
}

/** 一位訂閱者。**每一份會話叫一次**，包含訂閱當下已經在的那些。 */
export type SessionObserver = (entry: SessionEntry) => void;

/** 建一張註冊表要的東西。 */
export interface SessionRegistryOptions {
  /**
   * 每一份日誌的建構選項，**原樣轉給每一個 `new SessionLog(...)`**。
   *
   * 一份而不是逐份，因為它今天只有 `onListenerError` 一格，而那一格答的是「這次組裝的
   * warn 往哪裡去」——那是組裝點的事，不是某一份會話的事。
   */
  readonly logOptions?: SessionLogOptions;
}

/**
 * 一次組裝的所有會話日誌。
 *
 * root 那一份在建構時就開好，所以 {@link list} 永遠不是空的——「還沒有任何會話」不是一個
 * 這裡表達得出來的狀態，也不該是：一次組裝一定有 root。
 */
export class SessionRegistry {
  readonly #rootSessionId: string;
  readonly #logOptions: SessionLogOptions;
  /** 以 {@link sessionAddressKey} 為鍵，插入序（root 永遠第一個）。 */
  readonly #entries = new Map<string, SessionEntry>();
  readonly #observers = new Set<SessionObserver>();

  /**
   * @param rootSessionId - root 會話的 id。subagent 的 id 由它加上 `runId` 推出來。
   * @param options - 每一份日誌共用的建構選項。
   */
  constructor(rootSessionId: string, options: SessionRegistryOptions = {}) {
    this.#rootSessionId = rootSessionId;
    this.#logOptions = options.logOptions ?? {};
    this.#create({ kind: 'root' });
  }

  /** root 的那一份。進入點記 `turn/*` 與 `command/*` 用的就是它。 */
  get root(): SessionLog {
    // 建構時開好的，一定在。
    return this.#entries.get(sessionAddressKey({ kind: 'root' }))!.log;
  }

  /**
   * 這個身分的那一份，**沒有就開一份**。
   *
   * 開新的那一次，訂閱者**同步**收到通知，而且是在這個方法回傳之前——呼叫的人拿到日誌
   * 的下一件事通常就是往裡面寫，那一筆必須已經在每一位訂閱者的射程內。
   *
   * @param address - 誰要的。
   * @returns 它的日誌。
   */
  open(address: SessionAddress): SessionLog {
    const key = sessionAddressKey(address);
    const existing = this.#entries.get(key);
    if (existing !== undefined) return existing.log;
    const entry = this.#create(address);
    for (const observer of [...this.#observers]) observer(entry);
    return entry.log;
  }

  /**
   * 這個身分的那一份，**沒有就是沒有**。
   *
   * @param address - 要找誰的。
   * @returns 它的日誌，或 `undefined`。
   */
  get(address: SessionAddress): SessionLog | undefined {
    return this.#entries.get(sessionAddressKey(address))?.log;
  }

  /**
   * 目前開著的每一份，插入序（root 第一個）。
   * @returns 每一份的身分與日誌。
   */
  list(): readonly SessionEntry[] {
    return [...this.#entries.values()];
  }

  /**
   * 訂閱：**先掃一遍現在有的，再收後面開的**。
   *
   * 順序照 dsh 那兩行（`list()` 之後才 `on('session/created')`），理由是同一個：反過來
   * 的話，掃到一半開出來的那一份會被送兩次。
   *
   * 訂閱者拋錯**不接**——它跑在 {@link open} 的呼叫堆疊上，而那多半是某顆工具的第一次
   * 寫入。把錯吞掉的話，「這份會話沒有被任何人接上」會是一個沒有徵兆的狀態，而那正是
   * 這張註冊表要消滅的東西。接住它是各消費者自己的事（三個 runner 都各自圍堵參與者）。
   *
   * @param observer - 每一份會話叫一次。
   * @returns 退訂。冪等。**不收拾訂閱者已經建起來的東西**——那歸訂閱者自己。
   */
  observe(observer: SessionObserver): () => void {
    for (const entry of [...this.#entries.values()]) observer(entry);
    this.#observers.add(observer);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#observers.delete(observer);
    };
  }

  /** 開一份並登記，不通知任何人（通知的時機歸 {@link open}）。 */
  #create(address: SessionAddress): SessionEntry {
    const entry: SessionEntry = {
      address,
      log: new SessionLog(this.#sessionIdFor(address), this.#logOptions),
    };
    this.#entries.set(sessionAddressKey(address), entry);
    return entry;
  }

  /**
   * 日誌的 id。
   *
   * subagent 的接在 root 後面，對到 dsh 的 `header.parentSession`——**血緣要讀得出來**，
   * 因為遙測的每一筆記錄都帶 `session.id`，而那是外面唯一分得出「這筆是誰寫的」的東西。
   */
  #sessionIdFor(address: SessionAddress): string {
    return address.kind === 'root'
      ? this.#rootSessionId
      : `${this.#rootSessionId}/${address.runId}`;
  }
}
