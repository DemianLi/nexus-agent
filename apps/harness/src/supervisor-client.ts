/**
 * 前台這一側的監督行程控制面（[#2341](https://github.com/DemianLi/nexus-agent/issues/2341)，設計 `.docs/supervisor-1947-design-2026-11-03.md` §五）：
 * 前台的 stdin 收 {@link FrontEvent}、stdout 送 {@link FrontRequest}，格式見 `supervisor-protocol.ts`。
 *
 * - **`ensure` 的回答是 `up`、`down` 或 `capacity`**，以 thread 為單位：同一條 thread 同時有幾個人在等，一則回答全部了結。
 *   `down(evicted)` 不了結：監督行程在等 `drain` 回答時又被 `ensure` 到、結果回了 `drained`，會先送 `down(evicted)`，
 *   接著重算名額再回 `up` 或 `capacity`（`native/sandbox-spawner/README.md` 的逐出那一條）。
 * - **活著的行程表只由 `up`／`down` 維護**。前台重啟之後監督行程先把每條活著的送一次 `up`，表就這樣重建，不用另外問。
 * - 控制通道斷了（監督行程走了），在等的全部丟錯，之後的 `ensure` 也直接丟。
 * - **第一框是 `hello`**：建構時就先送自己的；監督行程送來的第一框也要是版本相等的 `hello`，帶著連宿主用的 token
 *   （{@link SupervisorClient.hostToken}）。不是就當控制通道壞了。
 * - 收到 `stop-admission`（監督行程要停機）就呼叫 `onStopAdmission`，回來之後回 `admission-stopped`。
 *
 * @module
 */

import type { Readable, Writable } from 'node:stream';

import {
  decodeFrontEvent,
  encodeFrontRequest,
  frame,
  PROTOCOL_VERSION,
  takeFrames,
  type DeathCause,
  type FrontEvent,
  type OpenMode,
} from './supervisor-protocol.js';

/** `ensure` 的結果。 */
export type EnsureOutcome =
  | { readonly type: 'up'; readonly socket: string }
  | { readonly type: 'down'; readonly cause: DeathCause }
  | { readonly type: 'capacity'; readonly current: number; readonly limit: number };

/** 監督行程最近一次送來的 `stats`。 */
export type SupervisorStats = Extract<FrontEvent, { type: 'stats' }>;

export interface SupervisorClientOptions {
  /** 監督行程 → 前台（前台的 stdin）。 */
  readonly input: Readable;
  /** 前台 → 監督行程（前台真正的 stdout）。 */
  readonly output: Writable;
  /** 一條 thread 的行程起來了（或前台重起之後監督行程補講一次）。同一條同一個 socket 會講很多次：每個成功的 `ensure` 都會再回一顆 `up`。 */
  readonly onUp?: (threadId: string, socket: string) => void;
  /** 一條 thread 的行程結束了；`socket` 是它原本聽的那個（表上沒有就是 `undefined`），前台用它收掉往那裡的連線。 */
  readonly onDown?: (threadId: string, cause: DeathCause, socket: string | undefined) => void;
  /** 監督行程要停機：停收新的請求。回來之後就回 `admission-stopped`；沒給就收到時直接回。 */
  readonly onStopAdmission?: () => void;
  readonly warn?: (message: string) => void;
}

interface Waiter {
  readonly resolve: (outcome: EnsureOutcome) => void;
  readonly reject: (error: Error) => void;
}

interface Pending {
  /** 已經送出的打開方式裡最強的一個：`run` 送過就不再送 `read-only`。 */
  sent: OpenMode;
  readonly waiters: Set<Waiter>;
}

/** 控制通道斷了之後，`ensure` 丟這個。 */
export class SupervisorGoneError extends Error {
  constructor() {
    super('監督行程的控制通道斷了');
    this.name = 'SupervisorGoneError';
  }
}

/**
 * 前台這一側的控制面。建構時就開始讀 `input`；控制通道斷了（EOF、錯誤、框壞了）之後整個實例作廢：在等的全部以
 * {@link SupervisorGoneError} 拒絕，行程表清空。
 */
export class SupervisorClient {
  readonly #output: Writable;
  readonly #onUp: SupervisorClientOptions['onUp'];
  readonly #onDown: SupervisorClientOptions['onDown'];
  readonly #onStopAdmission: SupervisorClientOptions['onStopAdmission'];
  readonly #warn: (message: string) => void;
  readonly #live = new Map<string, string>();
  readonly #pending = new Map<string, Pending>();
  #buffer: Buffer = Buffer.alloc(0);
  #gone = false;
  #stats: SupervisorStats | undefined;
  #hostToken: string | undefined;

