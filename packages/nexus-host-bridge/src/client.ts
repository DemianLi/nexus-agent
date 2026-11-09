/**
 * 對話行程到宿主的一條連線（[#2569](https://github.com/DemianLi/nexus-agent/issues/2569)）：連上 socket 先送 `hello`（帶監督行程給的 token），
 * 宿主回版本相同的 `hello` 就算 ready。
 *
 * - 宿主不在、拒絕（例如監督行程那一筆身分還沒寫到宿主）、回的版本不同、斷線、送來解不開的框，或 ready 之後又送來任何一框，都關掉這條、隔一段時間重連：第一次等 `backoffMs`，
 *   之後每次加倍到 `backoffMaxMs`；ready 過一次就回到 `backoffMs`。宿主重起之後，監督行程把身分表整張重送，同一個 token 照樣有效。
 * - 一段連不上的期間只記第一次失敗與重新連上，不每次重試都記。
 * - socket 與計時器都 `unref`：這條連線不撐住行程，serve 收尾時不用等它。
 * - {@link HostClient.waitReady} 是有上限的等待：ready 了回 `true`，到時限或 `close` 了回 `false`。
 *
 * @module
 */

import { createConnection, type Socket } from 'node:net';

import { FrameReader, PROTOCOL_VERSION, decodeHostMessage, encodeClientMessage, frame } from './protocol.js';

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

  /** 停掉重連、關掉 socket，在等的 {@link HostClient.waitReady} 回 `false`；叫幾次都一樣，不記 log，之後不再連。 */
  close(): void {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    clearTimeout(this.#retry);
    this.#socket?.destroy();
    this.#settle(false);
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
      socket.write(frame(encodeClientMessage({ type: 'hello', version: PROTOCOL_VERSION, token: this.#options.token })));
    });
    socket.on('data', (chunk: Buffer) => {
      try {
        for (const payload of reader.push(chunk)) {
          const message = decodeHostMessage(payload);
          if (this.#state === 'ready') {
            fail(`ready 之後收到 ${message.type}`);
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
  }

  #closed(socket: Socket, reason: string): void {
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
