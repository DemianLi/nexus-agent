/**
 * 前台把一則 wire 請求轉給對話行程（[#2341](https://github.com/DemianLi/nexus-agent/issues/2341)，設計 `.docs/supervisor-1947-design-2026-11-03.md` §3-2、§4-2）：
 * HTTP over Unix socket，wire 協定原樣，對話行程那一端是 `peer-socket-auth.ts`。
 *
 * - **前台已經驗過人**，對話行程只信 socket 目錄的權限，所以瀏覽器帶來的憑證與來源標頭不往下傳：`cookie`、`authorization`、
 *   `origin`、`referer`、`sec-fetch-*`。`host` 改成 `localhost`：對話行程不該看到外面的主機名；只換 `Host` 又留著
 *   `Origin`，`request-trust.ts` 會把它當成跨源擋掉（#2341）。
 * - 逐跳標頭（`connection` 那一串）兩個方向都拿掉，照 RFC 9110 §7.6.1。回應的 `set-cookie` 也拿掉：登入只在前台。
 * - **兩個方向都是串流**：上傳不在前台聚合，SSE 的下行一框一框過；客戶端斷線（`request.signal`）就斷掉往下的那條連線，
 *   對話行程那邊看到的跟客戶端直接斷線一樣。
 * - 每個 socket 一個 keep-alive 的 agent，行程走了（`forget`）就收掉。
 *
 * @module
 */

import { Agent, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { Readable } from 'node:stream';

import { PRINCIPAL_HEADER } from './forwarded-principal.js';

/** 不往對話行程傳的請求標頭。 */
const DROPPED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'cookie',
  'authorization',
  'origin',
  'referer',
  // 身分只由前台放（`forwarded-principal.ts`）：客戶端帶來的一律刪，不然誰都能冒充別人。
  PRINCIPAL_HEADER,
]);

/** 不往客戶端傳的回應標頭。 */
const DROPPED_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'set-cookie',
]);

/**
 * 往下傳的請求標頭。
 *
 * @param extra - 前台自己加的（身分）；同名的蓋過客戶端帶來的。
 */
export function forwardedRequestHeaders(
  headers: Headers,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  // `Connection` 點名的標頭也是逐跳的（RFC 9110 §7.6.1）。
  const named = new Set(
    (headers.get('connection') ?? '')
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token !== ''),
  );
  for (const [name, value] of headers) {
    if (DROPPED_REQUEST_HEADERS.has(name) || named.has(name) || name.startsWith('sec-fetch-')) {
      continue;
    }
    out[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) out[name.toLowerCase()] = value;
  out.host = 'localhost';
  return out;
}

/** 往客戶端傳的回應標頭。 */
export function forwardedResponseHeaders(headers: IncomingHttpHeaders): Headers {
  const named = new Set(
    String(headers.connection ?? '')
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token !== ''),
  );
  const out = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || DROPPED_RESPONSE_HEADERS.has(name) || named.has(name)) continue;
    if (Array.isArray(value)) {
      for (const item of value) out.append(name, item);
    } else {
      out.set(name, value);
    }
  }
  return out;
}

/** 轉送器：一個 socket 一個 agent。 */
export class FrontForwarder {
  readonly #agents = new Map<string, Agent>();

  /**
   * 把 `request` 轉給在 `socketPath` 上聽的對話行程，回它的回應。
   *
   * @param extraHeaders - 前台加給對話行程的標頭。
   * @throws 連不上（行程剛走、socket 不在）：呼叫端把它當成這條 thread 的行程不在。
   */
  forward(
    request: Request,
    socketPath: string,
    extraHeaders: Readonly<Record<string, string>> = {},
  ): Promise<Response> {
    const url = new URL(request.url);
    const signal = request.signal;
    return new Promise<Response>((resolve, reject) => {
      const outgoing = httpRequest(
        {
          socketPath,
          agent: this.#agentFor(socketPath),
          method: request.method,
          path: `${url.pathname}${url.search}`,
          headers: forwardedRequestHeaders(request.headers, extraHeaders),
        },
        (incoming) => {
          const status = incoming.statusCode ?? 502;
          const headers = forwardedResponseHeaders(incoming.headers);
          if (status === 204 || status === 304 || request.method === 'HEAD') {
            incoming.resume();
            resolve(new Response(null, { status, headers }));
            return;
          }
          // 客戶端不讀了（下行斷線）會 cancel 這支串流，`toWeb` 接著 destroy `incoming`，往下的連線就斷了。
          const body = Readable.toWeb(incoming) as globalThis.ReadableStream<Uint8Array>;
          resolve(new Response(body, { status, headers }));
        },
      );
      const onAbort = (): void => {
        outgoing.destroy(signal.reason instanceof Error ? signal.reason : new Error('客戶端斷線'));
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
        outgoing.once('close', () => signal.removeEventListener('abort', onAbort));
      }
      outgoing.once('error', reject);
      if (request.body === null) {
        outgoing.end();
        return;
      }
      const body = Readable.fromWeb(request.body as import('node:stream/web').ReadableStream);
      body.once('error', (error) => outgoing.destroy(error));
      body.pipe(outgoing);
    });
  }

  /** 這個 socket 的行程走了：收掉它的連線。 */
  forget(socketPath: string): void {
    this.#agents.get(socketPath)?.destroy();
    this.#agents.delete(socketPath);
  }

  /** 收掉全部連線（前台停機）。 */
  close(): void {
    for (const agent of this.#agents.values()) agent.destroy();
    this.#agents.clear();
  }

  #agentFor(socketPath: string): Agent {
    let agent = this.#agents.get(socketPath);
    if (agent === undefined) {
      agent = new Agent({ keepAlive: true });
      this.#agents.set(socketPath, agent);
    }
    return agent;
  }
}