  constructor(options: SupervisorClientOptions) {
    this.#output = options.output;
    this.#onUp = options.onUp;
    this.#onDown = options.onDown;
    this.#onStopAdmission = options.onStopAdmission;
    this.#warn = options.warn ?? (() => {});
    this.#send({ type: 'hello', version: PROTOCOL_VERSION });
    options.input.on('data', (chunk: Buffer) => this.#receive(chunk));
    options.input.once('end', () => this.#close());
    options.input.once('error', () => this.#close());
  }

  /** 這條 thread 的對話行程現在在哪個 socket 上；沒有就是 `undefined`。 */
  socketOf(threadId: string): string | undefined {
    return this.#live.get(threadId);
  }

  /** 活著的對話行程綁的 thread。 */
  liveThreads(): readonly string[] {
    return [...this.#live.keys()];
  }

  /** 監督行程的 `hello` 帶來的、連宿主用的 token；還沒收到是 `undefined`。 */
  get hostToken(): string | undefined {
    return this.#hostToken;
  }

  /** 監督行程最近一次送來的 `stats`；還沒收到過是 `undefined`（監督行程每 `--stats-ms` 送一次，前台（重）起時也送）。 */
  get stats(): SupervisorStats | undefined {
    return this.#stats;
  }

  /**
   * 要一條 thread 的對話行程。**每次都問**，即使表上已經有：監督行程算閒置看的是最後一次被 `ensure` 與對話行程回報 `idle` 兩者較晚的，
   * 只讀開啟的也靠 `ensure(run)` 轉成一般的。
   *
   * @param signal - 請求斷了就不等；送出去的 `ensure` 收不回，回答來了照樣更新行程表。
   * @throws {@link SupervisorGoneError} 控制通道已斷或在等的時候斷了；`signal` 中止時以 `signal.reason` 拒絕。
   */
  ensure(threadId: string, open: OpenMode, signal?: AbortSignal): Promise<EnsureOutcome> {
    if (this.#gone) return Promise.reject(new SupervisorGoneError());
    if (signal?.aborted) return Promise.reject(signal.reason as Error);
    return new Promise<EnsureOutcome>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: (outcome) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(outcome);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      };
      const onAbort = (): void => {
        this.#pending.get(threadId)?.waiters.delete(waiter);
        reject(signal?.reason as Error);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const pending = this.#pending.get(threadId);
      if (pending === undefined) {
        this.#pending.set(threadId, { sent: open, waiters: new Set([waiter]) });
        this.#send({ type: 'ensure', threadId, open });
        return;
      }
      pending.waiters.add(waiter);
      if (open === 'run' && pending.sent === 'read-only') {
        pending.sent = 'run';
        this.#send({ type: 'ensure', threadId, open });
      }
    });
  }

  /** 前台用完了這條 thread。監督行程只收只讀開啟的；轉成一般的不理，照 `--idle-ms` 收（`native/sandbox-spawner/README.md` 的逐出那一條）。 */
  release(threadId: string): void {
    if (!this.#gone) this.#send({ type: 'release', threadId });
  }

  #send(request: Parameters<typeof encodeFrontRequest>[0]): void {
    this.#output.write(frame(encodeFrontRequest(request)));
  }

  #receive(chunk: Buffer): void {
    let frames: Buffer[];
    try {
      const taken = takeFrames(Buffer.concat([this.#buffer, chunk]));
      frames = taken.frames;
      this.#buffer = Buffer.from(taken.rest);
    } catch (error) {
      this.#warn(`[supervisor] 控制通道的框壞了：${String(error)}`);
      this.#close();
      return;
    }
    for (const payload of frames) {
      if (this.#gone) return;
      let event: FrontEvent;
      try {
        event = decodeFrontEvent(payload);
      } catch (error) {
        if (this.#hostToken === undefined) {
          this.#warn(`[supervisor] 第一框解不開：${String(error)}`);
          this.#close();
          return;
        }
        this.#warn(`[supervisor] 解不開的事件，略過：${String(error)}`);
        continue;
      }
      if (this.#hostToken === undefined) {
        if (event.type !== 'hello' || event.version !== PROTOCOL_VERSION) {
          const got = event.type === 'hello' ? `版本 ${String(event.version)}` : event.type;
          this.#warn(`[supervisor] 第一框不是版本 ${String(PROTOCOL_VERSION)} 的 hello（${got}）`);
          this.#close();
          return;
        }
        this.#hostToken = event.token;
        continue;
      }
      this.#apply(event);
    }
  }

  #apply(event: FrontEvent): void {
    switch (event.type) {
      case 'up':
        this.#live.set(event.threadId, event.socket);
        this.#onUp?.(event.threadId, event.socket);
        this.#settle(event.threadId, { type: 'up', socket: event.socket });
        return;
      case 'down': {
        const socket = this.#live.get(event.threadId);
        this.#live.delete(event.threadId);
        this.#onDown?.(event.threadId, event.cause, socket);
        if (event.cause !== 'evicted') {
          this.#settle(event.threadId, { type: 'down', cause: event.cause });
        }
        return;
      }
      case 'capacity':
        this.#settle(event.threadId, {
          type: 'capacity',
          current: event.current,
          limit: event.limit,
        });
        return;
      case 'stats':
        this.#stats = event;
        return;
      case 'hello':
        this.#warn('[supervisor] 又收到一次 hello，略過');
        return;
      case 'stop-admission':
        this.#onStopAdmission?.();
        this.#send({ type: 'admission-stopped' });
        return;
    }
  }

  #settle(threadId: string, outcome: EnsureOutcome): void {
    const pending = this.#pending.get(threadId);
    if (pending === undefined) return;
    this.#pending.delete(threadId);
    for (const waiter of pending.waiters) waiter.resolve(outcome);
  }

  #close(): void {
    if (this.#gone) return;
    this.#gone = true;
    const error = new SupervisorGoneError();
    for (const pending of this.#pending.values()) {
      for (const waiter of pending.waiters) waiter.reject(error);
    }
    this.#pending.clear();
    this.#live.clear();
  }
}
