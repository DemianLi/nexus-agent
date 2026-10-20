/**
 * 供應商的請求編號記進失敗紀錄（[#1536](https://github.com/DemianLi/nexus-agent/issues/1536)）。
 *
 * 沿用 `live-model-retry-events.test.ts` 的 loopback 假端點（零憑證、零外部連線），把真的 `createLiveModel` 放進 `retryModelCall` 跑，
 * 再讀 `llm/retry.failure` 與最後一顆錯誤餵 `classifyTurnFailure`（`turn/failed.error` 就是它的輸出）。
 *
 * **兩條路各有自己的測試**：非 in-band（HTTP 502，標頭在 SDK 錯誤上）與 in-band（`200` 開線、第一則事件是錯誤信封，標頭由
 * `withInbandStreamErrors` 搬到合成的 Response）。拿掉其中一條的接線，只有那一條紅。
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { retryModelCall, SessionLog } from '@nexus/core';
import {
  classifyTurnFailure,
  createLiveModel,
  LIVE_API_KEY_ENV,
  PROVIDER_REQUEST_ID_HEADERS,
  requestIdOfHeaders,
} from './live-model.js';
import { liveModelConfigSchema, streamRetryOptionsOf } from './settings/live-model.js';

const RETRIES = 2;

type Cell = 'http502' | 'inband503' | 'inbandMid' | 'midstream';

let server: Server;
let baseUrl: string;
let hits = 0;
let cell: Cell = 'http502';
/** 假端點回應要帶的標頭（名字小寫）。 */
let headers: Record<string, string> = {};
let savedKey: string | undefined;

