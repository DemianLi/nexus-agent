/** 計數代理（#436）：數得準、超過上限的不轉出去、串流原樣通過、不記標頭。 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { startCountingProxy } from './counting-proxy.js';
import type { CountingProxy } from './counting-proxy.js';

let upstream: Server | undefined;
let proxy: CountingProxy | undefined;
const upstreamSeen: { url: string; auth: string | undefined; body: string }[] = [];

afterEach(async () => {
  await proxy?.close();
  proxy = undefined;
  upstream?.closeAllConnections();
  await new Promise<void>((resolve) =>
    upstream === undefined ? resolve() : upstream.close(() => resolve()),
  );
  upstream = undefined;
  upstreamSeen.length = 0;
});

async function start(cap: number): Promise<CountingProxy> {
  upstream = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      upstreamSeen.push({
        url: request.url ?? '',
        auth: request.headers.authorization,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: one\n\n');
      setTimeout(() => response.end('data: two\n\n'), 20);
    });
  });
  await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', resolve));
  const { port } = upstream.address() as AddressInfo;
  proxy = await startCountingProxy({ upstream: `http://127.0.0.1:${String(port)}/v1`, cap });
  return proxy;
}

async function post(baseUrl: string, body: string): Promise<{ status: number; text: string }> {
  const reply = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
    body,
  });
  return { status: reply.status, text: await reply.text() };
}

describe('計數代理', () => {
  it('轉出去的 POST 一個算一個；路徑接在上游的前綴後面；金鑰與本文原樣過去；串流整段回來', async () => {
    const counting = await start(5);
    const reply = await post(counting.baseUrl, '{"a":1}');
    expect(reply).toEqual({ status: 200, text: 'data: one\n\ndata: two\n\n' });
    expect(upstreamSeen).toEqual([
      { url: '/v1/chat/completions', auth: 'Bearer test-key', body: '{"a":1}' },
    ]);
    expect(counting.forwardedPosts()).toBe(1);
    expect(counting.requests()).toEqual([
      { method: 'POST', path: '/chat/completions', status: 200, blocked: false },
    ]);
    expect(JSON.stringify(counting.requests())).not.toContain('test-key');
  });

  it('超過上限的那一個不轉給上游，回 429，並記成被擋下', async () => {
    const counting = await start(2);
    await post(counting.baseUrl, '1');
    await post(counting.baseUrl, '2');
    expect(counting.overflowed()).toBe(false);
    const third = await post(counting.baseUrl, '3');
    expect(third.status).toBe(429);
    expect(upstreamSeen).toHaveLength(2);
    expect(counting.forwardedPosts()).toBe(2);
    expect(counting.overflowed()).toBe(true);
    expect(counting.requests().map((request) => request.blocked)).toEqual([false, false, true]);
  });

  it('上游連不上：回 502、記成 502，仍然算一個已轉出的 POST', async () => {
    const counting = await start(3);
    await new Promise<void>((resolve) => upstream!.close(() => resolve()));
    upstream = undefined;
    const reply = await post(counting.baseUrl, 'x');
    expect(reply.status).toBe(502);
    expect(counting.requests()[0]).toMatchObject({ status: 502, blocked: false });
    expect(counting.forwardedPosts()).toBe(1);
  });
});
