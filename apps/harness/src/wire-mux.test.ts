/**
 * 一條 WebSocket 上的下行（#2262）：smoke 與 eval 走 SSE，走不到這條路，所以這裡用真的 socket 量。閘門用真的
 * `createWireHandler`，其餘用替身控制回應本體的節奏。
 */
import { createMuxFetch, createWireClient, WIRE_MUX_PATH } from '@nexus/wire';
import type { MuxSocket } from '@nexus/wire';
import { createDeepAgent, StateBackend } from 'deepagents';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { emptyCommandPoint, noSessions, TEST_BROWSER_AUTH, testSessionCookie } from './fixtures.js';
import { startForcedGc } from './measure/abort-delivery.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import { BrowserAuth } from './browser-auth.js';
import { createWireHandler } from './wire-handler.js';
import type { WireMuxHandler } from './wire-mux.js';
import { startWireServer } from './wire-server.js';
import type { StartWireServerOptions, WireServer } from './wire-server.js';

const PAGE = { host: 'localhost', origin: 'http://localhost' };

let running: WireServer | undefined;
const opened: WebSocket[] = [];

afterEach(async () => {
  for (const socket of opened.splice(0)) socket.terminate();
  await running?.close();
  running = undefined;
});

/** 用一個替身 `handle` 起 server，閘門全過。 */
async function start(
  handle: WireMuxHandler['handle'],
  options: Partial<StartWireServerOptions> = {},
): Promise<string> {
  running = await startWireServer({
    handler: { handle, close: () => Promise.resolve() },
    mux: { handle, admit: () => undefined },
    ...options,
  });
  return `${running.url.replace('http:', 'ws:')}${WIRE_MUX_PATH}`;
}

function dial(url: string, headers: Record<string, string> = PAGE, autoPong = true): WebSocket {
  const socket = new WebSocket(url, { headers, autoPong });
  opened.push(socket);
  return socket;
}

/** 升級的結果：開了回 101，被拒回狀態碼，沒有 HTTP 回應回 0。 */
function outcome(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    socket.once('open', () => {
      resolve(101);
    });
    socket.once('unexpected-response', (_request, response) => {
      resolve(response.statusCode ?? 0);
    });
    socket.once('error', () => {
      resolve(0);
    });
  });
}

const closed = (socket: WebSocket): Promise<number> =>
  new Promise((resolve) => {
    socket.once('close', resolve);
  });

const streamResponse = (body: ReadableStream<Uint8Array>): Response =>
  new Response(body, { headers: { 'content-type': 'text/event-stream' } });

const encoder = new TextEncoder();

/** 一個 `start` 就吐完的本體，不結束。 */
const hanging = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
    },
  });

function muxFetch(url: string, headers: Record<string, string> = PAGE) {
  return createMuxFetch({
    url,
    createSocket: (target) => dial(target, headers) as unknown as MuxSocket,
    fallback: () => Promise.reject(new Error('不該退回 SSE')),
  });
}

async function readText(response: Response): Promise<string> {
  return response.text();
}

async function firstChunk(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  const { value } = (await reader?.read()) ?? {};
  return new TextDecoder().decode(value);
}

async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等太久');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const STREAM = 'http://x/threads/t1/stream';
const post = { method: 'POST', body: '{"channels":[]}' };

