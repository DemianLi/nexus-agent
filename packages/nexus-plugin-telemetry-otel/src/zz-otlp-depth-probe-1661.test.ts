/**
 * 暫時的探針（#1661）：OTLP/HTTP JSON 這條流水線送得出去的 body 最多幾層。量完就撤。
 *
 * 走插件真的流水線：`OpenTelemetrySessionService.emit` → BatchLogRecordProcessor → OTLPLogExporter（`toAnyValue` 與
 * `JSON.stringify`）→ loopback 假 collector。body 的形狀同協調器交的（`snapshotJsonValue` 拷過、沒凍過的 data），
 * 層數的算法同 `SESSION_EVENT_MAX_DEPTH`：body 本身算第 1 層，純量不算。收端不 `JSON.parse`，只看 `"leaf"` 有沒有到。
 * vitest 會吞 console，數字用故意丟錯帶到報告上。
 */

import { once } from 'node:events';
import { createServer } from 'node:http';
import type { Server } from 'node:http';

import { afterAll, describe, expect, it } from 'vitest';

import { OpenTelemetrySessionService } from './index.js';

let server: Server;
let url = '';
let received: string[] = [];

afterAll(() => {
  server.close();
  server.closeAllConnections();
});

async function start(): Promise<void> {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => void chunks.push(chunk));
    request.on('end', () => {
      received.push(Buffer.concat(chunks).toString());
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('沒有拿到 port');
  url = `http://127.0.0.1:${address.port}/v1/logs`;
}

type Shape = 'object' | 'array' | 'mixed';

/** `levels` 層容器包著 `'leaf'`。 */
function nested(levels: number, shape: Shape): unknown {
  let value: unknown = 'leaf';
  for (let level = 0; level < levels; level++) {
    const asObject = shape === 'object' || (shape === 'mixed' && level % 2 === 1);
    value = asObject ? { next: value } : [value];
  }
  return value;
}

/** 這個層數送不送得到 collector。 */
async function delivers(levels: number, shape: Shape): Promise<boolean> {
  received = [];
  const service = new OpenTelemetrySessionService({
    mode: 'feedback-only',
    exporter: { url },
    shutdownTimeoutMillis: 10_000,
  });
  service.emit({
    channel: 'ledger',
    time: 1,
    severity: 'info',
    attributes: { 'event.type': 'tool/result', 'event.seq': 0 },
    body: nested(levels, shape) as never,
  });
  try {
    await service.shutdown();
  } catch {
    // 關機期限到了也算沒送到。
  }
  return received.some((body) => body.includes('"leaf"'));
}

async function threshold(shape: Shape): Promise<number> {
  let low = 1; // 送得到
  let high = 20_000; // 送不到
  if (!(await delivers(low, shape))) throw new Error(`${shape}：1 層就送不到，探針壞了`);
  if (await delivers(high, shape)) return high;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (await delivers(middle, shape)) low = middle;
    else high = middle;
  }
  return high;
}

describe('探針（#1661）', () => {
  it('OTLP/HTTP JSON 的層數門檻（第一個送不到的層數）', async () => {
    await start();
    const results: string[] = [];
    for (const shape of ['object', 'array', 'mixed'] as const) {
      results.push(`${shape}=${await threshold(shape)}`);
    }
    const report = `PROBE node=${process.version} ${process.platform}-${process.arch} otlp ${results.join(' ')}`;
    expect.fail(report);
  }, 600_000);
});
