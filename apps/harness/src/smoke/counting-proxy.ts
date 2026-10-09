/**
 * 在出口數請求的本機轉送代理（[#436](https://github.com/DemianLi/nexus-agent/issues/436)）。
 *
 * 冒煙回歸每次執行的請求數有上限（PM 2026-10-08：20 以內，超過判失敗）。**要在出口數，不能從日誌推**：`model/start` 數不到標題模型的呼叫
 * （`session-title-llm.ts` 檔頭：那次呼叫不經 middleware），也數不到失敗後的重試。把 `live-model` 的 `baseUrl` 換成這個代理，
 * 每個 POST 進來先記一筆；**超過上限的那一個不轉出去**，直接回 429，在花錢之前就停。
 *
 * 金鑰會經過這裡（`authorization` 標頭轉給上游），所以代理**不記標頭、不記本文**，只記方法、路徑與狀態碼。
 *
 * @module
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** 一筆轉出去（或被擋下）的請求。 */
export interface ProxiedRequest {
  readonly method: string;
  readonly path: string;
  /** 上游回的狀態碼；被上限擋下的是 429，上游連不上是 502。 */
  readonly status: number;
  /** 被上限擋下、沒有轉出去。 */
  readonly blocked: boolean;
}

export interface CountingProxy {
  /** 給 `live-model` 的 `baseUrl`（含上游的路徑前綴）。 */
  readonly baseUrl: string;
  /** 目前為止的請求，依到達順序。 */
  requests(): readonly ProxiedRequest[];
  /** 實際轉給上游的 POST 數（被擋下的不算）。 */
  forwardedPosts(): number;
  /** 有沒有請求被上限擋下。 */
  overflowed(): boolean;
  close(): Promise<void>;
}

export interface CountingProxyOptions {
  /** 上游的 base URL，例如 `https://integrate.api.nvidia.com/v1`。 */
  readonly upstream: string;
  /** 最多轉出幾個 POST。 */
  readonly cap: number;
}

/** 不轉給上游的標頭：連線層的，與 fetch 自己算的。 */
const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'accept-encoding',
]);

/** 不回給呼叫端的標頭：fetch 已經解過壓縮，長度與編碼都對不上了。 */
const NOT_RELAYED = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
]);

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * 起一個計數代理。
 *
 * @param options - 上游與上限。
 * @returns 代理；用完要 `close()`。
 */
export async function startCountingProxy(options: CountingProxyOptions): Promise<CountingProxy> {
  const upstream = new URL(options.upstream);
  const prefix = upstream.pathname.replace(/\/$/u, '');
  const seen: ProxiedRequest[] = [];
  let forwarded = 0;
  let blockedAny = false;

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const method = request.method ?? 'GET';
    const path = request.url ?? '/';
    const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(request);
    if (method === 'POST' && forwarded >= options.cap) {
      blockedAny = true;
      seen.push({ method, path, status: 429, blocked: true });
      response.writeHead(429, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ error: { message: `冒煙回歸的請求上限 ${String(options.cap)} 已用完` } }),
      );
      return;
    }
    if (method === 'POST') forwarded += 1;
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (HOP_BY_HOP.has(name) || value === undefined) continue;
      headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    try {
      const reply = await fetch(`${upstream.origin}${prefix}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: new Uint8Array(body) }),
      });
      seen.push({ method, path, status: reply.status, blocked: false });
      const relay: Record<string, string> = {};
      reply.headers.forEach((value, name) => {
        if (!NOT_RELAYED.has(name)) relay[name] = value;
      });
      response.writeHead(reply.status, relay);
      if (reply.body === null) {
        response.end();
        return;
      }
      const reader = reply.body.getReader();
      response.on('close', () => void reader.cancel().catch(() => undefined));
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        response.write(value);
      }
      response.end();
    } catch {
      seen.push({ method, path, status: 502, blocked: false });
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: '代理連不上上游' } }));
    }
  };

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch(() => response.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    requests: () => seen,
    forwardedPosts: () => forwarded,
    overflowed: () => blockedAny,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
