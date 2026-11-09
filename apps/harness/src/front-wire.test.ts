/**
 * 前台的轉送與嵌入版的兩道檢查（#2341）。對話行程換成 Unix socket 上的假 HTTP 伺服器、監督行程換成記憶體裡的控制通道，
 * 轉送器與 `createFrontWireHandler` 是真的：`per-thread.integration.test.ts` 在沒有監督行程執行檔的機器上跳過，這一支照樣跑。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AccessRecord, StreamRecord } from './embed-audit.js';
import type { EmbedCookieVerdict } from './embed-session.js';
import {
  EMBED_REFUSED_HEADER,
  FRONT_CLOSING_HEADER,
  forwardedPrincipal,
  PRINCIPAL_HEADER,
} from './forwarded-principal.js';
import { FrontForwarder } from './front-forward.js';
import { createFrontWireHandler } from './front-wire.js';
import { SupervisorClient } from './supervisor-client.js';
import {
  decodeFrontRequest,
  encodeFrontEvent,
  frame,
  PROTOCOL_VERSION,
  takeFrames,
} from './supervisor-protocol.js';

/** 監督行程一起來就送的那顆 `hello`。 */
const HELLO = frame(
  encodeFrontEvent({
    type: 'hello',
    version: PROTOCOL_VERSION,
    token: '00112233445566778899aabbccddeeff',
  }),
);
import type { IdleSweepingWireHandler } from './wire-handler.js';
import { OWNER_PRINCIPAL } from './wire-principal.js';
import type { EmbedPrincipal } from './wire-principal.js';