describe('升級請求的閘門', () => {
  function realHandler(auth = TEST_BROWSER_AUTH) {
    const agent = createDeepAgent({
      model: new ScriptedChatModel({ turns: [] }),
      tools: [],
      backend: new StateBackend(),
    }) as unknown as PumpAgent;
    return createWireHandler({
      auth,
      createAgent: () =>
        Promise.resolve({
          agent,
          attachSessions: noSessions,
          commands: emptyCommandPoint(),
          dispose: () => Promise.resolve(undefined),
        }),
    });
  }

  async function upgradeUrl(): Promise<string> {
    const handler = realHandler();
    running = await startWireServer({ handler, mux: handler });
    return `${running.url.replace('http:', 'ws:')}${WIRE_MUX_PATH}`;
  }

  const cookie = testSessionCookie('localhost');
  const good = { ...PAGE, cookie };

  it('同源、有 cookie 才開得起來', async () => {
    await expect(outcome(dial(await upgradeUrl(), good))).resolves.toBe(101);
  });

  it.each([
    ['沒帶 Origin', { host: 'localhost', cookie }, 403],
    ['Origin 跨站', { ...good, origin: 'http://evil.example' }, 403],
    ['Origin 是字面 null', { ...good, origin: 'null' }, 403],
    ['Sec-Fetch-Site: cross-site', { ...good, 'sec-fetch-site': 'cross-site' }, 403],
    ['Host 不是 loopback', { ...good, host: 'evil.example', origin: 'http://evil.example' }, 403],
    ['沒有 cookie', PAGE, 401],
    ['別的 authority 的 cookie', { ...PAGE, cookie: testSessionCookie('127.0.0.1') }, 401],
    ['壞掉的 cookie', { ...PAGE, cookie: `${cookie}x` }, 401],
  ])('%s：握手前就拒絕', async (_name, headers: Record<string, string>, status) => {
    await expect(outcome(dial(await upgradeUrl(), headers))).resolves.toBe(status);
  });

  it('過期的 cookie：握手前就拒絕', async () => {
    const expired = new BrowserAuth(Buffer.alloc(32, 9), 1 / (24 * 60 * 60 * 1000));
    const response = expired.authorizeIndex(
      new Request(expired.authenticatedUrl('http://localhost'), {
        headers: { host: 'localhost' },
      }),
    );
    const staleCookie = response?.headers.get('set-cookie')?.split(';')[0] ?? '';
    expect(staleCookie).not.toBe('');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const handler = realHandler(expired);
    running = await startWireServer({ handler, mux: handler });
    const url = `${running.url.replace('http:', 'ws:')}${WIRE_MUX_PATH}`;
    await expect(outcome(dial(url, { ...PAGE, cookie: staleCookie }))).resolves.toBe(401);
  });

  it('沒過閘門的不交給 `ws`：回的是 HTTP，也不算成功升級', async () => {
    const seen: number[] = [];
    const handler = realHandler();
    running = await startWireServer({
      handler,
      mux: handler,
      onResponse: ({ status }) => void seen.push(status),
    });
    const url = `${running.url.replace('http:', 'ws:')}${WIRE_MUX_PATH}`;
    await expect(outcome(dial(url, PAGE))).resolves.toBe(401);
    expect(seen).toEqual([401]);
  });

  it('別的路徑：不信任的來源一樣先拿 403，沒身分先拿 401', async () => {
    const handler = realHandler();
    running = await startWireServer({ handler, mux: handler });
    const url = `${running.url.replace('http:', 'ws:')}/threads/feed`;
    const evil = { ...good, origin: 'http://evil.example' };
    await expect(outcome(dial(url, evil))).resolves.toBe(403);
    await expect(outcome(dial(url, PAGE))).resolves.toBe(401);
  });

  it('別的路徑不升級', async () => {
    const handler = realHandler();
    running = await startWireServer({ handler, mux: handler });
    const url = `${running.url.replace('http:', 'ws:')}/threads/feed`;
    await expect(outcome(dial(url, good))).resolves.toBe(404);
  });

  it('沒給 `mux` 就不接升級', async () => {
    running = await startWireServer({ handler: realHandler() });
    const url = `${running.url.replace('http:', 'ws:')}${WIRE_MUX_PATH}`;
    expect(await outcome(dial(url, good))).not.toBe(101);
  });
});

