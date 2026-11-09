/**
 * 對話行程到宿主的一條連線（[#2569](https://github.com/DemianLi/nexus-agent/issues/2569)）：連上 socket 先送 `hello`（帶監督行程給的 token），
 * 宿主回版本相同的 `hello` 就算 ready。
 *
 * - 宿主不在、拒絕（例如監督行程那一筆身分還沒寫到宿主）、回的版本不同、斷線、送來解不開的框、`hello` 之前送來別種框，或 ready 之後又送來 `hello`／`rejected`，都關掉這條、隔一段時間重連：第一次等 `backoffMs`，
 *   之後每次加倍到 `backoffMaxMs`；ready 過一次就回到 `backoffMs`。宿主重起之後，監督行程把身分表整張重送，同一個 token 照樣有效。
 * - 一段連不上的期間只記第一次失敗與重新連上，不每次重試都記。
 * - socket 與計時器都 `unref`：這條連線不撐住行程，serve 收尾時不用等它。
 * - {@link HostClient.waitReady} 是有上限的等待：ready 了回 `true`，到時限或 `close` 了回 `false`。
 * - ready 之後可以 {@link HostClient.call}。每個呼叫剛好結算一次：宿主回的 `result`、呼叫端取消（`cancelled`，同時送 `cancel`），
 *   或連線斷了（`host_lost`）。綁定跟著連線走：斷線之後宿主那邊已經放掉這條連線的一切，重連後要再登記的，掛 {@link HostClient.onReady}。
 * - 宿主送來不認得的 `id`、`seq` 跳號、`side` 是 `'h'` 的 `chunk`／`result`，都當成這條連線壞了：關掉重連。
 * - 閒著（ready、沒有呼叫在跑）時沒有任何計時器。
 *
 * @module
 */

import { createConnection, type Socket } from 'node:net';

import { HostCallError } from './errors.js';
import {
  FrameReader,
  MAX_ID,
  PROTOCOL_VERSION,
  decodeHostMessage,
  encodeClientMessage,
  frame,
  type HostMessage,
  type Json,
} from './protocol.js';

/** `connecting` 包括正在連與等下一次重連（斷線之後也回到這裡）；`closed` 只由 {@link HostClient.close} 進入。 */
export type HostConnectionState = 'connecting' | 'ready' | 'closed';

export interface HostClientOptions {
  readonly socketPath: string;
  readonly token: string;
  readonly log: (line: string) => void;
  /** 第一次重連前等多久（毫秒），預設 {@link DEFAULT_BACKOFF_MS}。 */
  readonly backoffMs?: number;
  /** 重連等待的上限（毫秒），預設 {@link DEFAULT_BACKOFF_MAX_MS}。 */
  readonly backoffMaxMs?: number;
}

export interface HostCallOptions {
  /** 中止就以 `cancelled` 結算，並送 `cancel` 叫宿主那邊停下。 */
  readonly signal?: AbortSignal;
  /**
   * 串流的方法每推一塊叫一次，照 `seq` 的順序，都在結果之前。丟出的錯會取消這個呼叫，呼叫以那個錯結算。
   * 單次的方法不推塊。
   */
  readonly onChunk?: (payload: Json) => void;
}

/** 宿主主動推的事件。 */
export interface HostEvent {
  readonly service: string;
  readonly topic: string;
  readonly payload: Json;
}

interface InFlight {
  readonly socket: Socket;
  readonly onChunk: ((payload: Json) => void) | undefined;
  seq: number;
  /** 已經結算給呼叫端了（取消或 onChunk 丟錯）：還在等宿主回的 `result`，收到就丟掉。 */
  settled: boolean;
  settle(outcome: { readonly ok: Json } | { readonly error: Error }): void;
  /** 以 `error` 結算，還在宿主那邊跑的話送 `cancel`。 */
  cancel(error: Error): void;
}

export const DEFAULT_BACKOFF_MS = 200;
export const DEFAULT_BACKOFF_MAX_MS = 5_000;

/** 對話行程到宿主的一條連線。建構當下就開始連；斷了自己重連，直到 {@link HostClient.close}。 */
export class HostClient {
  readonly #options: HostClientOptions;
  readonly #backoffMs: number;
  readonly #backoffMaxMs: number;
  #state: HostConnectionState = 'connecting';
  #socket: Socket | undefined;
  #retry: NodeJS.Timeout | undefined;
  #delay: number;
  #failing = false;
  readonly #waiters = new Set<(ready: boolean) => void>();
  readonly #calls = new Map<number, InFlight>();
  readonly #readyListeners = new Set<() => void>();
  readonly #eventListeners = new Set<(event: HostEvent) => void>();
  #nextId = 0;

