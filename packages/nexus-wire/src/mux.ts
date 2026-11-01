/**
 * 同一分頁的下行共用一條 WebSocket（[#2262](https://github.com/DemianLi/nexus-agent/issues/2262)）：HTTP/1.1 每個來源只有 6 條連線，
 * 一頁佔 2 條長連線，開到第三分頁就用滿，之後的請求都排不到（#2250）。
 *
 * **這條線只是載體。** 這條線上跑的是「一個 HTTP 請求與它的回應」：`open` 帶方法、路徑與本文，server 交給同一支 `handle`，回應的狀態、
 * content type 與本文原樣送回來，SSE 的文字一個字不動。解碼、拒絕封包、重連都留在 `client.ts` 與呼叫端，所以 {@link createMuxFetch}
 * 的形狀就是 `fetch`。只有網頁接它；Node 的客戶端（smoke、eval）走 SSE。
 *
 * 額度以字元算：server 每送一段就扣，讀者讀走那一段才還。慢的讀者只卡住自己那一條。
 *
 * @module
 */

import { THREAD_FEED_PATH } from './protocol.js';

/** 升級請求的路徑。 */
export const WIRE_MUX_PATH = '/threads/mux';

/** 上行的訊息。 */
export type MuxClientMessage =
  | {
      readonly t: 'open';
      readonly id: string;
      readonly method: string;
      readonly path: string;
      readonly body?: string;
    }
  | { readonly t: 'cancel'; readonly id: string }
  | { readonly t: 'credit'; readonly id: string; readonly chars: number };

/** 下行的訊息。`head` 對應 `fetch` 兌現的那一刻；`error` 是這一條斷了或 server 拒開（開線前後都可能），不是協定的拒絕封包。 */
export type MuxServerMessage =
  | {
      readonly t: 'head';
      readonly id: string;
      readonly status: number;
      readonly contentType: string;
    }
  | { readonly t: 'data'; readonly id: string; readonly text: string }
  | { readonly t: 'end'; readonly id: string }
  | { readonly t: 'error'; readonly id: string; readonly message: string };

/** 這條線只開下行的兩條路由，不是通用隧道：命令走 HTTP。 */
export function isMuxRoute(method: string, path: string): boolean {
  if (method === 'GET') return path === THREAD_FEED_PATH;
  return method === 'POST' && /^\/threads\/[^/?#]+\/stream$/u.test(path);
}

function parseObject(raw: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // 不是 JSON，跟形狀不對同一種結果。
  }
  return undefined;
}

/** 看不懂回 `undefined`，呼叫端決定收掉什麼。 */
export function parseMuxClientMessage(raw: string): MuxClientMessage | undefined {
  const message = parseObject(raw);
  if (typeof message?.['id'] !== 'string') return undefined;
  const { t, id, method, path, body, chars } = message as Record<string, unknown> & { id: string };
  if (t === 'cancel') return { t, id };
  if (t === 'credit') {
    return typeof chars === 'number' && Number.isSafeInteger(chars) && chars > 0
      ? { t, id, chars }
      : undefined;
  }
  if (t !== 'open' || typeof method !== 'string' || typeof path !== 'string') return undefined;
  if (body === undefined) return { t, id, method, path };
  return typeof body === 'string' ? { t, id, method, path, body } : undefined;
}

/** 看不懂回 `undefined`。 */
export function parseMuxServerMessage(raw: string): MuxServerMessage | undefined {
  const message = parseObject(raw);
  if (typeof message?.['id'] !== 'string') return undefined;
  const { t, id, status, contentType, text } = message as Record<string, unknown> & { id: string };
  if (t === 'end') return { t, id };
  if (t === 'data') return typeof text === 'string' ? { t, id, text } : undefined;
  if (t === 'error') {
    const reason = message['message'];
    return typeof reason === 'string' ? { t, id, message: reason } : undefined;
  }
  if (t !== 'head' || typeof status !== 'number' || typeof contentType !== 'string') {
    return undefined;
  }
  return { t, id, status, contentType };
}

/** 事件處理函式用方法簽名取出來，同 `client.ts` 的 `UploadHandler`：真的 `WebSocket` 的處理函式收的是完整事件。 */
type SocketHandler<E> = { handler(event: E): void }['handler'];

/** 用到的那一小塊 `WebSocket`；wire 套件沒有 DOM 型別庫，真的 `WebSocket` 滿足它。 */
export interface MuxSocket {
  onopen: SocketHandler<unknown> | null;
  onclose: SocketHandler<unknown> | null;
  onerror: SocketHandler<unknown> | null;
  onmessage: SocketHandler<{ readonly data: unknown }> | null;
  send(text: string): void;
  close(): void;
}