describe('邏輯串流', () => {
  it('狀態、content type、本文原樣回來；帶進 `handle` 的是升級時的標頭', async () => {
    const seen: Request[] = [];
    const url = await start(async (request) => {
      seen.push(request);
      return Promise.resolve(streamResponse(new Blob(['第一段', '第二段']).stream()));
    });
    const response = await muxFetch(url, { ...PAGE, cookie: 'c=1' })(STREAM, post);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    await expect(readText(response)).resolves.toBe('第一段第二段');
    const [request] = seen;
    expect(new URL(request?.url ?? '').pathname).toBe('/threads/t1/stream');
    expect(request?.headers.get('cookie')).toBe('c=1');
    expect(request?.headers.get('origin')).toBe(PAGE.origin);
    expect(request?.headers.get('content-type')).toBe('application/json');
  });

  it('`fetch` 在 `handle` 回來之後才兌現：`openEvents` 的契約', async () => {
    let finish: (() => void) | undefined;
    const url = await start(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return streamResponse(hanging('x'));
    });
    let resolved = false;
    const pending = muxFetch(url)(STREAM, post).then((response) => {
      resolved = true;
      return response;
    });
    await eventually(() => finish !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(resolved).toBe(false);
    finish?.();
    await expect(firstChunk(await pending)).resolves.toBe('x');
  });

  it('200 ＋ error 封包：走 `client.ts` 同一條拒絕的路', async () => {
    const url = await start(() =>
      Promise.resolve(
        Response.json({ type: 'error', code: 'not_supported', message: '不支援' }, { status: 200 }),
      ),
    );
    const client = createWireClient({ baseUrl: 'http://x', streamFetch: muxFetch(url) });
    await expect(client.openEvents('t1')).rejects.toThrow(/下行被拒/u);
  });

  it('只放行 `stream` 與 `feed`：別的路徑不進 `handle`', async () => {
    const seen: string[] = [];
    const url = await start((request) => {
      seen.push(request.url);
      return Promise.resolve(new Response('x'));
    });
    const fetcher = muxFetch(url);
    await expect(fetcher('http://x/threads/t1/history')).rejects.toThrow('route not allowed');
    await expect(fetcher('http://x/threads/t1/commands/run.start', post)).rejects.toThrow();
    await expect(fetcher(STREAM)).rejects.toThrow();
    expect(seen).toEqual([]);
  });

  it('計數：每條邏輯串流各算一次，升級也算', async () => {
    const seen: string[] = [];
    const url = await start(() => Promise.resolve(new Response('x', { status: 404 })), {
      onResponse: ({ path, status }) => void seen.push(`${path} ${String(status)}`),
    });
    await readText(await muxFetch(url)(STREAM, post));
    expect(seen).toEqual([`${WIRE_MUX_PATH} 101`, '/threads/t1/stream 404']);
  });
});

describe('計數也算失敗的', () => {
  it('`handle` 拋錯、路由不放行、超過串流上限各算一次', async () => {
    const seen: string[] = [];
    const url = await start(() => Promise.reject(new Error('壞了')), {
      warn: () => undefined,
      muxLimits: { maxStreams: 0 },
      onResponse: ({ path, status }) => void seen.push(`${path} ${String(status)}`),
    });
    const fetcher = muxFetch(url);
    await expect(fetcher(STREAM, post)).rejects.toThrow('too many streams');
    await expect(fetcher('http://x/threads/t1/history?x=1')).rejects.toThrow('route not allowed');
    expect(seen.slice(1)).toEqual(['/threads/t1/stream 429', '/threads/t1/history 404']);
  });

  it('`handle` 拋錯算 400', async () => {
    const seen: number[] = [];
    const url = await start(() => Promise.reject(new Error('壞了')), {
      warn: () => undefined,
      onResponse: ({ status }) => void seen.push(status),
    });
    await expect(muxFetch(url)(STREAM, post)).rejects.toThrow('stream failed');
    expect(seen).toEqual([101, 400]);
  });
});