const ALICE: EmbedPrincipal = {
  kind: 'embed',
  embedder: 'crm',
  subject: 'alice',
  userId: 'u-alice',
  sessionIdSha256: 'a'.repeat(64),
};

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** 假的對話行程：`handle` 決定怎麼回；每個請求的標頭與連線關掉的時刻都記下來。 */
async function conversation(handle: (request: IncomingMessage, response: ServerResponse) => void) {
  const dir = await mkdtemp(join(tmpdir(), 'front-wire-'));
  const socket = join(dir, 'c.sock');
  const seen: IncomingMessage[] = [];
  const closed: string[] = [];
  const server = createServer((request, response) => {
    seen.push(request);
    request.socket.once('close', () => closed.push(request.url ?? ''));
    handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  return { socket, seen, closed };
}

/** 監督行程那一端：每個 `ensure` 都回同一個 socket 的 `up`；收到的 thread id、打開方式、`release` 各記在 `ensured`、`modes`、`released`。 */
function supervisorAnswering(
  socket: string,
  ensured: string[] = [],
  modes: string[] = [],
  released: string[] = [],
): SupervisorClient {
  const input = new PassThrough();
  const output = new PassThrough();
  let pending = Buffer.alloc(0);
  output.on('data', (chunk: Buffer) => {
    const taken = takeFrames(Buffer.concat([pending, chunk]));
    pending = Buffer.from(taken.rest);
    for (const payload of taken.frames) {
      const request = decodeFrontRequest(payload);
      if (request.type === 'ensure') {
        ensured.push(request.threadId);
        modes.push(request.open);
        input.write(frame(encodeFrontEvent({ type: 'up', threadId: request.threadId, socket })));
      }
      if (request.type === 'release') released.push(request.threadId);
    }
  });
  const client = new SupervisorClient({ input, output });
  input.write(HELLO);
  cleanups.push(() => {
    input.end();
  });
  return client;
}

function front(
  socket: string,
  verdict: () => EmbedCookieVerdict,
  ensured: string[] = [],
  holdOpened: Promise<void> = Promise.resolve(),
) {
  const streams: StreamRecord[] = [];
  const access: AccessRecord[] = [];
  const modes: string[] = [];
  const released: string[] = [];
  const forwarder = new FrontForwarder();
  cleanups.push(() => forwarder.close());
  const local = {
    admit: () => undefined,
    embedRefusal: async () => undefined,
    handle: async () => new Response('local', { status: 418 }),
    close: async () => {},
    stopAdmission: () => {},
  } as unknown as IdleSweepingWireHandler;
  const handler = createFrontWireHandler({
    local,
    supervisor: supervisorAnswering(socket, ensured, modes, released),
    forwarder,
    auth: { authenticate: () => ALICE },
    embedStreams: {
      recheck: verdict,
      intervalMs: 20,
      audit: () => ({
        recordStream: async (record) => {
          streams.push(record);
          if (record.outcome === 'opened') await holdOpened;
        },
        recordAccess: async (record) => {
          access.push(record);
        },
      }),
    },
  });
  return { handler, streams, access, modes, released };
}

describe('createFrontWireHandler 的嵌入版', () => {
  it('身分放進內部標頭往下傳；對話行程拒絕帶回的原因記成 access，轉給客戶端前刪掉', async () => {
    const upstream = await conversation((_request, response) => {
      response.writeHead(200, {
        'content-type': 'application/json',
        [EMBED_REFUSED_HEADER]: 'thread_not_owned',
      });
      response.end('{"type":"error"}');
    });
    const { handler, access } = front(upstream.socket, () => ({ ok: true, principal: ALICE }));
    const response = await handler.handle(
      new Request('http://nexus.test/embed/threads/t1/history', {
        headers: { cookie: 'nexus_embed=x', [PRINCIPAL_HEADER]: 'forged' },
      }),
    );
    expect(response.headers.get(EMBED_REFUSED_HEADER)).toBeNull();
    expect(upstream.seen[0]?.headers.cookie).toBeUndefined();
    const forwarded = new Headers(upstream.seen[0]?.headers as Record<string, string>);
    expect(forwarded.get(PRINCIPAL_HEADER)).not.toBe('forged');
    expect(forwardedPrincipal(forwarded)).toEqual(ALICE);
    expect(access).toEqual([
      expect.objectContaining({
        outcome: 'refused',
        subject: 'alice',
        threadId: 't1',
        route: 'history',
        reason: 'thread_not_owned',
      }),
    ]);
  });

  it('轉送中的下行重驗沒過：2 秒內切掉、往對話行程的連線一起斷，稽核記 opened 與 cut', async () => {
    const upstream = await conversation((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(': connected\n\n');
    });
    let verdict: EmbedCookieVerdict = { ok: true, principal: ALICE };
    const { handler, streams } = front(upstream.socket, () => verdict);
    const response = await handler.handle(
      new Request('http://nexus.test/embed/threads/t1/stream', {
        method: 'POST',
        headers: { cookie: 'nexus_embed=x', 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(': connected\n\n');
    expect(streams.map(({ outcome }) => outcome)).toEqual(['opened']);

    verdict = { ok: false, reason: 'not_mapped' };
    const revokedAt = Date.now();
    await expect(reader.read()).rejects.toThrow('not_mapped');
    expect(Date.now() - revokedAt).toBeLessThan(2000);
    expect(streams.map(({ outcome }) => outcome)).toEqual(['opened', 'cut']);
    expect(streams[1]).toMatchObject({ reason: 'not_mapped', threadId: 't1' });
    await expect.poll(() => upstream.closed).toEqual(['/embed/threads/t1/stream']);
  });
});

describe('createFrontWireHandler 的打開方式', () => {
  it.each([
    ['一般路由', '/threads/t1', {}],
    ['嵌入路由', '/embed/threads/t1', { cookie: 'nexus_embed=x' }],
  ])('%s：開下行與讀歷史用 read-only，送指令用 run', async (_name, path, headers) => {
    const upstream = await conversation((request, response) => {
      if (request.url?.endsWith('/stream') === true) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(': connected\n\n');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 1, result: {} }));
    });
    const { handler, modes } = front(upstream.socket, () => ({ ok: true, principal: ALICE }));
    const stream = await handler.handle(
      new Request(`http://nexus.test${path}/stream`, { method: 'POST', headers, body: '{}' }),
    );
    expect(stream.status).toBe(200);
    await stream.body?.cancel();
    await handler.handle(new Request(`http://nexus.test${path}/history`, { headers }));
    await handler.handle(
      new Request(`http://nexus.test${path}/commands/run.start`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ id: 1, method: 'run.start', params: { text: 'hi' } }),
      }),
    );
    expect(modes).toEqual(['read-only', 'read-only', 'run']);
  });
});

