import { tool } from '@langchain/core/tools';
import { createWireClient } from '@nexus/wire';
import type { Event } from '@nexus/wire';
import { createDeepAgent, StateBackend } from 'deepagents';
import { request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { connect } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ScriptedChatModel } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import {
  emptyCommandPoint,
  fetchWithCookie,
  noSessions,
  TEST_BROWSER_AUTH,
  testSessionCookie,
} from './fixtures.js';
import { createWireHandler } from './wire-handler.js';
import { pathnameOf, startWireServer } from './wire-server.js';
import type { WireHandler } from './wire-handler.js';
import type { WireServer } from './wire-server.js';

/**
 * 一次真的 loopback 往返。
 *
 * 其餘的協定行為都在 `wire.test.ts` 裡用 `(Request) => Response` 驗完了，不需要 socket；
 * 這一條驗的是**只有真的 socket 才驗得到的那一段**：`node:http` 的 stream 翻成 fetch
 * 型別、SSE 的 chunk 真的一顆一顆推出去而不是積到最後才吐。不需要任何憑證或外部服務
 * ——loopback 上自己開一個 port 就夠（[#31](https://github.com/DemianLi/nexus-agent/issues/31)）。
 */

let running: WireServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

describe('接上真的 socket', () => {
  it('開線就先吐一行 SSE 註解，代理層才不會把 header 壓著', async () => {
    const agent = createDeepAgent({
      model: new ScriptedChatModel({ turns: [{ content: '好。' }] }),
      tools: [],
      backend: new StateBackend(),
    }) as unknown as PumpAgent;
    const handler = createWireHandler({
      auth: TEST_BROWSER_AUTH,
      createAgent: async () => ({
        agent,
        attachSessions: noSessions,
        commands: emptyCommandPoint(),
        dispose: async () => undefined,
      }),
    });
    running = await startWireServer({ handler });

    // 用裸 fetch 讀原始位元組——**這一條驗的是「還沒有任何封包時線上就有東西」**。
    // 少了它，直連看起來一切正常，而經過 dev server 的 proxy 就永遠停在「連線中」。
    const response = await fetch(`${running.url}/threads/prelude/stream`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: testSessionCookie(new URL(running.url).host),
      },
      body: JSON.stringify({ channels: ['lifecycle'] }),
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe(': connected\n\n');
    await reader.cancel();
    await handler.close();
  });

  it('SSE 是邊跑邊推，不是收工才一次吐完', async () => {
    // 工具在這裡卡住，直到測試放行為止——**「串流」與「一次吐完」的差別因此是可判定的**，
    // 不必靠時間或運氣。
    let release = (): void => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];

    const agent = createDeepAgent({
      model: new ScriptedChatModel({
        turns: [
          { content: '我來記。', toolCalls: [{ name: 'take_note', args: { text: '第一筆' } }] },
          { content: '記好了。' },
        ],
      }),
      tools: [
        tool(
          async ({ text }: { text: string }) => {
            await blocked;
            calls.push(text);
            return `已記下：${text}`;
          },
          {
            name: 'take_note',
            description: '記一段文字。',
            schema: z.object({ text: z.string() }),
          },
        ),
      ],
      backend: new StateBackend(),
    }) as unknown as PumpAgent;

    const handler = createWireHandler({
      auth: TEST_BROWSER_AUTH,
      createAgent: async () => ({
        agent,
        attachSessions: noSessions,
        commands: emptyCommandPoint(),
        dispose: async () => undefined,
      }),
    });
    running = await startWireServer({ handler });
    // 這裡刻意包的是全域的 fetch——走的是真的 HTTP，只多帶一顆會話 cookie（#424）。
    const client = createWireClient({
      baseUrl: running.url,
      fetch: fetchWithCookie(testSessionCookie(new URL(running.url).host)),
    });

    const events = await client.openEvents('socket', {
      channels: ['messages', 'tools', 'lifecycle'],
    });
    await client.runStart('socket', '記一筆。');

    const frames: Event[] = [];
    async function collectUntil(done: (collected: readonly Event[]) => boolean): Promise<void> {
      while (!done(frames)) {
        const next = await events.next();
        if (next.done === true) {
          return;
        }
        frames.push(next.value);
      }
    }

    // 工具還卡著的時候，前半段的 frame 已經越過 socket 到手了。
    await collectUntil((collected) =>
      collected.some(
        (frame) =>
          frame.method === 'tools' &&
          (frame.params.data as { event?: string }).event === 'tool-started',
      ),
    );
    expect(calls).toEqual([]);
    expect(
      frames
        .filter((frame) => frame.method === 'messages')
        .map((frame) => (frame.params.data as { delta?: { text?: string } }).delta?.text)
        .join(''),
    ).toBe('我來記。');

    release();
    await collectUntil((collected) =>
      collected.some((frame) => {
        const data = frame.params.data as { event?: string; graph_name?: string };
        return (
          frame.method === 'lifecycle' && data.event === 'completed' && data.graph_name === 'root'
        );
      }),
    );

    expect(calls).toEqual(['第一筆']);
    expect(
      frames
        .filter((frame) => frame.method === 'tools')
        .map((frame) => (frame.params.data as { tool_name?: string }).tool_name),
    ).toContain('take_note');
    handler.close();
  });
});