describe('失敗只收在自己身上', () => {
  it('一條 `handle` 拋錯或本體出錯，同一條 socket 上別的串流不受影響', async () => {
    const warned: Error[] = [];
    const url = await start(
      (request) => {
        const id = new URL(request.url).pathname.split('/')[2];
        if (id === 'throws') return Promise.reject(new Error('壞了'));
        if (id === 'breaks') {
          return Promise.resolve(
            streamResponse(
              new ReadableStream({
                pull(controller) {
                  controller.error(new Error('本體壞了'));
                },
              }),
            ),
          );
        }
        return Promise.resolve(streamResponse(hanging('活著')));
      },
      { warn: (error) => void warned.push(error) },
    );
    const fetcher = muxFetch(url);
    const alive = await fetcher(STREAM, post);
    await expect(fetcher('http://x/threads/throws/stream', post)).rejects.toThrow('stream failed');
    const broken = await fetcher('http://x/threads/breaks/stream', post);
    await expect(readText(broken)).rejects.toThrow('stream failed');
    await expect(firstChunk(alive)).resolves.toBe('活著');
    expect(warned.map((error) => error.message).sort()).toEqual(['壞了', '本體壞了']);
  });

  it.each([
    ['壞的 JSON', 'not json'],
    ['未知的訊息種類', '{"t":"nope","id":"1"}'],
    ['形狀不對', '{"t":"open","id":"1"}'],
    ['不是物件', '[1]'],
  ])('%s：只關那條 socket，行程與別條照舊', async (_name, text) => {
    const url = await start(() => Promise.resolve(streamResponse(hanging('x'))));
    const bad = dial(url);
    await outcome(bad);
    bad.send(text);
    await expect(closed(bad)).resolves.toBe(1008);
    await expect(firstChunk(await muxFetch(url)(STREAM, post))).resolves.toBe('x');
  });

  it('二進位訊息、超過上限的訊息、重複的 id：同上', async () => {
    const url = await start(() => Promise.resolve(streamResponse(hanging('x'))));
    const binary = dial(url);
    await outcome(binary);
    binary.send(Buffer.from('x'));
    await closed(binary);
    const huge = dial(url);
    await outcome(huge);
    huge.send('x'.repeat(70 * 1024));
    await closed(huge);
    const twice = dial(url);
    await outcome(twice);
    const open = '{"t":"open","id":"1","method":"POST","path":"/threads/t/stream","body":"{}"}';
    twice.send(open);
    twice.send(open);
    await expect(closed(twice)).resolves.toBe(1008);
    await expect(firstChunk(await muxFetch(url)(STREAM, post))).resolves.toBe('x');
  });

  it('被拒絕的對方不關連線：serve 這邊送完就斷，`close` 不被卡住', async () => {
    const url = await start(() => Promise.resolve(new Response('x')));
    const { port } = new URL(url);
    const clients = await Promise.all(
      [1, 2, 3].map(
        () =>
          new Promise<Socket>((resolve) => {
            const socket = connect({ port: Number(port), host: '127.0.0.1', allowHalfOpen: true });
            socket.once('data', () => {
              resolve(socket);
            });
            socket.write(
              `GET ${WIRE_MUX_PATH} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`,
            );
          }),
      ),
    );
    try {
      const result = await Promise.race([
        running?.close().then(() => 'closed'),
        new Promise((resolve) => setTimeout(resolve, 2000, 'stuck')),
      ]);
      expect(result).toBe('closed');
      running = undefined;
    } finally {
      for (const client of clients) client.destroy();
    }
  });

  it('半個握手就斷線不會打掉行程', async () => {
    const url = await start(() => Promise.resolve(new Response('x')));
    const { port } = new URL(url);
    await new Promise<void>((resolve) => {
      const socket = connect(Number(port), '127.0.0.1', () => {
        socket.write(`GET ${WIRE_MUX_PATH} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n`);
        socket.destroy();
        resolve();
      });
    });
    await expect(readText(await muxFetch(url)(STREAM, post))).resolves.toBe('x');
  });
});

