/**
 * 把 `(Request) => Response` 的 handler 接上一個真的 socket。
 *
 * **handler 與 listener 是分開的兩件事，這是刻意的**（照 dsh 的 `fetch/handler.ts`
 * 與它的載體分層）：協定的行為在 handler 上驗得完，不必綁 port；這一層只負責
 * 把 `node:http` 的 stream 翻成 fetch 的那組型別，它自己的正確性靠一次真的
 * loopback 往返來釘。
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WireHandler } from './wire-handler.js';

export interface WireServer {
  readonly url: string;
  close(): Promise<void>;
}

export interface StartWireServerOptions {
  readonly handler: WireHandler;
  /** 預設 0——由作業系統挑一個空的，測試因此可以平行跑。 */
  readonly port?: number;
  readonly host?: string;
}

async function toRequest(incoming: IncomingMessage, origin: string): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) {
    chunks.push(chunk as Buffer);
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (typeof value === 'string') {
      headers.set(name, value);
    }
  }
  const method = incoming.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  return new Request(`${origin}${incoming.url ?? '/'}`, {
    method,
    headers,
    ...(hasBody ? { body: Buffer.concat(chunks) } : {}),
  });
}

async function writeResponse(response: Response, outgoing: ServerResponse): Promise<void> {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  if (response.body === null) {
    outgoing.end();
    return;
  }
  // **一定要現在就把 header 送出去。** 不然 Node 會等到第一顆 body chunk 才發，
  // 而下行的第一顆 frame 可能要等使用者先送出上行——兩邊互等就死鎖了。
  outgoing.flushHeaders();
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      // 每一顆 frame 立刻推出去；SSE 的重點就是不要在這裡積著。
      outgoing.write(value);
    }
  } catch {
    // 對方先斷線是正常結束，不是錯誤。
  } finally {
    reader.releaseLock();
    outgoing.end();
  }
}

export async function startWireServer(options: StartWireServerOptions): Promise<WireServer> {
  const host = options.host ?? '127.0.0.1';
  const server: Server = createServer((incoming, outgoing) => {
    void (async () => {
      const address = server.address() as AddressInfo;
      const origin = `http://${host}:${address.port}`;
      // 對方斷線就中止這個 request 的 signal——**中止的是這條線，不是 agent 的 run**。
      const aborted = new AbortController();
      outgoing.on('close', () => aborted.abort());
      const request = await toRequest(incoming, origin);
      const response = await options.handler.handle(
        new Request(request, { signal: aborted.signal }),
      );
      await writeResponse(response, outgoing);
    })();
  });

  await new Promise<void>((resolve, reject) => {
    // listen 失敗（最常見的是 port 被佔住）會走 'error' 事件而不是 callback——
    // 不接的話它變成一個沒人處理的 error 事件，呼叫端只看到行程莫名其妙地死掉。
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;

  return {
    url: `http://${host}:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