  constructor(options: HostClientOptions) {
    this.#options = options;
    this.#backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.#backoffMaxMs = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
    this.#delay = this.#backoffMs;
    this.#connect();
  }

  get state(): HostConnectionState {
    return this.#state;
  }

  waitReady(timeoutMs: number): Promise<boolean> {
    if (this.#state !== 'connecting') return Promise.resolve(this.#state === 'ready');
    return new Promise((resolve) => {
      const done = (ready: boolean) => {
        clearTimeout(timer);
        this.#waiters.delete(done);
        resolve(ready);
      };
      const timer = setTimeout(() => {
        done(false);
      }, timeoutMs);
      timer.unref();
      this.#waiters.add(done);
    });
  }

  /**
   * 呼叫宿主上的服務。
   *
   * @returns 宿主回的 `ok`。
   * @throws {@link HostCallError}：宿主回的錯誤碼；還沒 ready 是 `host_unavailable`、已經 `close` 是 `host_absent`（都沒送出去）；
   *   送出去之後斷線是 `host_lost`；取消是 `cancelled`。`payload` 宿主收不下時丟 `HostProtocolError`，沒送出去。
   */
  call(
    service: string,
    method: string,
    payload: Json,
    options: HostCallOptions = {},
  ): Promise<Json> {
    const socket = this.#socket;
    if (this.#state !== 'ready' || socket === undefined) {
      return Promise.reject(
        this.#state === 'closed'
          ? new HostCallError('host_absent', '宿主連線已經關了')
          : new HostCallError('host_unavailable', '宿主還沒連上'),
      );
    }
    if (options.signal?.aborted === true) {
      return Promise.reject(new HostCallError('cancelled', '送出之前就取消了'));
    }
    const id = this.#takeId();
    let bytes: Buffer;
    try {
      bytes = frame(encodeClientMessage({ type: 'call', side: 'c', id, service, method, payload }));
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return new Promise<Json>((resolve, reject) => {
      const { signal } = options;
      const onAbort = () => {
        call.cancel(new HostCallError('cancelled', '呼叫端取消了'));
      };
      const call: InFlight = {
        socket,
        onChunk: options.onChunk,
        seq: 0,
        settled: false,
        settle: (outcome) => {
          if (call.settled) return;
          call.settled = true;
          signal?.removeEventListener('abort', onAbort);
          if ('ok' in outcome) resolve(outcome.ok);
          else reject(outcome.error);
        },
        cancel: (error) => {
          if (call.settled) return;
          call.settle({ error });
          if (this.#calls.get(id) === call && !socket.destroyed) {
            socket.write(frame(encodeClientMessage({ type: 'cancel', side: 'c', id })));
          }
        },
      };
      this.#calls.set(id, call);
      signal?.addEventListener('abort', onAbort, { once: true });
      socket.write(bytes);
    });
  }

  /** 每次 ready（包括重連之後）叫一次；回傳的函式取消登記。丟出的錯記一行 log，不影響連線。 */
  onReady(listener: () => void): () => void {
    this.#readyListeners.add(listener);
    return () => this.#readyListeners.delete(listener);
  }

  /** 宿主每推一個事件叫一次；回傳的函式取消登記。丟出的錯記一行 log，不影響連線。 */
  onEvent(listener: (event: HostEvent) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  /** 停掉重連、關掉 socket，在等的 {@link HostClient.waitReady} 回 `false`、在跑的呼叫以 `host_lost` 結算；叫幾次都一樣，不記 log，之後不再連。 */
  close(): void {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    clearTimeout(this.#retry);
    this.#socket?.destroy();
    this.#settle(false);
  }

  #takeId(): number {
    while (this.#calls.has(this.#nextId))
      this.#nextId = this.#nextId === MAX_ID ? 0 : this.#nextId + 1;
    const id = this.#nextId;
    this.#nextId = id === MAX_ID ? 0 : id + 1;
    return id;
  }

  /** 一框 `chunk`／`result`：對不上在跑的呼叫就回錯的原因，由呼叫端當成這條連線壞了。 */
  #onCallFrame(
    socket: Socket,
    message: Extract<HostMessage, { type: 'chunk' | 'result' }>,
  ): string | undefined {
    const call = this.#calls.get(message.id);
    if (message.side !== 'c' || call === undefined || call.socket !== socket) {
      return `收到不認得的呼叫 ${message.side}:${String(message.id)} 的 ${message.type}`;
    }
    if (message.type === 'chunk') {
      if (message.seq !== call.seq) {
        return `呼叫 ${String(message.id)} 的塊應該是第 ${String(call.seq)} 塊，收到第 ${String(message.seq)} 塊`;
      }
      call.seq += 1;
      if (!call.settled && call.onChunk !== undefined) {
        try {
          call.onChunk(message.payload);
        } catch (error: unknown) {
          call.cancel(error instanceof Error ? error : new Error(String(error)));
        }
      }
      return undefined;
    }
    this.#calls.delete(message.id);
    call.settle(
      'ok' in message
        ? { ok: message.ok }
        : { error: new HostCallError(message.error.code, message.error.message) },
    );
    return undefined;
  }

  #dropCalls(socket: Socket): void {
    for (const [id, call] of this.#calls) {
      if (call.socket !== socket) continue;
      this.#calls.delete(id);
      call.settle({ error: new HostCallError('host_lost', '呼叫送出之後宿主連線斷了，結果不明') });
    }
  }

  #notify<T>(listeners: ReadonlySet<(value: T) => void>, value: T, what: string): void {
    for (const listener of [...listeners]) {
      try {
        listener(value);
      } catch (error: unknown) {
        this.#options.log(
          `[宿主] ${what}的處理丟了錯：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  #settle(ready: boolean): void {
    for (const waiter of [...this.#waiters]) waiter(ready);
  }

  #connect(): void {
    const reader = new FrameReader();
    const socket = createConnection(this.#options.socketPath);
    this.#socket = socket;
    socket.unref();
    let reason = '連線關了';
    const fail = (why: string) => {
      reason = why;
      socket.destroy();
    };
    socket.on('connect', () => {
      socket.write(
        frame(
          encodeClientMessage({
            type: 'hello',
            version: PROTOCOL_VERSION,
            token: this.#options.token,
          }),
        ),
      );
    });
    socket.on('data', (chunk: Buffer) => {
      try {
        for (const payload of reader.push(chunk)) {
          const message = decodeHostMessage(payload);
          if (this.#state === 'ready') {
            if (message.type === 'hello' || message.type === 'rejected') {
              fail(`ready 之後收到 ${message.type}`);
            } else if (message.type === 'event') {
              this.#notify(this.#eventListeners, message, '事件');
            } else {
              const wrong = this.#onCallFrame(socket, message);
              if (wrong !== undefined) fail(wrong);
            }
            if (socket.destroyed) return;
          } else if (message.type !== 'hello' && message.type !== 'rejected') {
            fail(`hello 之前收到 ${message.type}`);
          } else if (message.type === 'rejected') {
            fail(`宿主拒絕：${message.reason}`);
          } else if (message.version !== PROTOCOL_VERSION) {
            fail(`宿主的版本是 ${String(message.version)}，這邊是 ${String(PROTOCOL_VERSION)}`);
          } else {
            this.#ready();
          }
        }
      } catch (error: unknown) {
        fail(error instanceof Error ? error.message : String(error));
      }
    });
    socket.on('error', (error) => {
      reason = error.message;
    });
    socket.on('close', () => {
      this.#closed(socket, reason);
    });
  }

  #ready(): void {
    this.#state = 'ready';
    this.#delay = this.#backoffMs;
    this.#failing = false;
    this.#options.log('[宿主] 連上了');
    this.#settle(true);
    this.#notify(this.#readyListeners, undefined, 'ready ');
  }

  #closed(socket: Socket, reason: string): void {
    this.#dropCalls(socket);
    if (this.#state === 'closed' || socket !== this.#socket) return;
    if (this.#state === 'ready') {
      this.#options.log(`[宿主] 斷線（${reason}），重連中`);
      this.#failing = true;
    } else if (!this.#failing) {
      this.#options.log(`[宿主] 連不上（${reason}），重連中`);
      this.#failing = true;
    }
    this.#state = 'connecting';
    const delay = this.#delay;
    this.#delay = Math.min(this.#delay * 2, this.#backoffMaxMs);
    this.#retry = setTimeout(() => {
      this.#connect();
    }, delay);
    this.#retry.unref();
  }
}