beforeEach(async () => {
  hits = 0;
  headers = {};
  savedKey = process.env[LIVE_API_KEY_ENV];
  process.env[LIVE_API_KEY_ENV] = 'fake-key-for-loopback';
  server = createServer((request, response) => {
    hits += 1;
    request.resume();
    if (cell === 'http502') {
      response.writeHead(502, { 'content-type': 'application/json', ...headers });
      response.end(JSON.stringify({ error: { message: 'Bad gateway', code: 502 } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', ...headers });
    if (cell === 'inband503') {
      response.write(
        `data: ${JSON.stringify({ error: { message: 'in-band failure', type: 'x', code: 503 } })}\n\n`,
      );
      response.end('data: [DONE]\n\n');
      return;
    }
    if (cell === 'inbandMid') {
      // 先送一則內容，**再**送錯誤信封：第一則事件不是錯誤，`withInbandStreamErrors` 的「首事件」那條路不管它，
      // 錯誤是 SDK 在串流中段讀到、自己拋的（`openai` 的 `core/streaming`，丟的 `APIError` 帶著回應標頭）。
      response.write(
        `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({ error: { message: 'mid in-band failure', type: 'x', code: 503 } })}\n\n`,
      );
      response.end('data: [DONE]\n\n');
      return;
    }
    // 串流吐了一則內容就被切斷：回應標頭早就送出去了，請求編號在手上。
    response.write(
      `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] })}\n\n`,
    );
    setTimeout(() => response.destroy(), 20);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('拿不到 loopback 埠');
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

afterEach(async () => {
  if (savedKey === undefined) delete process.env[LIVE_API_KEY_ENV];
  else process.env[LIVE_API_KEY_ENV] = savedKey;
  await new Promise<void>((done) => server.close(() => done()));
});

const policy = () =>
  streamRetryOptionsOf(
    liveModelConfigSchema.parse({
      baseUrl,
      retryPolicy: {
        mode: 'normal',
        maxRetries: RETRIES,
        backoff: { initialDelayMs: 20, maxDelayMs: 200, jitterRatio: 0 },
      },
    }).retryPolicy,
  );

/** 跑完整個重試迴圈，回日誌與最後拋出的錯誤。 */
async function run(): Promise<{ log: SessionLog; error: unknown }> {
  const log = new SessionLog('r');
  const model = createLiveModel(liveModelConfigSchema.parse({ baseUrl }));
  let error: unknown;
  await retryModelCall(policy(), { log }, async () => {
    for await (const _part of await model.stream('嗨')) void _part;
  }).catch((caught: unknown) => {
    error = caught;
  });
  return { log, error };
}

const retryFailures = (log: SessionLog) =>
  log.events
    .filter((event) => event.type === 'llm/retry')
    .map((event) => (event.data as unknown as { failure: Record<string, unknown> }).failure);

describe('供應商請求編號進 llm/retry 與 turn/failed', () => {
  it('非 in-band（HTTP 502）：llm/retry 的每一顆與最後的失敗分類都帶 gw-123，碼與狀態照舊', async () => {
    cell = 'http502';
    headers = { 'x-request-id': 'gw-123' };
    const { log, error } = await run();

    expect(hits).toBe(RETRIES + 1);
    const failures = retryFailures(log);
    expect(failures).toHaveLength(RETRIES);
    for (const failure of failures) {
      expect(failure).toMatchObject({ code: 'SERVER', status: 502, requestId: 'gw-123' });
    }
    // `turn/failed.error` 就是這支的輸出：同一個編號，碼與狀態沒被這張卡改動。
    expect(classifyTurnFailure(error)).toMatchObject({
      code: 'SERVER',
      status: 502,
      requestId: 'gw-123',
    });
  }, 30_000);

  it('in-band（200 開線、第一則事件是錯誤信封）：同樣帶得到', async () => {
    cell = 'inband503';
    headers = { 'x-request-id': 'gw-inband' };
    const { log, error } = await run();

    expect(hits).toBe(RETRIES + 1);
    for (const failure of retryFailures(log)) {
      expect(failure).toMatchObject({ code: 'SERVER', status: 503, requestId: 'gw-inband' });
    }
    expect(classifyTurnFailure(error)).toMatchObject({
      code: 'SERVER',
      status: 503,
      requestId: 'gw-inband',
    });
  }, 30_000);

  it('串流中段才送錯誤信封（200 開線、先有內容、再來 in-band 錯誤）：llm/retry 與最後的失敗分類都帶得到', async () => {
    cell = 'inbandMid';
    headers = { 'x-request-id': 'gw-midin' };
    const { log, error } = await run();

    expect(hits).toBe(RETRIES + 1);
    const failures = retryFailures(log);
    expect(failures).toHaveLength(RETRIES);
    for (const failure of failures) expect(failure.requestId).toBe('gw-midin');
    // 碼是另一件事（中段 in-band 的 `turn/failed` 目前記 UNKNOWN、`llm/retry` 記 SERVER，#1763）；這一格只管請求編號。
    expect(classifyTurnFailure(error).requestId).toBe('gw-midin');
  }, 30_000);

  it('串流中段才斷：llm/retry 與最後的失敗分類都帶得到回應標頭裡的編號', async () => {
    cell = 'midstream';
    headers = { 'x-request-id': 'gw-mid' };
    const { log, error } = await run();

    expect(hits).toBe(RETRIES + 1);
    const failures = retryFailures(log);
    expect(failures).toHaveLength(RETRIES);
    for (const failure of failures) {
      expect(failure).toMatchObject({ code: 'TRANSPORT', requestId: 'gw-mid' });
    }
    expect(classifyTurnFailure(error)).toMatchObject({ code: 'TRANSPORT', requestId: 'gw-mid' });
  }, 30_000);

  it('沒有任何請求編號標頭：失敗紀錄沒有 requestId 這一格（不是 undefined、不是空字串）', async () => {
    cell = 'http502';
    const { log, error } = await run();

    for (const failure of retryFailures(log)) expect('requestId' in failure).toBe(false);
    expect('requestId' in classifyTurnFailure(error)).toBe(false);
  }, 30_000);

  it('request-id 與 x-request-id 同時出現時取 request-id（dsh 的順序）', async () => {
    cell = 'http502';
    headers = { 'x-request-id': 'b', 'request-id': 'a' };
    const { log } = await run();

    for (const failure of retryFailures(log)) expect(failure.requestId).toBe('a');
  }, 30_000);

  it('x-deepseek-request-id 也認；空字串的 request-id 整格不帶，也不往下一個標頭退', async () => {
    cell = 'http502';
    headers = { 'x-deepseek-request-id': 'ds-1' };
    const viaDeepseek = await run();
    for (const failure of retryFailures(viaDeepseek.log)) expect(failure.requestId).toBe('ds-1');

    headers = { 'request-id': '', 'x-request-id': 'should-not-be-used' };
    const empty = await run();
    for (const failure of retryFailures(empty.log)) expect('requestId' in failure).toBe(false);
    expect('requestId' in classifyTurnFailure(empty.error)).toBe(false);
  }, 30_000);
});

describe('requestIdOfHeaders', () => {
  it('Headers 與純物件兩種形狀都認；名單的順序就是優先順序', () => {
    expect(PROVIDER_REQUEST_ID_HEADERS).toEqual([
      'request-id',
      'x-request-id',
      'x-deepseek-request-id',
    ]);
    expect(requestIdOfHeaders(new Headers({ 'x-request-id': 'h' }))).toBe('h');
    expect(requestIdOfHeaders({ 'x-request-id': 'p' })).toBe('p');
    expect(requestIdOfHeaders({ 'request-id': 'first', 'x-request-id': 'second' })).toBe('first');
  });

  it('不是標頭物件、沒有、空字串、非字串：一律沒有', () => {
    expect(requestIdOfHeaders(undefined)).toBeUndefined();
    expect(requestIdOfHeaders(null)).toBeUndefined();
    expect(requestIdOfHeaders('x')).toBeUndefined();
    expect(requestIdOfHeaders({})).toBeUndefined();
    expect(requestIdOfHeaders({ 'request-id': '' })).toBeUndefined();
    expect(requestIdOfHeaders({ 'request-id': 42 })).toBeUndefined();
  });
});
