/**
 * 計數轉接器（[#2367](https://github.com/DemianLi/nexus-agent/issues/2367)）：原樣轉、數得對、到上限或上游不是 200 就停，停了之後一個都不轉出去。
 * 上游是本機的替身，不連外。
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { startCountingProxy } from './counting-proxy.js';
import type { CountingProxy } from './counting-proxy.js';

let upstream: Server | undefined;
let proxy: CountingProxy | undefined;
const hits: { path: string; auth: string | undefined; body: string }[] = [];

afterEach(async () => {
  await proxy?.close();
  const server = upstream;
  if (server !== undefined) await new Promise((resolve) => server.close(resolve));
  upstream = undefined;
  proxy = undefined;
  hits.length = 0;
});

/** 起一個上游替身：第 `failAt` 個請求（從 1 起）回 429，其餘 200。 */
async function startUpstream(failAt?: number): Promise<string> {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      hits.push({
        path: req.url ?? '',
        auth: req.headers.authorization,
        body: Buffer.concat(chunks).toString(),
      });
      const status = hits.length === failAt ? 429 : 200;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ n: hits.length }));
    });
  });
  await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${String((upstream!.address() as AddressInfo).port)}/v1`;
}

const call = (base: string) =>
  fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
    body: '{"x":1}',
  });

describe('計數轉接器', () => {
  it('原樣轉：路徑、authorization、body、回應都對得上，一個算一個', async () => {
    proxy = await startCountingProxy(await startUpstream(), 5);
    const response = await call(proxy.baseUrl);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ n: 1 });
    expect(hits).toEqual([{ path: '/v1/chat/completions', auth: 'Bearer test', body: '{"x":1}' }]);
    expect(proxy.count()).toBe(1);
    expect(proxy.stopped()).toBeUndefined();
  });

  it('到上限就停：第 limit+1 個回 503，上游收不到', async () => {
    proxy = await startCountingProxy(await startUpstream(), 2);
    await call(proxy.baseUrl);
    await call(proxy.baseUrl);
    expect((await call(proxy.baseUrl)).status).toBe(503);
    expect(hits).toHaveLength(2);
    expect(proxy.count()).toBe(2);
    expect(proxy.stopped()).toMatch(/上限 2/u);
  });

  it('上游回了不是 200：那一個照樣交回去，之後一律 503、不再轉出', async () => {
    proxy = await startCountingProxy(await startUpstream(1), 10);
    expect((await call(proxy.baseUrl)).status).toBe(429);
    expect(proxy.stopped()).toMatch(/429/u);
    expect((await call(proxy.baseUrl)).status).toBe(503);
    expect(hits).toHaveLength(1);
  });

  it('上游連不上：停下，回 503', async () => {
    proxy = await startCountingProxy('http://127.0.0.1:9/v1', 10);
    expect((await call(proxy.baseUrl)).status).toBe(503);
    expect(proxy.stopped()).toMatch(/連不上上游/u);
  });
});