describe('中止', () => {
  it('`cancel`、讀者取消、socket 斷線都中止 handler 的 signal', async () => {
    const signals: AbortSignal[] = [];
    const url = await start((request) => {
      signals.push(request.signal);
      return Promise.resolve(streamResponse(hanging('x')));
    });
    const fetcher = muxFetch(url);
    const controller = new AbortController();
    await fetcher(STREAM, { ...post, signal: controller.signal });
    controller.abort();
    await eventually(() => signals[0]?.aborted === true);

    const response = await fetcher(STREAM, post);
    await response.body?.cancel();
    await eventually(() => signals[1]?.aborted === true);

    await fetcher(STREAM, post);
    opened[0]?.terminate();
    await eventually(() => signals[2]?.aborted === true);
  });

  it('**Request 活到串流結束**（#983）：handler 只留 signal，強制回收之後中止照樣送到', async () => {
    const signals: AbortSignal[] = [];
    const url = await start(
      (request) => {
        signals.push(request.signal);
        return Promise.resolve(streamResponse(hanging('x')));
      },
      { muxLimits: { maxStreams: 50 } },
    );
    const fetcher = muxFetch(url);
    const stopGc = startForcedGc(5);
    try {
      const controllers = Array.from({ length: 50 }, () => new AbortController());
      await Promise.all(
        controllers.map((controller) => fetcher(STREAM, { ...post, signal: controller.signal })),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(signals).toHaveLength(50);
      for (const controller of controllers) controller.abort();
      await eventually(() => signals.every((signal) => signal.aborted));
    } finally {
      stopGc();
    }
  });

  it('收工：socket 斷掉、本體放掉，`close` 不被卡住', async () => {
    let cancelled = false;
    const url = await start(() =>
      Promise.resolve(
        streamResponse(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        ),
      ),
    );
    const client = dial(url);
    const gone = closed(client);
    await outcome(client);
    client.send('{"t":"open","id":"1","method":"POST","path":"/threads/t/stream","body":"{}"}');
    await new Promise((resolve) => setTimeout(resolve, 30));
    await running?.close();
    running = undefined;
    await gone;
    expect(cancelled).toBe(true);
  });
});

describe('背壓', () => {
  it('讀者不讀就停在額度；同一條 socket 上別條照跑', async () => {
    let pulled = 0;
    const url = await start(
      (request) => {
        if (request.url.includes('other'))
          return Promise.resolve(streamResponse(hanging('另一條')));
        return Promise.resolve(
          streamResponse(
            new ReadableStream(
              {
                pull(controller) {
                  pulled += 1;
                  controller.enqueue(encoder.encode('x'.repeat(100)));
                },
              },
              { highWaterMark: 0 },
            ),
          ),
        );
      },
      { muxLimits: { windowChars: 1000 } },
    );
    const fetcher = muxFetch(url);
    const slow = await fetcher(STREAM, post);
    await eventually(() => pulled >= 10);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pulled).toBe(10);

    const other = await fetcher('http://x/threads/other/stream', post);
    await expect(firstChunk(other)).resolves.toBe('另一條');

    const reader = slow.body?.getReader();
    await reader?.read();
    await reader?.read();
    await eventually(() => pulled >= 12);
    await reader?.cancel();
  });
});

describe('上限', () => {
  it('整台 serve 的 socket 總數：超過回 503，關掉一條又進得來', async () => {
    const url = await start(() => Promise.resolve(new Response('x')), {
      muxLimits: { maxSockets: 2 },
    });
    const first = dial(url);
    await expect(outcome(first)).resolves.toBe(101);
    await expect(outcome(dial(url))).resolves.toBe(101);
    await expect(outcome(dial(url))).resolves.toBe(503);
    first.terminate();
    await closed(first);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(outcome(dial(url))).resolves.toBe(101);
  });

  it('每條 socket 的串流數：超過的那條拒絕，收掉一條又開得起來', async () => {
    const url = await start(() => Promise.resolve(streamResponse(hanging('x'))), {
      muxLimits: { maxStreams: 2 },
    });
    const fetcher = muxFetch(url);
    const first = await fetcher(STREAM, post);
    await fetcher(STREAM, post);
    await expect(fetcher(STREAM, post)).rejects.toThrow('too many streams');
    await first.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(fetcher(STREAM, post)).resolves.toBeInstanceOf(Response);
  });
});

