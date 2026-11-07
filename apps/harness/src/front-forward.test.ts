import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  FrontForwarder,
  forwardedRequestHeaders,
  forwardedResponseHeaders,
} from './front-forward.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function upstream(
  handle: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'front-forward-'));
  const socketPath = join(dir, 'c.sock');
  const server: Server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  return socketPath;
}

function forwarder(): FrontForwarder {
  const created = new FrontForwarder();
  cleanups.push(async () => created.close());
  return created;
}

describe('forwardedRequestHeaders', () => {
  it('拿掉憑證、來源與逐跳標頭，Host 換成 localhost，前台加的蓋過客戶端的', () => {
    const headers = new Headers({
      host: 'nexus.example:8443',
      cookie: 'nexus_session=secret',
      authorization: 'Bearer x',
      origin: 'https://nexus.example:8443',
      referer: 'https://nexus.example:8443/',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      connection: 'keep-alive, x-hop',
      'x-hop': '1',
      'keep-alive': 'timeout=5',
      'content-type': 'application/json',
      'last-event-id': '7',
      'x-nexus-principal': 'forged',
    });
    expect(forwardedRequestHeaders(headers, { 'X-Nexus-Principal': 'real' })).toEqual({
      'content-type': 'application/json',
      'last-event-id': '7',
      'x-nexus-principal': 'real',
      host: 'localhost',
    });
  });
});

describe('forwardedRequestHeaders 與內部身分標頭', () => {
  it('客戶端自己帶的身分標頭，前台沒有要加的時候也刪掉（主機擁有者不帶）', () => {
    const headers = new Headers({
      'x-nexus-principal': 'forged',
      'content-type': 'application/json',
    });
    expect(forwardedRequestHeaders(headers)).toEqual({
      'content-type': 'application/json',
      host: 'localhost',
    });
  });
});

describe('forwardedResponseHeaders', () => {
  it('拿掉逐跳標頭與 set-cookie，多值的照原樣', () => {
    const out = forwardedResponseHeaders({
      'content-type': 'text/event-stream',
      connection: 'keep-alive',
      'transfer-encoding': 'chunked',
      'set-cookie': ['a=1'],
      vary: 'accept-encoding',
    });
    expect([...out]).toEqual([
      ['content-type', 'text/event-stream'],
      ['vary', 'accept-encoding'],
    ]);
  });
});

describe('FrontForwarder', () => {
  it('轉方法、路徑、查詢與本文，回狀態碼、標頭與本文', async () => {
    const socketPath = await upstream((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        response.writeHead(201, { 'content-type': 'application/json', 'set-cookie': 'x=1' });
        response.end(
          JSON.stringify({
            method: request.method,
            url: request.url,
            host: request.headers.host,
            cookie: request.headers.cookie ?? null,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      });
    });
    const response = await forwarder().forward(
      new Request('https://nexus.example/threads/t1/commands/run.start?x=1', {
        method: 'POST',
        headers: { cookie: 'nexus_session=secret', 'content-type': 'application/json' },
        body: '{"id":1}',
      }),
      socketPath,
    );
    expect(response.status).toBe(201);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.json()).toEqual({
      method: 'POST',
      url: '/threads/t1/commands/run.start?x=1',
      host: 'localhost',
      cookie: null,
      body: '{"id":1}',
    });
  });

  it('下行一框一框過，不等回應結束', async () => {
    let finish: (() => void) | undefined;
    const socketPath = await upstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: 1\n\n');
      finish = () => response.end('data: 2\n\n');
    });
    const response = await forwarder().forward(
      new Request('http://localhost/threads/t1/stream', { method: 'POST', body: '{}' }),
      socketPath,
    );
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('data: 1\n\n');
    finish!();
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toBe('data: 2\n\n');
  });

  it('客戶端斷線，往下的連線跟著斷', async () => {
    let upstreamClosed: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      upstreamClosed = resolve;
    });
    const socketPath = await upstream((request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: 1\n\n');
      request.socket.once('close', () => upstreamClosed!());
    });
    const controller = new AbortController();
    const response = await forwarder().forward(
      new Request('http://localhost/threads/t1/stream', {
        method: 'POST',
        body: '{}',
        signal: controller.signal,
      }),
      socketPath,
    );
    await response.body!.getReader().read();
    controller.abort();
    await closed;
  });

  it('連不上就拋，呼叫端當成行程不在', async () => {
    await expect(
      forwarder().forward(
        new Request('http://localhost/threads/t1/history'),
        '/nonexistent/c.sock',
      ),
    ).rejects.toThrow();
  });
});