/** 直接寫進 socket 的請求，才寫得出 absolute-form 的請求行與壞掉的網址（fetch 會先幫你正規化）。 */
function rawRequest(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(text));
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      data += chunk;
    });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}

describe('最後一道防線（照 dsh webserver）', () => {
  it('absolute-form 的請求行照樣處理：只取路徑與 query，帶的 authority 不算數', async () => {
    const seen: string[] = [];
    const handler: WireHandler = {
      handle: async (request: Request) => {
        seen.push(request.url);
        return new Response('ok');
      },
      close: async () => undefined,
    };
    running = await startWireServer({ handler });
    const port = Number(new URL(running.url).port);
    const reply = await rawRequest(
      port,
      `GET http://evil.example/threads/x?y=1 HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
    );
    expect(reply.split('\r\n', 1)[0]).toBe('HTTP/1.1 200 OK');
    expect(seen).toEqual([`${running.url}/threads/x?y=1`]);
  });

  it('handler 拋錯：記一筆、回 400，行程照跑、下一個請求照常', async () => {
    const warned: Error[] = [];
    const handler: WireHandler = {
      handle: async (request: Request) => {
        if (new URL(request.url).pathname === '/boom') throw new Error('炸了');
        return new Response('ok');
      },
      close: async () => undefined,
    };
    running = await startWireServer({ handler, warn: (error) => void warned.push(error) });
    expect((await fetch(`${running.url}/boom`)).status).toBe(400);
    expect(warned.map((error) => error.message)).toEqual(['炸了']);
    const next = await fetch(`${running.url}/fine`);
    expect(next.status).toBe(200);
    expect(await next.text()).toBe('ok');
  });

  it('最後一道防線的紀錄帶方法與 pathname，query 的權杖一個字都不進（#1536）', async () => {
    const warned: { error: Error; request: { method: string; path: string } }[] = [];
    const handler: WireHandler = {
      handle: async () => {
        throw new Error('炸了');
      },
      close: async () => undefined,
    };
    running = await startWireServer({
      handler,
      warn: (error, request) => void warned.push({ error, request }),
    });
    expect((await fetch(`${running.url}/threads/t1/runs?token=SECRET-PROBE#frag`)).status).toBe(
      400,
    );
    expect(warned.map((entry) => entry.request)).toEqual([
      { method: 'GET', path: '/threads/t1/runs' },
    ]);
    expect(JSON.stringify(warned.map((entry) => entry.request))).not.toContain('SECRET-PROBE');
  });

  it('onResponse：每個請求回完算一次，帶 pathname（不含 query）與實際送出的狀態碼（#1535）', async () => {
    const seen: { path: string; status: number }[] = [];
    const handler: WireHandler = {
      handle: async (request: Request) => {
        const { pathname } = new URL(request.url);
        if (pathname === '/boom') throw new Error('炸了');
        return new Response('x', { status: pathname === '/teapot' ? 418 : 200 });
      },
      close: async () => undefined,
    };
    running = await startWireServer({
      handler,
      warn: () => undefined,
      onResponse: (info) => void seen.push(info),
    });
    await fetch(`${running.url}/fine?token=SECRET-PROBE`);
    await fetch(`${running.url}/teapot`);
    // handler 拋錯 → 最後一道防線回 400，算一次（不是 handle 內算一次、這裡又補一次）。
    await fetch(`${running.url}/boom`);
    expect(seen).toEqual([
      { path: '/fine', status: 200 },
      { path: '/teapot', status: 418 },
      { path: '/boom', status: 400 },
    ]);
    expect(JSON.stringify(seen)).not.toContain('SECRET-PROBE');
  });

  it('onResponse：本文太大的 413 也算；回呼拋了不影響回應', async () => {
    const seen: number[] = [];
    const handler: WireHandler = {
      handle: async () => new Response('ok'),
      close: async () => undefined,
    };
    running = await startWireServer({
      handler,
      maxRequestBodyBytes: 16,
      onResponse: ({ status }) => {
        seen.push(status);
        throw new Error('計數壞了');
      },
    });
    const big = await fetch(`${running.url}/threads/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'x'.repeat(256) }),
    });
    expect(big.status).toBe(413);
    const fine = await fetch(`${running.url}/fine`);
    expect(fine.status).toBe(200);
    expect(await fine.text()).toBe('ok');
    expect(seen).toEqual([413, 200]);
  });

  it('畸形的請求目標也印得出 pathname（用切的，不解析）', () => {
    expect(pathnameOf('/a/b?token=x')).toBe('/a/b');
    expect(pathnameOf('/a/b#frag')).toBe('/a/b');
    expect(pathnameOf('/a/%zz/b?x=1')).toBe('/a/%zz/b');
    expect(pathnameOf('?token=x')).toBe('');
    expect(pathnameOf('')).toBe('');
    expect(pathnameOf(undefined)).toBe('');
  });

  it('客戶端砍掉連線，handler 手上的 request.signal 跟著中止（#983）', async () => {
    // handler 只留 signal、不留 Request——`wire-handler.ts` 的 `handleList(request.signal)` 就是這樣。
    let seen: AbortSignal | undefined;
    const aborted = new Promise<void>((resolve) => {
      const handler: WireHandler = {
        handle: (request) => {
          seen = request.signal;
          seen.addEventListener('abort', () => resolve(), { once: true });
          // 不回答：連線一直掛著，直到客戶端砍掉它。
          return new Promise<Response>(() => undefined);
        },
        close: async () => undefined,
      };
      void startWireServer({ handler }).then((server) => {
        running = server;
        const { hostname, port } = new URL(server.url);
        const socket = connect({ host: hostname, port: Number(port) }, () => {
          socket.write(`GET / HTTP/1.1\r\nhost: ${hostname}\r\n\r\n`);
          setTimeout(() => socket.destroy(), 50);
        });
      });
    });

    await aborted;
    expect(seen?.aborted).toBe(true);
  });
});

/**
 * 選用的 gzip 壓縮（[#1570](https://github.com/DemianLi/nexus-agent/issues/1570)），逐條對 dsh `tests/webserver.spec.ts:313-401`。
 *
 * 用 `node:http` 的原始請求讀回應：`fetch` 會自己解壓，`content-encoding` 與位元組都被它吃掉，量不到「線上到底送了什麼」。
 */
describe('gzip 壓縮（#1570）', () => {
  interface Raw {
    readonly status: number;
    readonly headers: IncomingHttpHeaders;
    readonly body: Buffer;
  }

  function rawGet(url: string, headers: Record<string, string> = {}): Promise<Raw> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(url, { method: 'GET', headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
  }

  /** 每個請求都回同一份 `Response` 的手搭 handler。 */
  function fixed(make: () => Response): WireHandler {
    return { handle: async () => make(), close: async () => undefined } as unknown as WireHandler;
  }

  /** 4 KB 的 JSON：夠大、夠重複，壓得下去。 */
  const BIG_JSON = JSON.stringify({
    rows: Array.from({ length: 200 }, (_, i) => `row-${String(i)}`),
  });
  const json = (body: string, extra: Record<string, string> = {}): Response =>
    new Response(body, { headers: { 'content-type': 'application/json', ...extra } });

  it('打開時會壓：帶 accept-encoding: gzip，回 content-encoding: gzip，解回來與原文逐位元組相同', async () => {
    expect(BIG_JSON.length).toBeGreaterThan(1024);
    running = await startWireServer({
      handler: fixed(() => json(BIG_JSON)),
      compression: { level: 1, thresholdBytes: 1024 },
    });
    const response = await rawGet(running.url, { 'accept-encoding': 'gzip' });
    expect(response.status).toBe(200);
    expect(response.headers['content-encoding']).toBe('gzip');
    expect(String(response.headers.vary).toLowerCase()).toContain('accept-encoding');
    expect(response.body.length).toBeLessThan(BIG_JSON.length);
    expect(gunzipSync(response.body).equals(Buffer.from(BIG_JSON))).toBe(true);
  });

  it('等級有傳進去：level 0（只打包不壓縮）的線上位元組比 level 9 大，兩者解回來都等於原文', async () => {
    const sizes: number[] = [];
    for (const level of [0, 9]) {
      const server = await startWireServer({
        handler: fixed(() => json(BIG_JSON)),
        compression: { level, thresholdBytes: 0 },
      });
      try {
        const response = await rawGet(server.url, { 'accept-encoding': 'gzip' });
        expect(response.headers['content-encoding']).toBe('gzip');
        expect(gunzipSync(response.body).equals(Buffer.from(BIG_JSON))).toBe(true);
        sizes.push(response.body.length);
      } finally {
        await server.close();
      }
    }
    expect(sizes[0]).toBeGreaterThan(sizes[1]!);
  });

  it('不給選項不壓：同一個請求，沒有 content-encoding，位元組原樣（預設不變）', async () => {
    running = await startWireServer({ handler: fixed(() => json(BIG_JSON)) });
    const response = await rawGet(running.url, { 'accept-encoding': 'gzip' });
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.body.equals(Buffer.from(BIG_JSON))).toBe(true);
  });

  it('協商：br, gzip, deflate 選 gzip；gzip;q=0.5, identity;q=1 與沒帶 accept-encoding 都不壓', async () => {
    running = await startWireServer({
      handler: fixed(() => json(BIG_JSON)),
      compression: { level: 1, thresholdBytes: 1024 },
    });
    const negotiated = await rawGet(running.url, { 'accept-encoding': 'br, gzip, deflate' });
    expect(negotiated.headers['content-encoding']).toBe('gzip');
    const prefersIdentity = await rawGet(running.url, {
      'accept-encoding': 'gzip;q=0.5, identity;q=1',
    });
    expect(prefersIdentity.headers['content-encoding']).toBeUndefined();
    expect(prefersIdentity.body.equals(Buffer.from(BIG_JSON))).toBe(true);
    const none = await rawGet(running.url);
    expect(none.headers['content-encoding']).toBeUndefined();
  });

  it('門檻：已知長度 512 位元組不壓，4 KB 的壓；長度未知的串流可以壓', async () => {
    const small = 'x'.repeat(512);
    const big = JSON.stringify({ pad: 'y'.repeat(4096) });
    running = await startWireServer({
      handler: {
        handle: async (request: Request) => {
          const path = new URL(request.url).pathname;
          if (path === '/small') return json(small, { 'content-length': String(small.length) });
          if (path === '/big') return json(big, { 'content-length': String(big.length) });
          const encoder = new TextEncoder();
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(encoder.encode(BIG_JSON));
                controller.close();
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        },
        close: async () => undefined,
      } as unknown as WireHandler,
      compression: { level: 1, thresholdBytes: 1024 },
    });
    const gzip = { 'accept-encoding': 'gzip' };
    expect(
      (await rawGet(`${running.url}/small`, gzip)).headers['content-encoding'],
    ).toBeUndefined();
    expect((await rawGet(`${running.url}/big`, gzip)).headers['content-encoding']).toBe('gzip');
    const streamed = await rawGet(`${running.url}/stream`, gzip);
    expect(streamed.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(streamed.body).equals(Buffer.from(BIG_JSON))).toBe(true);
  });

  it('門檻目前只對自帶 content-length 的回應有效：沒有 content-length 的小回應（"ok"）照樣被壓（與 dsh 相同；docs/operations.md 的說明靠這一格）', async () => {
    running = await startWireServer({
      handler: fixed(() => new Response('ok', { headers: { 'content-type': 'text/plain' } })),
      compression: { level: 1, thresholdBytes: 1024 },
    });
    const response = await rawGet(running.url, { 'accept-encoding': 'gzip' });
    expect(response.headers['content-length']).toBeUndefined();
    expect(response.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(response.body).toString()).toBe('ok');
  });

  it('排除：content-range 不壓；application/gzip 不再壓一次；multipart/form-data 一律壓', async () => {
    running = await startWireServer({
      handler: {
        handle: async (request: Request) => {
          const path = new URL(request.url).pathname;
          if (path === '/range') {
            return new Response(BIG_JSON, {
              status: 206,
              headers: {
                'content-type': 'application/json',
                'content-range': `bytes 0-${String(BIG_JSON.length - 1)}/${String(BIG_JSON.length)}`,
              },
            });
          }
          if (path === '/gz') {
            return new Response(BIG_JSON, { headers: { 'content-type': 'application/gzip' } });
          }
          return new Response(BIG_JSON, {
            headers: { 'content-type': 'multipart/form-data; boundary=b' },
          });
        },
        close: async () => undefined,
      } as unknown as WireHandler,
      compression: { level: 1, thresholdBytes: 1024 },
    });
    const gzip = { 'accept-encoding': 'gzip' };
    const range = await rawGet(`${running.url}/range`, gzip);
    expect(range.status).toBe(206);
    expect(range.headers['content-encoding']).toBeUndefined();
    expect(range.body.equals(Buffer.from(BIG_JSON))).toBe(true);
    expect((await rawGet(`${running.url}/gz`, gzip)).headers['content-encoding']).toBeUndefined();
    const multipart = await rawGet(`${running.url}/multipart`, gzip);
    expect(multipart.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(multipart.body).equals(Buffer.from(BIG_JSON))).toBe(true);
  });

  it('非 SSE 的串流回應：標頭不等第一顆 body 就送出（flushHeaders 在壓縮之下照樣有效）', async () => {
    const FIRST_CHUNK_DELAY_MS = 600;
    running = await startWireServer({
      handler: fixed(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              async start(controller) {
                // 第一顆 body 故意晚到：標頭要是等它，用戶端的 `response` 事件就會晚到這麼久。
                await new Promise((resolve) => setTimeout(resolve, FIRST_CHUNK_DELAY_MS));
                controller.enqueue(new TextEncoder().encode(BIG_JSON));
                controller.close();
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
      ),
      compression: { level: 1, thresholdBytes: 1024 },
    });
    const startedAt = Date.now();
    const headerAt = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(running!.url, { headers: { 'accept-encoding': 'gzip' } }, (res) => {
        resolve(Date.now() - startedAt);
        expect(res.headers['content-encoding']).toBe('gzip');
        res.resume();
      });
      req.on('error', reject);
      req.end();
    });
    expect(headerAt).toBeLessThan(FIRST_CHUNK_DELAY_MS / 2);
  });

  it('最後一道防線在壓縮層裡面：handler 拋了，照樣回 400、行程不死', async () => {
    const warned: string[] = [];
    running = await startWireServer({
      handler: {
        handle: async () => {
          throw new Error('handler 拋了');
        },
        close: async () => undefined,
      } as unknown as WireHandler,
      compression: { level: 1, thresholdBytes: 1024 },
      warn: (error) => warned.push(error.message),
    });
    const response = await rawGet(running.url, { 'accept-encoding': 'gzip' });
    expect(response.status).toBe(400);
    expect(warned).toEqual(['handler 拋了']);
  });
});