describe('createFrontWireHandler 的 release', () => {
  it.each([
    ['一般路由', '/threads/t1', {}],
    ['嵌入路由', '/embed/threads/t1', { cookie: 'nexus_embed=x' }],
  ])(
    '%s：這條 thread 最後一條下行收掉才 release，讀歷史不 release',
    async (_name, path, headers) => {
      const upstream = await conversation((request, response) => {
        if (request.url?.endsWith('/stream') === true) {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.write(': connected\n\n');
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
      });
      const { handler, released } = front(upstream.socket, () => ({ ok: true, principal: ALICE }));
      const open = () =>
        handler.handle(
          new Request(`http://nexus.test${path}/stream`, { method: 'POST', headers, body: '{}' }),
        );
      const first = await open();
      const second = await open();
      await (
        await handler.handle(new Request(`http://nexus.test${path}/history`, { headers }))
      ).text();
      await first.body!.cancel();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(released).toEqual([]);
      await second.body!.cancel();
      await expect.poll(() => released).toEqual(['t1']);
    },
  );

  it('對話行程那頭把下行結束了，照樣算收掉', async () => {
    const upstream = await conversation((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(': bye\n\n');
    });
    const { handler, released } = front(upstream.socket, () => ({ ok: true, principal: ALICE }));
    const response = await handler.handle(
      new Request('http://nexus.test/threads/t1/stream', { method: 'POST', body: '{}' }),
    );
    await response.text();
    await expect.poll(() => released).toEqual(['t1']);
  });
});

describe('createFrontWireHandler 的內部路由', () => {
  it('客戶端打 /internal/threads/…：前台本地答，不轉給對話行程', async () => {
    const upstream = await conversation((_request, response) => response.end('{}'));
    const ensured: string[] = [];
    const { handler } = front(upstream.socket, () => ({ ok: true, principal: ALICE }), ensured);
    for (const [action, method] of [
      ['plugins', 'GET'],
      ['activity', 'GET'],
      ['turn-failures', 'GET'],
      ['stop', 'POST'],
      ['fork-seed', 'POST'],
      ['fork-adopt', 'POST'],
    ] as const) {
      const response = await handler.handle(
        new Request(`http://nexus.test/internal/threads/t1/${action}`, {
          method,
          ...(method === 'POST' && { body: '{"id":1,"fork":{"sourceHeader":{},"seed":[]}}' }),
        }),
      );
      expect(response.status).toBe(418);
    }
    expect(ensured).toEqual([]);
    expect(upstream.seen).toEqual([]);
  });
});

describe('createFrontWireHandler 的分叉（設計 §4-3）', () => {
  const FORK = { sourceHeader: { id: 'src' }, seed: [{ type: 'turn/end', seq: 0 }] };

  /** 假的對話行程：`fork-seed` 回 `seed`，`fork-adopt` 回成功；收到的路徑、本文、身分標頭照順序記下來。 */
  async function forkingConversation(seed: unknown) {
    const calls: { url: string; body: string; principal: string | undefined }[] = [];
    const upstream = await conversation((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => (body += chunk));
      request.on('end', () => {
        const principal = request.headers[PRINCIPAL_HEADER];
        calls.push({
          url: request.url ?? '',
          body,
          principal: typeof principal === 'string' ? principal : undefined,
        });
        response.writeHead(200, { 'content-type': 'application/json' });
        if (request.url?.endsWith('/fork-seed') === true) response.end(JSON.stringify(seed));
        else {
          const { id } = JSON.parse(body) as { id: number };
          response.end(
            JSON.stringify({
              id,
              type: 'success',
              result: { ok: true, value: { threadId: 'child-1' } },
            }),
          );
        }
      });
    });
    return { upstream, calls };
  }

  function forkRequest(path = '/threads/src'): Request {
    return new Request(`http://nexus.test${path}/commands/thread.fork`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 9, method: 'thread.fork', params: { messageId: 'm1' } }),
    });
  }

  function forkFront(socket: string, ensured: string[]) {
    const forwarder = new FrontForwarder();
    cleanups.push(() => forwarder.close());
    const modes: string[] = [];
    const local = {
      admit: () => undefined,
      embedRefusal: async () => undefined,
      handle: async () => new Response('local', { status: 418 }),
      close: async () => {},
      stopAdmission: () => {},
    } as unknown as IdleSweepingWireHandler;
    const onForwarded: string[] = [];
    const handler = createFrontWireHandler({
      local,
      supervisor: supervisorAnswering(socket, ensured, modes),
      forwarder,
      auth: { authenticate: () => OWNER_PRINCIPAL },
      newThreadId: () => 'child-1',
      onForwarded: (threadId) => onForwarded.push(threadId),
    });
    return { handler, modes, onForwarded };
  }

  it('來源用 read-only 開、向它要 seed；分得出去才替子 thread 用 run 開、交給它建；內部路由不帶身分標頭', async () => {
    const { upstream, calls } = await forkingConversation({ fork: FORK });
    const ensured: string[] = [];
    const { handler, modes, onForwarded } = forkFront(upstream.socket, ensured);
    const response = await handler.handle(forkRequest());
    expect(await response.json()).toEqual({
      id: 9,
      type: 'success',
      result: { ok: true, value: { threadId: 'child-1' } },
    });
    expect(ensured).toEqual(['src', 'child-1']);
    expect(modes).toEqual(['read-only', 'run']);
    expect(calls.map(({ url }) => url)).toEqual([
      '/internal/threads/src/fork-seed',
      '/internal/threads/child-1/fork-adopt',
    ]);
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ id: 9, params: { messageId: 'm1' } });
    expect(JSON.parse(calls[1]!.body)).toEqual({ id: 9, fork: FORK });
    expect(calls.map(({ principal }) => principal)).toEqual([undefined, undefined]);
    expect(onForwarded).toEqual(['child-1']);
  });

  it('分不出去：原樣回來源行程的那一份，不替子 thread 開行程', async () => {
    const answer = {
      id: 9,
      type: 'success',
      result: { ok: false, error: { code: 'fork_unavailable' } },
    };
    const { upstream, calls } = await forkingConversation({ answer });
    const ensured: string[] = [];
    const { handler } = forkFront(upstream.socket, ensured);
    expect(await (await handler.handle(forkRequest())).json()).toEqual(answer);
    expect(ensured).toEqual(['src']);
    expect(calls).toHaveLength(1);
  });

  it('停准入之後回 server_closing，不開任何行程', async () => {
    const { upstream, calls } = await forkingConversation({ fork: FORK });
    const ensured: string[] = [];
    const { handler } = forkFront(upstream.socket, ensured);
    handler.stopAdmission();
    expect(await (await handler.handle(forkRequest())).json()).toMatchObject({
      id: 9,
      error: 'server_closing',
    });
    expect(ensured).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('嵌入路由的分叉照一般轉送，不走內部路由', async () => {
    const { upstream, calls } = await forkingConversation({ fork: FORK });
    const ensured: string[] = [];
    const { handler } = forkFront(upstream.socket, ensured);
    await (await handler.handle(forkRequest('/embed/threads/src'))).text();
    expect(calls.map(({ url }) => url)).toEqual(['/embed/threads/src/commands/thread.fork']);
  });
});

