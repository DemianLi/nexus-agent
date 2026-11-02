/**
 * 一條 WebSocket 上跑多條下行（[#2262](https://github.com/DemianLi/nexus-agent/issues/2262)）：server 這一半。協定與它為什麼存在見
 * `@nexus/wire` 的 `mux.ts`。
 *
 * **閘門只有一份。** 升級前的 403、401 由 `admit` 判，每開一條再由 `handle` 判一次，都是 `wire-handler.ts` 的 `admit`；
 * cookie 到期之後新開的就是 401。升級比 HTTP 多要一條：**一定要帶 `Origin`**。WebSocket 沒有同源政策與 preflight，
 * 跨站只能看請求標頭，`Origin` 是其中瀏覽器一定會帶的。
 *
 * `handle` 繞過了 `wire-server.ts` 的 listener，那一層的事這裡要自己做：
 *
 * - **Request 活到這條結束**（#983）：`request.signal` 對來源 signal 是弱參照，Request 被回收之後中止就到不了 handler。
 *   所以 {@link MuxStreamState} 抓著它。
 * - **最後一道防線**（#424）：一個請求的失敗只收在那一條，一條 socket 的失敗只收在那一條 socket。
 * - **計數**（#1535）：每條邏輯串流各算一次，升級本身也算。
 * - **背壓與死線**（#1504）：送出等 `ws` 的回呼，所以一條 socket 卡住時每條都停在 `await`；額度讓慢的讀者只卡自己。
 *   停著不讀本體，壓力就回到 `bounded-event-queue.ts`，超限只斷線。心跳用 ping／pong，漏兩拍斷線。
 *
 * @module
 */

import { STATUS_CODES } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WIRE_MUX_PATH, isMuxRoute, parseMuxClientMessage } from '@nexus/wire';
import type { MuxClientMessage, MuxServerMessage } from '@nexus/wire';
import type { RawData } from 'ws';
import WebSocket, { WebSocketServer } from 'ws';

import type { WireHandler } from './wire-handler.js';

/** 連續漏幾拍算死，SSE 與 WebSocket 共用。協定常數，不開成設定。 */
export const MAX_MISSED_HEARTBEATS = 2;

/** 上行只有開線、取消與額度，開線的本文是頻道清單。 */
const MAX_CLIENT_MESSAGE_BYTES = 64 * 1024;

/** 整台 serve 的 socket 上限，主機是多人共用的。一頁一條，超過的頁面退回 SSE。 */
export const DEFAULT_MUX_MAX_SOCKETS = 1024;

/** 每條 socket 的邏輯串流上限。一頁平常是 `feed` 加一條 `stream`；重連時舊的還沒收完會短暫多一條。 */
export const DEFAULT_MUX_MAX_STREAMS = 16;

/** 每條邏輯串流的額度（字元）：用完就停止讀本體，手上已讀到的那一段照送，所以實際可多出一段。 */
export const DEFAULT_MUX_WINDOW_CHARS = 1024 * 1024;

const PROTOCOL_ERROR_CLOSE = 1008;

const ROUTE_NOT_ALLOWED = 'route not allowed';

/** 上層要給的 handler：`wire-handler.ts` 的實作。 */
export type WireMuxHandler = Pick<WireHandler, 'handle'> & {
  /** 升級前的圍欄與身分：過了回 `undefined`，沒過回要回的 `Response`。 */
  admit(headers: Headers): Response | undefined;
};

export interface WireMuxOptions {
  readonly handler: WireMuxHandler;
  /** `new Request` 要的絕對網址的來源，信任不看它（`request-trust.ts`）。 */
  readonly origin: () => string;
  readonly heartbeatIntervalMs: number;
  readonly warn: (error: Error, request: { method: string; path: string }) => void;
  readonly warnDisconnect: (message: string) => void;
  readonly count: (path: string, status: number) => void;
  /** 預設 {@link DEFAULT_MUX_MAX_SOCKETS}。 */
  readonly maxSockets?: number;
  /** 預設 {@link DEFAULT_MUX_MAX_STREAMS}。 */
  readonly maxStreams?: number;
  /** 預設 {@link DEFAULT_MUX_WINDOW_CHARS}。 */
  readonly windowChars?: number;
}

