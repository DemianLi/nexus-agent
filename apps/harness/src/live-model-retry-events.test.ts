/**
 * 模型請求的重試記進會話日誌（[#712](https://github.com/DemianLi/nexus-agent/issues/712)）。
 *
 * 沿用 #516 的 loopback 假端點（零憑證、零外部連線），把真的 `createLiveModel` 放進
 * `@nexus/core` 的重試範圍裡跑，再讀範圍所屬的那一份日誌：判準是**日誌裡有幾顆、帶什麼**，
 * 同時數假端點收到幾個請求，兩個數字要對得上。
 *
 * **`RETRIES = 2` 的理由同 `live-model.test.ts`**：要真的等完退避才數得到重試，6 次是 63 秒。
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInRetryScope, SessionLog } from '@nexus/core';
import {
  classifyLlmFailure,
  createLiveModel,
  LIVE_API_KEY_ENV,
  StreamIdleTimeoutError,
} from './live-model.js';
import { liveModelConfigSchema } from './settings/live-model.js';

const RETRIES = 2;

type Cell = 'http500' | 'head503' | 'head400';

let server: Server;
let baseUrl: string;
let hits = 0;
let cell: Cell = 'http500';
let savedKey: string | undefined;

beforeEach(async () => {
  hits = 0;
  savedKey = process.env[LIVE_API_KEY_ENV];
  process.env[LIVE_API_KEY_ENV] = 'fake-key-for-loopback';
  server = createServer((request, response) => {
    hits += 1;
    request.resume();
    if (cell === 'http500') {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Internal server error', code: 500 } }));
      return;
    }
    // 串流內回報的錯誤（#516）：`200` 開線、第一則事件是錯誤信封。
    const code = cell === 'head503' ? 503 : 400;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(
      `data: ${JSON.stringify({ error: { message: 'in-band failure', type: 'x', code } })}\n\n`,
    );
    response.end('data: [DONE]\n\n');
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

const config = (maxRetries = RETRIES) => liveModelConfigSchema.parse({ baseUrl, maxRetries });

/** 把一次串流呼叫跑完（吞掉最後的拋錯），回日誌上的事件。 */
async function streamInScope(
  log: SessionLog,
  model = createLiveModel(config()),
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  await runInRetryScope(log, async () => {
    for await (const _part of await model.stream('嗨', options)) void _part;
  }).catch(() => undefined);
}

const retries = (log: SessionLog) => log.events.filter((event) => event.type === 'llm/retry');
const starts = (log: SessionLog) =>
  log.events.filter((event) => event.type === 'llm/retry-started');

