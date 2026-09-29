/**
 * 遙測刻意直連，不走對外代理（[#746](https://github.com/DemianLi/nexus-agent/issues/746)）。
 * 照 dsh 的 `packages/session/session-telemetry-otel/tests/egress.spec.ts`：OTLP 匯出走 `node:http`，不經 `fetch`，
 * 全域派送器管不到，dsh 評估過後維持直連，我們照做。
 *
 * **要有對照組，不然是假綠**：收集端放在 loopback 上，但用一個 `.invalid` 主機名去指它（本機位址一律直連，
 * 用 loopback 位址的話，「沒走代理」什麼都證明不了）。這個主機名**只在遙測那條連線上**被解析回 loopback；
 * 全域 `fetch` 打同一個位址，解析不到，會被送去代理——那就是對照組。
 */

import { once } from 'node:events';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { installProxyFromEnvironment, SessionLog, SessionTelemetryCoordinator } from '@nexus/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpenTelemetrySessionService } from './index.js';

let seen: string[] = [];
let captures: string[] = [];
const servers: Server[] = [];
let proxyUrl: string;
let collectorUrl: string;

async function listen(server: Server): Promise<string> {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(address.port)}`;
}

beforeAll(async () => {
  const proxy = createServer((request, response) => {
    seen.push(request.url ?? '');
    response.writeHead(502).end('fake-proxy');
  });
  proxy.on('connect', (request, socket) => {
    seen.push(request.url ?? '');
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  proxyUrl = await listen(proxy);
  const collector = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      captures.push(Buffer.concat(chunks).toString());
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  collectorUrl = (await listen(collector)).replace('127.0.0.1', 'otel-direct.invalid');
});

afterAll(() => {
  for (const server of servers) {
    server.close();
    server.closeAllConnections();
  }
});

describe('遙測匯出直連', () => {
  it('同一個安裝下：全域 fetch 打收集端位址被送去代理（對照組），遙測匯出一筆收集端直接收到、代理什麼都沒收到', async () => {
    seen = [];
    captures = [];
    const dispose = await installProxyFromEnvironment(
      {
        get: (name) =>
          name === 'HTTP_PROXY' || name === 'HTTPS_PROXY' ? { value: proxyUrl } : undefined,
      },
      () => undefined,
    );
    try {
      // 對照組：證明「一個走 fetch 的匯出器」會到代理。沒有這一段，下面的空陣列什麼都不代表。
      const response = await fetch(collectorUrl);
      await response.text();
      expect(response.status).toBe(502);
      expect(seen.length).toBeGreaterThan(0);
      seen = [];

      const service = new OpenTelemetrySessionService({
        mode: 'full',
        exporter: {
          url: `${collectorUrl}/v1/logs`,
          timeoutMillis: 1_000,
          // 只解析 SDK 的收集端連線，不動全域 fetch 的派送器。正式設定的 schema 擋掉 `httpAgentOptions`
          // （它可以是函式），這裡是測試才有的旁路。
          httpAgentOptions: {
            lookup: (
              _host: string,
              options: { all?: boolean },
              callback: (...args: unknown[]) => void,
            ) => {
              if (options.all === true) callback(null, [{ address: '127.0.0.1', family: 4 }]);
              else callback(null, '127.0.0.1', 4);
            },
          },
        } as never,
        processor: { scheduledDelayMillis: 60_000 },
      });
      const log = new SessionLog('thread-egress');
      const coordinator = new SessionTelemetryCoordinator({ log, sink: service });
      log.append('turn/start', { kind: 'message', text: '直連' });
      await coordinator.dispose();

      expect(captures.join('')).toContain('turn/start');
      expect(seen).toEqual([]);
    } finally {
      await dispose();
    }
  });
});