export interface MuxFetchOptions {
  /** 升級請求的網址（`ws:`／`wss:`）。 */
  readonly url: string;
  readonly createSocket: (url: string) => MuxSocket;
  /** 走不了這條線時改走的 `fetch`。 */
  readonly fallback: typeof globalThis.fetch;
  /** 握手失敗之後，這一頁改走 {@link fallback} 多久才再試（毫秒）。預設 {@link MUX_FALLBACK_MS}。 */
  readonly fallbackMs?: number;
  /** 注入用。 */
  readonly now?: () => number;
}

/** 代理擋升級請求時不用每次重開都先失敗一次；serve 重開這種短暫的失敗，過一陣子又回到這條線。 */
export const MUX_FALLBACK_MS = 30_000;

function streamClosed(): TypeError {
  return new TypeError('下行的 WebSocket 斷了');
}

/** 一條邏輯串流在 client 這一側的狀態。開線之前只有 {@link settle}，`head` 來了才有回應本體。 */
class MuxStream {
  readonly #encoder = new TextEncoder();
  /** 讀者還沒讀走的段落；留著字數，讀走時才還額度。 */
  readonly #queue: { readonly bytes: Uint8Array; readonly chars: number }[] = [];
  #controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  #waiting = false;
  #terminal: { readonly error?: Error } | undefined;

  constructor(
    readonly settle: {
      readonly resolve: (response: Response) => void;
      readonly reject: (error: unknown) => void;
    },
    readonly stopAbortWatch: () => void,
    private readonly credit: (chars: number) => void,
    private readonly cancel: () => void,
  ) {}

  /** 這一刻才兌現 `fetch`：server 的 `handle` 已經回來了，`openEvents` 的契約靠這個。 */
  head(status: number, contentType: string): void {
    const body = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.#controller = controller;
        },
        pull: () => {
          this.#deliver();
        },
        cancel: () => {
          this.cancel();
        },
      },
      // 0：讀者真的在等才 pull，額度才反映「讀走了」。
      { highWaterMark: 0 },
    );
    this.settle.resolve(new Response(body, { status, headers: { 'content-type': contentType } }));
  }

  data(text: string): void {
    this.#queue.push({ bytes: this.#encoder.encode(text), chars: text.length });
    if (this.#waiting) this.#deliver();
  }

  /** 正常結束或斷線。已經收到的段落先讓讀者讀完。 */
  finish(error?: Error): void {
    if (this.#controller === undefined) {
      this.settle.reject(error ?? streamClosed());
      return;
    }
    this.#terminal = error === undefined ? {} : { error };
    if (this.#waiting || this.#queue.length === 0) this.#deliver();
  }

  /** 讀者中止：不等佇列，當場結束。 */
  abort(reason: unknown): void {
    if (this.#controller === undefined) this.settle.reject(reason);
    else this.#controller.error(reason);
    this.#terminal = {};
    this.#queue.length = 0;
  }

  #deliver(): void {
    const next = this.#queue.shift();
    if (next !== undefined) {
      this.#waiting = false;
      this.#controller?.enqueue(next.bytes);
      this.credit(next.chars);
      if (this.#queue.length > 0 || this.#terminal === undefined) return;
    }
    if (this.#terminal === undefined) {
      this.#waiting = true;
      return;
    }
    if (next !== undefined) return;
    if (this.#terminal.error === undefined) this.#controller?.close();
    else this.#controller?.error(this.#terminal.error);
  }
}

/** 一條 socket。cookie 定在升級當下，所以換 cookie 要換這一條，見 {@link createMuxFetch}。 */
class MuxCarrier {
  readonly opened: Promise<void>;
  readonly #socket: MuxSocket;
  readonly #streams = new Map<string, MuxStream>();
  #nextId = 1;
  #retired = false;
  #closed = false;

  constructor(url: string, createSocket: (url: string) => MuxSocket, onClosed: () => void) {
    this.#socket = createSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.#socket.onopen = () => {
        resolve();
      };
      this.#socket.onerror = () => {
        reject(streamClosed());
      };
      this.#socket.onclose = () => {
        reject(streamClosed());
        this.#closed = true;
        onClosed();
        for (const stream of this.#streams.values()) {
          stream.stopAbortWatch();
          stream.finish(streamClosed());
        }
        this.#streams.clear();
      };
    });
    this.#socket.onmessage = (event) => {
      this.#receive(event.data);
    };
  }

  /** 手上的串流跑完才關；呼叫端先把它摘下，新的不再進來。 */
  retire(): void {
    this.#retired = true;
    if (this.#streams.size === 0) this.#socket.close();
  }

  open(path: string, method: string, body: string | undefined, signal?: AbortSignal) {
    return new Promise<Response>((resolve, reject) => {
      if (this.#closed) {
        reject(streamClosed());
        return;
      }
      if (signal?.aborted === true) {
        reject(signal.reason);
        return;
      }
      const id = String(this.#nextId++);
      const onAbort = (): void => {
        this.#send({ t: 'cancel', id });
        stream.abort(signal?.reason);
        this.#forget(id);
      };
      const stream = new MuxStream(
        { resolve, reject },
        () => {
          signal?.removeEventListener('abort', onAbort);
        },
        (chars) => {
          this.#send({ t: 'credit', id, chars });
        },
        () => {
          this.#send({ t: 'cancel', id });
          this.#forget(id);
        },
      );
      this.#streams.set(id, stream);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#send({ t: 'open', id, method, path, ...(body === undefined ? {} : { body }) });
    });
  }

  #send(message: MuxClientMessage): void {
    if (this.#closed) return;
    try {
      this.#socket.send(JSON.stringify(message));
    } catch {
      // 正在關的 socket：`onclose` 會收掉每一條。
    }
  }

  #forget(id: string): void {
    this.#streams.get(id)?.stopAbortWatch();
    this.#streams.delete(id);
    if (this.#retired && this.#streams.size === 0) this.#socket.close();
  }

  #receive(data: unknown): void {
    const message = typeof data === 'string' ? parseMuxServerMessage(data) : undefined;
    if (message === undefined) {
      this.#socket.close();
      return;
    }
    const stream = this.#streams.get(message.id);
    if (stream === undefined) return;
    if (message.t === 'head') stream.head(message.status, message.contentType);
    else if (message.t === 'data') stream.data(message.text);
    else {
      stream.finish(message.t === 'error' ? new TypeError(message.message) : undefined);
      this.#forget(message.id);
    }
  }
}