describe('createFrontWireHandler 的 @ 會話候選', () => {
  it('前台冷讀磁碟答，不為一份清單起對話行程', async () => {
    const upstream = await conversation((_request, response) => response.end('{}'));
    const ensured: string[] = [];
    const { handler } = front(upstream.socket, () => ({ ok: true, principal: ALICE }), ensured);
    const response = await handler.handle(
      new Request('http://nexus.test/threads/t1/session-references?query=a'),
    );
    expect(response.status).toBe(418);
    expect(ensured).toEqual([]);
    expect(upstream.seen).toEqual([]);
  });
});

describe('createFrontWireHandler 的 run.cancel 與評分', () => {
  function command(path: string, method: string, params: unknown): Request {
    return new Request(`http://nexus.test${path}/commands/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 1, method, params }),
    });
  }

  it.each([
    ['一般路由', '/threads/t1'],
    ['嵌入路由', '/embed/threads/t1'],
  ])('%s：沒有行程時 run.cancel 由前台本地答，不起行程', async (_name, path) => {
    const upstream = await conversation((_request, response) => response.end('{}'));
    const ensured: string[] = [];
    const { handler } = front(upstream.socket, () => ({ ok: true, principal: ALICE }), ensured);
    const response = await handler.handle(command(path, 'run.cancel', {}));
    expect(response.status).toBe(418);
    expect(ensured).toEqual([]);
    expect(upstream.seen).toEqual([]);
  });

  it.each([
    ['一般路由', '/threads/t1'],
    ['嵌入路由', '/embed/threads/t1'],
  ])('%s：沒有行程時評分照樣轉給對話行程（要寫那條的日誌）', async (_name, path) => {
    const upstream = await conversation((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"id":1}');
    });
    const ensured: string[] = [];
    const { handler } = front(upstream.socket, () => ({ ok: true, principal: ALICE }), ensured);
    const response = await handler.handle(
      command(path, 'feedback.record', { targetId: 'm1', rating: 'up' }),
    );
    expect(response.status).toBe(200);
    expect(ensured).toEqual(['t1']);
    expect(upstream.seen.map(({ url }) => url)).toEqual([`${path}/commands/feedback.record`]);
  });
});

describe('createFrontWireHandler 的收尾（#1787）', () => {
  function command(path: string, method: string, params: unknown): Request {
    return new Request(`http://nexus.test${path}/commands/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 7, method, params }),
    });
  }

  it.each([
    ['一般路由', '/threads/t1'],
    ['嵌入路由', '/embed/threads/t1'],
  ])(
    '%s：stopAdmission 之後，沒有行程的 run.start 與 subagent.send 回 server_closing，不起行程',
    async (_name, path) => {
      const upstream = await conversation((_request, response) => response.end('{}'));
      const ensured: string[] = [];
      const { handler } = front(upstream.socket, () => ({ ok: true, principal: ALICE }), ensured);
      handler.stopAdmission();
      for (const [method, params] of [
        ['run.start', { text: 'hi' }],
        ['subagent.send', { runId: 'r1', text: 'hi' }],
      ] as const) {
        const response = await handler.handle(command(path, method, params));
        expect(await response.json()).toMatchObject({ id: 7, error: 'server_closing' });
      }
      expect(ensured).toEqual([]);
      expect(upstream.seen).toEqual([]);
    },
  );

  it('有行程的照轉，停准入之後帶標頭（對話行程照它擋這一個請求）；之前客戶端自己帶的被刪掉', async () => {
    const upstream = await conversation((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"id":7}');
    });
    const { handler } = front(upstream.socket, () => ({ ok: true, principal: ALICE }));
    const spoofed = command('/threads/t1', 'run.start', { text: '窗前' });
    spoofed.headers.set(FRONT_CLOSING_HEADER, '1');
    await handler.handle(spoofed);
    handler.stopAdmission();
    const response = await handler.handle(command('/threads/t1', 'run.start', { text: '窗內' }));
    expect(response.status).toBe(200);
    expect(upstream.seen.map((request) => request.headers[FRONT_CLOSING_HEADER])).toEqual([
      undefined,
      '1',
    ]);
  });

  it('監督行程答 shutdown：回 server_closing，不是 unknown_error', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let pending = Buffer.alloc(0);
    output.on('data', (chunk: Buffer) => {
      const taken = takeFrames(Buffer.concat([pending, chunk]));
      pending = Buffer.from(taken.rest);
      for (const payload of taken.frames) {
        const request = decodeFrontRequest(payload);
        if (request.type === 'ensure') {
          input.write(
            frame(
              encodeFrontEvent({ type: 'down', threadId: request.threadId, cause: 'shutdown' }),
            ),
          );
        }
      }
    });
    input.write(HELLO);
    cleanups.push(() => {
      input.end();
    });
    const forwarder = new FrontForwarder();
    cleanups.push(() => forwarder.close());
    const handler = createFrontWireHandler({
      local: {
        admit: () => undefined,
        stopAdmission: () => {},
      } as unknown as IdleSweepingWireHandler,
      supervisor: new SupervisorClient({ input, output }),
      forwarder,
      auth: { authenticate: () => ALICE },
    });
    const response = await handler.handle(command('/threads/t1', 'run.start', { text: 'hi' }));
    expect(await response.json()).toMatchObject({ id: 7, error: 'server_closing' });
  });
});