describe('重試寫進日誌', () => {
  it('HTTP 500：llm/retry 與 llm/retry-started 的顆數都等於重試次數（請求數減 1），failure 帶狀態與碼', async () => {
    cell = 'http500';
    const log = new SessionLog('r');
    await streamInScope(log);

    expect(hits).toBe(RETRIES + 1);
    expect(retries(log)).toHaveLength(RETRIES);
    expect(starts(log)).toHaveLength(RETRIES);
    for (const event of retries(log)) {
      expect(event.data).toMatchObject({
        maxRetries: RETRIES,
        failure: { code: 'SERVER', status: 500 },
      });
    }
    // 順序：排定、等完重打、再排定、再重打；預算用盡的那一次沒有第三顆。
    expect(log.events.map((event) => event.type)).toEqual([
      'llm/retry',
      'llm/retry-started',
      'llm/retry',
      'llm/retry-started',
    ]);
  }, 30_000);

  it('第一則事件是 503：同上（#516 的串流內錯誤也進得了日誌）', async () => {
    cell = 'head503';
    const log = new SessionLog('r');
    await streamInScope(log);

    expect(hits).toBe(RETRIES + 1);
    expect(retries(log)).toHaveLength(RETRIES);
    expect(starts(log)).toHaveLength(RETRIES);
    expect(retries(log)[0]!.data).toMatchObject({ failure: { code: 'SERVER', status: 503 } });
  }, 30_000);

  it('第一則事件是 400：只打一次，0 顆', async () => {
    cell = 'head400';
    const log = new SessionLog('r');
    await streamInScope(log);

    expect(hits).toBe(1);
    expect(log.events).toHaveLength(0);
  });

  it('maxRetries 為 0：一次失敗就收，0 顆', async () => {
    cell = 'http500';
    const log = new SessionLog('r');
    await streamInScope(log, createLiveModel(config(0)));

    expect(hits).toBe(1);
    expect(log.events).toHaveLength(0);
  });

  it('等待重試時取消：已寫的 llm/retry 留著，背景迴圈再打也不會多出 llm/retry-started', async () => {
    cell = 'http500';
    const log = new SessionLog('r');
    const controller = new AbortController();
    log.subscribe((event) => {
      if (event.type === 'llm/retry') controller.abort();
    });
    await streamInScope(log, createLiveModel(config()), { signal: controller.signal });

    expect(retries(log)).toHaveLength(1);
    const settled = log.events.length;
    // 等過原本的退避（第一次 1–2 秒）：這條路徑上 signal 也交給了 fetch，所以背景迴圈醒來的那次請求
    // 到不了假端點；背景迴圈照樣醒來、卻到得了 `fetch` 的那種情形由 core 的 `llm-retry.test.ts`
    // （範圍關了之後的回報）釘住。這裡釘的是產品路徑上整條走完的結果。
    await new Promise<void>((done) => setTimeout(done, 3_500));
    expect(starts(log)).toHaveLength(0);
    expect(log.events).toHaveLength(settled);
  }, 30_000);

  it('標題那一顆：碰到可重試的失敗也一顆都不寫，即使繼承了對話那一輪的範圍', async () => {
    cell = 'http500';
    const log = new SessionLog('r');
    const title = createLiveModel(config(), 'session-title');
    await runInRetryScope(log, () => title.invoke('嗨')).catch(() => undefined);

    expect(hits).toBe(RETRIES + 1);
    expect(log.events).toHaveLength(0);
  }, 30_000);

  it('兩次呼叫並行共用同一顆模型：各寫各的日誌，retryId 不同', async () => {
    cell = 'http500';
    const model = createLiveModel(config());
    const a = new SessionLog('a');
    const b = new SessionLog('b');
    await Promise.all([streamInScope(a, model), streamInScope(b, model)]);

    expect(retries(a)).toHaveLength(RETRIES);
    expect(retries(b)).toHaveLength(RETRIES);
    const idOf = (log: SessionLog) => (retries(log)[0]!.data as { retryId: string }).retryId;
    expect(idOf(a)).not.toBe(idOf(b));
  }, 30_000);
});

describe('classifyLlmFailure：只認碼與名字，不解析訊息', () => {
  it('429 → RATE_LIMIT；其他 HTTP 狀態 → SERVER，狀態碼帶著', () => {
    expect(classifyLlmFailure(Object.assign(new Error('x'), { status: 429 }))).toEqual({
      message: 'x',
      code: 'RATE_LIMIT',
      status: 429,
    });
    expect(classifyLlmFailure(Object.assign(new Error('y'), { status: 502 }))).toMatchObject({
      code: 'SERVER',
      status: 502,
    });
  });

  it('包在 cause 裡的狀態碼也認得', () => {
    const wrapped = new Error('Connection error.', {
      cause: Object.assign(new Error('z'), { status: 503 }),
    });
    expect(classifyLlmFailure(wrapped)).toMatchObject({ code: 'SERVER', status: 503 });
  });

  it('逾時 → TIMEOUT；沒有狀態碼也不是逾時的 → TRANSPORT，且不帶 status', () => {
    expect(classifyLlmFailure(new StreamIdleTimeoutError(100)).code).toBe('TIMEOUT');
    const transport = classifyLlmFailure(new Error('socket hang up'));
    expect(transport.code).toBe('TRANSPORT');
    expect('status' in transport).toBe(false);
  });
});