/**
 * 形狀是 `fetch` 的下行載體，只取 `method`、字串 `body` 與 `signal`；標頭定在升級當下，`init.headers` 不送。
 *
 * - **退回 SSE**：握手失敗（代理擋升級、server 滿了、cookie 過期）就改走 {@link MuxFetchOptions.fallback}，過
 *   {@link MuxFetchOptions.fallbackMs} 才再試。
 * - **401 換一條 socket 再開一次**：cookie 定在升級當下，重新登入之後舊 socket 帶的還是舊的。舊的那條跑完手上的串流才關，
 *   新開的還是 401 就是真的 401。
 * - **斷線或 server 拒開**：`head` 之前是 `fetch` reject，之後是本體拋錯，跟 SSE 斷線同一種失敗，由呼叫端重開、重讀 `/history`。
 */
export function createMuxFetch(options: MuxFetchOptions): typeof globalThis.fetch {
  const now = options.now ?? Date.now;
  const fallbackMs = options.fallbackMs ?? MUX_FALLBACK_MS;
  let current: MuxCarrier | undefined;
  let fallbackUntil = 0;

  const connected = async (): Promise<MuxCarrier> => {
    if (current === undefined) {
      const carrier: MuxCarrier = new MuxCarrier(options.url, options.createSocket, () => {
        if (current === carrier) current = undefined;
      });
      current = carrier;
    }
    await current.opened;
    return current;
  };

  return async (input, init) => {
    if (now() < fallbackUntil) return options.fallback(input, init);
    const url = new URL(String(input), 'http://x');
    const path = `${url.pathname}${url.search}`;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : undefined;
    const signal = init?.signal ?? undefined;
    let carrier: MuxCarrier;
    try {
      carrier = await connected();
    } catch {
      fallbackUntil = now() + fallbackMs;
      return options.fallback(input, init);
    }
    const response = await carrier.open(path, method, body, signal);
    if (response.status !== 401) return response;
    await response.body?.cancel();
    if (current === carrier) {
      current = undefined;
      carrier.retire();
    }
    try {
      carrier = await connected();
    } catch {
      fallbackUntil = now() + fallbackMs;
      return options.fallback(input, init);
    }
    return carrier.open(path, method, body, signal);
  };
}