describe('createFrontWireHandler 的轉送失敗', () => {
  it('一條轉送 ECONNRESET（行程還在）：同一條 thread 開著的下行不受影響', async () => {
    let streamResponse: ServerResponse | undefined;
    const upstream = await conversation((request, response) => {
      if (request.url?.endsWith('/history') === true) {
        request.socket.destroy();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: 1\n\n');
      streamResponse = response;
    });
    const { handler } = front(upstream.socket, () => ({ ok: true, principal: ALICE }));
    const stream = await handler.handle(
      new Request('http://nexus.test/threads/t1/stream', { method: 'POST', body: '{}' }),
    );
    const reader = stream.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: 1\n\n');

    const failed = await handler.handle(new Request('http://nexus.test/threads/t1/history'));
    expect(await failed.text()).toContain('連不上');

    streamResponse!.write('data: 2\n\n');
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: 2\n\n');
  });

  it('socket 那頭沒有行程（ENOENT）：收掉整個 socket 的連線', async () => {
    const forget = vi.spyOn(FrontForwarder.prototype, 'forget');
    const dropIdle = vi.spyOn(FrontForwarder.prototype, 'dropIdle');
    cleanups.push(() => {
      forget.mockRestore();
      dropIdle.mockRestore();
    });
    const gone = join(tmpdir(), `front-wire-gone-${String(process.pid)}.sock`);
    const { handler } = front(gone, () => ({ ok: true, principal: ALICE }));
    const failed = await handler.handle(new Request('http://nexus.test/threads/t1/history'));
    expect(await failed.text()).toContain('連不上');
    expect(forget).toHaveBeenCalledWith(gone);
    expect(dropIdle).not.toHaveBeenCalled();
  });
});

describe('createFrontWireHandler 的嵌入下行收尾', () => {
  function embedStream(signal?: AbortSignal): Request {
    return new Request('http://nexus.test/embed/threads/t1/stream', {
      method: 'POST',
      headers: { cookie: 'nexus_embed=x', 'content-type': 'application/json' },
      body: '{}',
      ...(signal !== undefined && { signal }),
    });
  }

  it('寫 opened 的時候客戶端斷了：回 503、記 closed，不登記給重驗', async () => {
    const upstream = await conversation((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(': connected\n\n');
    });
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let rechecks = 0;
    const { handler, streams } = front(
      upstream.socket,
      () => {
        rechecks += 1;
        return { ok: true, principal: ALICE };
      },
      [],
      hold,
    );
    const controller = new AbortController();
    const pending = handler.handle(embedStream(controller.signal));
    await expect.poll(() => streams.map(({ outcome }) => outcome)).toEqual(['opened']);
    controller.abort();
    release();
    expect((await pending).status).toBe(503);
    expect(streams.map(({ outcome }) => outcome)).toEqual(['opened', 'closed']);
    expect(streams[1]).toMatchObject({ by: 'client' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(rechecks).toBe(0);
    await expect.poll(() => upstream.closed).toEqual(['/embed/threads/t1/stream']);
  });

  it('前台關機：還開著的嵌入下行記 closed（server），往對話行程的連線一起斷', async () => {
    const upstream = await conversation((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(': connected\n\n');
    });
    const { handler, streams } = front(upstream.socket, () => ({ ok: true, principal: ALICE }));
    const response = await handler.handle(embedStream());
    const reader = response.body!.getReader();
    await reader.read();
    await handler.close();
    await expect(reader.read()).rejects.toThrow('前台關機');
    expect(streams.map(({ outcome }) => outcome)).toEqual(['opened', 'closed']);
    expect(streams[1]).toMatchObject({ by: 'server' });
    await expect.poll(() => upstream.closed).toEqual(['/embed/threads/t1/stream']);
  });
});