describe('心跳', () => {
  it('對方不回 pong：連兩拍之後斷線，邏輯串流中止', async () => {
    const lines: string[] = [];
    const signals: AbortSignal[] = [];
    const url = await start(
      (request) => {
        signals.push(request.signal);
        return Promise.resolve(streamResponse(hanging('x')));
      },
      { heartbeatIntervalMs: 10, warnDisconnect: (line) => void lines.push(line) },
    );
    const mute = dial(url, PAGE, false);
    const gone = closed(mute);
    await outcome(mute);
    mute.send('{"t":"open","id":"1","method":"POST","path":"/threads/t/stream","body":"{}"}');
    await gone;
    await eventually(() => signals[0]?.aborted === true);
    expect(lines).toHaveLength(1);
  });

  it('有回 pong 的閒置 socket 不會被斷', async () => {
    const url = await start(() => Promise.resolve(new Response('x')), { heartbeatIntervalMs: 10 });
    const alive = dial(url);
    await outcome(alive);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(alive.readyState).toBe(WebSocket.OPEN);
  });
});

describe('退回 SSE 與重新登入', () => {
  it('握手被擋就走 fallback，時間到才再試', async () => {
    const url = await start(() => Promise.resolve(new Response('走 mux')), {
      muxLimits: { maxSockets: 0 },
    });
    let time = 0;
    const fallback = (): Promise<Response> => Promise.resolve(new Response('走 SSE'));
    let dials = 0;
    const fetcher = createMuxFetch({
      url,
      createSocket: (target) => {
        dials += 1;
        return dial(target) as unknown as MuxSocket;
      },
      fallback,
      fallbackMs: 1000,
      now: () => time,
    });
    await expect(readText(await fetcher(STREAM, post))).resolves.toBe('走 SSE');
    await expect(readText(await fetcher(STREAM, post))).resolves.toBe('走 SSE');
    expect(dials).toBe(1);
    time = 1000;
    await fetcher(STREAM, post);
    expect(dials).toBe(2);
  });

  it('401：換一條 socket 再開一次，帶到新的 cookie；舊的跑完手上的才關', async () => {
    const url = await start((request) =>
      Promise.resolve(
        request.headers.get('cookie') === 'new'
          ? streamResponse(hanging('登入後'))
          : request.url.includes('held')
            ? streamResponse(hanging('舊線'))
            : new Response('unauthorized', { status: 401 }),
      ),
    );
    let cookie = 'old';
    const sockets: WebSocket[] = [];
    const fetcher = createMuxFetch({
      url,
      createSocket: (target) => {
        const socket = dial(target, { ...PAGE, cookie });
        sockets.push(socket);
        return socket as unknown as MuxSocket;
      },
      fallback: () => Promise.reject(new Error('不該退回 SSE')),
    });
    const held = await fetcher('http://x/threads/held/stream', post);
    cookie = 'new';
    await expect(firstChunk(await fetcher(STREAM, post))).resolves.toBe('登入後');
    expect(sockets).toHaveLength(2);
    expect(sockets[0]?.readyState).toBe(WebSocket.OPEN);
    await held.body?.cancel();
    await closed(sockets[0] as WebSocket);
  });

  it('換了 socket 還是 401：就是真的 401，只重連一次', async () => {
    const url = await start(() => Promise.resolve(new Response('no', { status: 401 })));
    let dials = 0;
    const fetcher = createMuxFetch({
      url,
      createSocket: (target) => {
        dials += 1;
        return dial(target) as unknown as MuxSocket;
      },
      fallback: () => Promise.reject(new Error('不該退回 SSE')),
    });
    expect((await fetcher(STREAM, post)).status).toBe(401);
    expect(dials).toBe(2);
  });

  it('socket 斷了，開著的本體拋錯，下一次重開新的一條', async () => {
    const url = await start(() => Promise.resolve(streamResponse(hanging('x'))));
    const fetcher = muxFetch(url);
    const response = await fetcher(STREAM, post);
    const reader = response.body?.getReader();
    await reader?.read();
    const socket = opened[0];
    socket?.terminate();
    await closed(socket as WebSocket);
    await expect(reader?.read()).rejects.toThrow('斷了');
    await expect(firstChunk(await fetcher(STREAM, post))).resolves.toBe('x');
  });
});