/** 計數要的 pathname：開線的路徑是對方送的原文，可能帶 query。 */
function pathOf(target: string): string {
  return target.split(/[?#]/u, 1)[0] ?? '';
}

function requestHeaders(incoming: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (typeof value === 'string') headers.set(name, value);
  }
  return headers;
}

/** 開線時交給 `handle` 的標頭：閘門要看的那幾個定在升級當下；`content-type` 固定是 JSON，兩條路由的閘門都要它。 */
function logicalHeaders(upgrade: Headers): Headers {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const name of ['host', 'cookie', 'origin', 'sec-fetch-site']) {
    const value = upgrade.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

/**
 * 升級前拒絕：socket 還不歸 `ws`，回一個 HTTP 回應就關。`end` 只關寫的那一半，對方不關就一直開著，`closeAllConnections` 也管不到
 * 進了 `upgrade` 的 socket，不用 cookie 就能把 `server.close` 卡住，所以送完要 `destroy`。
 */
function refuse(socket: Duplex, status: number): void {
  socket.once('finish', () => {
    socket.destroy();
  });
  socket.end(
    `HTTP/1.1 ${String(status)} ${STATUS_CODES[status] ?? ''}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

interface MuxStreamState {
  readonly abort: AbortController;
  /** 抓著它，見檔頭。 */
  request: Request | undefined;
  credit: number;
  /** 額度用完時等在這裡；還額度與中止都叫它。 */
  wake: (() => void) | undefined;
  done: Promise<void>;
}

class MuxConnection {
  readonly #streams = new Map<string, MuxStreamState>();
  readonly #headers: Headers;
  #missed = 0;

  constructor(
    readonly socket: WebSocket,
    upgrade: Headers,
    private readonly options: WireMuxOptions,
    private readonly onClosed: () => void,
  ) {
    this.#headers = logicalHeaders(upgrade);
    socket.on('pong', this.#alive);
    socket.on('message', (raw: RawData, binary: boolean) => {
      this.#alive();
      try {
        this.#receive(binary ? undefined : parseMuxClientMessage(String(raw)));
      } catch (error: unknown) {
        this.#fail(error);
      }
    });
    // 沒接的話 `ws` 的 error 會變成沒人處理的事件，整個行程退出。超過 `maxPayload` 也走這裡。
    socket.on('error', (error) => {
      this.#fail(error);
    });
    socket.on('close', () => {
      this.#abortAll();
      this.onClosed();
    });
  }

  /** 心跳的一拍。 */
  beat(): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    if (this.#missed >= MAX_MISSED_HEARTBEATS) {
      this.options.warnDisconnect('[下行] 一條 WebSocket 連兩拍沒有回應，已斷開');
      this.socket.terminate();
      return;
    }
    this.#missed += 1;
    this.socket.ping();
  }

  /** 收掉，等每條的本體都放掉。 */
  async close(): Promise<void> {
    this.socket.terminate();
    this.#abortAll();
    await Promise.all([...this.#streams.values()].map((stream) => stream.done));
  }

  readonly #alive = (): void => {
    this.#missed = 0;
  };

  #fail(error: unknown): void {
    this.options.warn(error instanceof Error ? error : new Error(String(error)), {
      method: 'GET',
      path: WIRE_MUX_PATH,
    });
    this.socket.terminate();
  }

  #abortAll(): void {
    for (const stream of this.#streams.values()) this.#stop(stream);
  }

  #stop(stream: MuxStreamState): void {
    stream.abort.abort();
    stream.wake?.();
  }

  #receive(message: MuxClientMessage | undefined): void {
    if (message === undefined) {
      this.socket.close(PROTOCOL_ERROR_CLOSE, 'bad message');
      return;
    }
    if (message.t === 'open') {
      this.#open(message);
      return;
    }
    // 已經結束的那一條：cancel、credit 跟結束交錯很正常。
    const stream = this.#streams.get(message.id);
    if (stream === undefined) return;
    if (message.t === 'cancel') {
      this.#stop(stream);
      return;
    }
    stream.credit += message.chars;
    stream.wake?.();
  }

  #open(message: Extract<MuxClientMessage, { t: 'open' }>): void {
    const { id, method, path } = message;
    if (this.#streams.has(id)) {
      this.socket.close(PROTOCOL_ERROR_CLOSE, 'duplicate stream id');
      return;
    }
    const refused = !isMuxRoute(method, path)
      ? ROUTE_NOT_ALLOWED
      : this.#streams.size >= (this.options.maxStreams ?? DEFAULT_MUX_MAX_STREAMS)
        ? 'too many streams'
        : undefined;
    if (refused !== undefined) {
      this.options.count(pathOf(path), refused === ROUTE_NOT_ALLOWED ? 404 : 429);
      // socket 已關：'close' 會收掉每一條。
      void this.#send({ t: 'error', id, message: refused }).catch(() => undefined);
      return;
    }
    const stream: MuxStreamState = {
      abort: new AbortController(),
      request: undefined,
      credit: this.options.windowChars ?? DEFAULT_MUX_WINDOW_CHARS,
      wake: undefined,
      done: Promise.resolve(),
    };
    this.#streams.set(id, stream);
    stream.done = this.#serve(id, stream, message)
      .catch((error: unknown) => {
        if (stream.abort.signal.aborted) return;
        this.options.warn(error instanceof Error ? error : new Error(String(error)), {
          method,
          path,
        });
        // socket 已關：'close' 會收掉每一條。
        void this.#send({ t: 'error', id, message: 'stream failed' }).catch(() => undefined);
      })
      .finally(() => {
        stream.request = undefined;
        this.#streams.delete(id);
      });
  }

  async #serve(
    id: string,
    stream: MuxStreamState,
    message: Extract<MuxClientMessage, { t: 'open' }>,
  ): Promise<void> {
    const { signal } = stream.abort;
    stream.request = new Request(`${this.options.origin()}${message.path}`, {
      method: message.method,
      headers: this.#headers,
      signal,
      ...(message.body === undefined ? {} : { body: message.body }),
    });
    const response = await this.options.handler.handle(stream.request).catch((error: unknown) => {
      // 同 HTTP 的最後一道防線：失敗的也算。
      this.options.count(message.path, 400);
      throw error;
    });
    this.options.count(message.path, response.status);
    const reader = response.body?.getReader();
    const release = (): void => {
      // 已經結束或出錯的本體，cancel 拒絕沒有事要做。
      void reader?.cancel().catch(() => undefined);
    };
    if (signal.aborted) {
      release();
      return;
    }
    signal.addEventListener('abort', release, { once: true });
    try {
      // `handle` 回來了才送：`await openEvents` 之後才 `runStart` 是呼叫端的契約。
      await this.#send({
        t: 'head',
        id,
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
      });
      const decoder = new TextDecoder();
      while (reader !== undefined) {
        if (signal.aborted) return;
        if (stream.credit <= 0) {
          await new Promise<void>((resolve) => {
            stream.wake = resolve;
          });
          stream.wake = undefined;
          continue;
        }
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text === '') continue;
        stream.credit -= text.length;
        await this.#send({ t: 'data', id, text });
      }
      if (!signal.aborted) await this.#send({ t: 'end', id });
    } finally {
      signal.removeEventListener('abort', release);
      release();
    }
  }

  #send(message: MuxServerMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket.readyState !== WebSocket.OPEN) {
        reject(new Error('socket is closed'));
        return;
      }
      let queued = false;
      this.socket.send(JSON.stringify(message), (error) => {
        if (error !== undefined && error !== null) {
          reject(error);
          return;
        }
        // 排過隊才完成的寫入也算對方活著。
        if (queued) this.#alive();
        resolve();
      });
      queued = this.socket.bufferedAmount > 0;
    });
  }
}

/** 一台 serve 一個。 */
export class WireMux {
  readonly #server = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: MAX_CLIENT_MESSAGE_BYTES,
  });
  readonly #connections = new Set<MuxConnection>();
  #timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: WireMuxOptions) {}

  /** 接一個升級請求。沒過閘門的不交給 `ws`。 */
  handleUpgrade(incoming: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = pathOf(incoming.url ?? '');
    const reject = (status: number): void => {
      this.options.count(path, status);
      refuse(socket, status);
    };
    const headers = requestHeaders(incoming);
    if (!headers.has('origin')) {
      reject(403);
      return;
    }
    const rejection = this.options.handler.admit(headers);
    if (rejection !== undefined) {
      reject(rejection.status);
      return;
    }
    if (path !== WIRE_MUX_PATH) {
      reject(404);
      return;
    }
    if (this.#connections.size >= (this.options.maxSockets ?? DEFAULT_MUX_MAX_SOCKETS)) {
      reject(503);
      return;
    }
    this.#server.handleUpgrade(incoming, socket, head, (websocket) => {
      this.options.count(path, 101);
      const connection: MuxConnection = new MuxConnection(websocket, headers, this.options, () => {
        this.#connections.delete(connection);
      });
      this.#connections.add(connection);
      this.#startHeartbeat();
    });
  }

  /** 收掉所有 socket，等每條串流放掉本體。 */
  async close(): Promise<void> {
    clearInterval(this.#timer);
    this.#timer = undefined;
    await Promise.all([...this.#connections].map((connection) => connection.close()));
    await new Promise<void>((resolve) => {
      this.#server.close(() => {
        resolve();
      });
    });
  }

  #startHeartbeat(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => {
      for (const connection of this.#connections) connection.beat();
    }, this.options.heartbeatIntervalMs);
    this.#timer.unref();
  }
}
