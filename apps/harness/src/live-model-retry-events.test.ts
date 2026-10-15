/**
 * 模型請求的重試記進會話日誌（[#712](https://github.com/DemianLi/nexus-agent/issues/712)）。
 *
 * 沿用 #516 的 loopback 假端點（零憑證、零外部連線），把真的 `createLiveModel` 放進 `@nexus/core` 的
 * `retryModelCall`（#1427：整個專案唯一的重試迴圈，SDK 層不重試）裡跑，再讀它寫的那一份日誌：判準是**日誌裡
 * 有幾顆、帶什麼**，同時數假端點收到幾個請求，兩個數字要對得上。
 *
 * **退避縮成幾十毫秒**（`jitterRatio: 0`）：要真的等完退避才數得到重試，出廠值 6 次是 25 秒。
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createModelCallRecorder, retryModelCall, SessionLog } from '@nexus/core';
import {
  classifyTurnFailure,
  createLiveModel,
  LIVE_API_KEY_ENV,
  StreamIdleTimeoutError,
} from './live-model.js';
import { liveModelConfigSchema, streamRetryOptionsOf } from './settings/live-model.js';

const RETRIES = 2;

type Cell = 'http500' | 'head503' | 'head400' | 'http429' | 'http400';

let server: Server;
let baseUrl: string;
let hits = 0;
let cell: Cell = 'http500';
/** `http429` 那一格要不要帶 `retry-after`（秒，字串）；`undefined` 就是沒有 header 的 429。 */
let retryAfter: string | undefined;
let savedKey: string | undefined;

beforeEach(async () => {
  hits = 0;
  retryAfter = undefined;
  savedKey = process.env[LIVE_API_KEY_ENV];
  process.env[LIVE_API_KEY_ENV] = 'fake-key-for-loopback';
  server = createServer((request, response) => {
    hits += 1;
    request.resume();
    if (cell === 'http429' || cell === 'http400') {
      response.writeHead(cell === 'http429' ? 429 : 400, {
        'content-type': 'application/json',
        ...(cell === 'http429' && retryAfter !== undefined && { 'retry-after': retryAfter }),
      });
      response.end(JSON.stringify({ error: { message: 'plain http failure', type: 'x' } }));
      return;
    }
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

const policy = (
  maxRetries = RETRIES,
  initialDelayMs = 20,
  maxDelayMs = 200,
  retryableCodes?: string[],
) =>
  streamRetryOptionsOf(
    liveModelConfigSchema.parse({
      baseUrl,
      retryPolicy: {
        mode: 'normal',
        maxRetries,
        ...(retryableCodes !== undefined && { retryableCodes }),
        backoff: { initialDelayMs, maxDelayMs, jitterRatio: 0 },
      },
    }).retryPolicy,
  );

const config = () => liveModelConfigSchema.parse({ baseUrl });

/** 把一次串流呼叫放進重試迴圈跑完（吞掉最後的拋錯），事件寫進 `log`。 */
async function streamWithRetry(
  log: SessionLog | undefined,
  model = createLiveModel(config()),
  options: {
    signal?: AbortSignal;
    maxRetries?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    retryableCodes?: string[];
  } = {},
): Promise<void> {
  const { signal, maxRetries, initialDelayMs, maxDelayMs, retryableCodes } = options;
  await retryModelCall(
    policy(maxRetries, initialDelayMs, maxDelayMs, retryableCodes),
    { ...(log !== undefined && { log }), ...(signal !== undefined && { signal }) },
    async () => {
      for await (const _part of await model.stream('嗨', signal === undefined ? {} : { signal })) {
        void _part;
      }
    },
  ).catch(() => undefined);
}

const retries = (log: SessionLog) => log.events.filter((event) => event.type === 'llm/retry');
const starts = (log: SessionLog) =>
  log.events.filter((event) => event.type === 'llm/retry-started');

describe('重試寫進日誌', () => {
  it('HTTP 500：llm/retry 與 llm/retry-started 的顆數都等於重試次數（請求數減 1），failure 帶狀態與碼', async () => {
    cell = 'http500';
    const log = new SessionLog('r');
    await streamWithRetry(log);

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

  /** #1021：經真的起訖紀錄器，每次嘗試各自一組 `model/start`／`model/end`，重試指回失敗的那一次（#1427：重試在紀錄器外面）。 */
  it('經起訖紀錄器跑：每次嘗試各一組起訖，llm/retry 與 llm/retry-started 指回失敗那次的 model/start', async () => {
    cell = 'http500';
    const log = new SessionLog('r');
    const model = createLiveModel(config());
    const recorder = createModelCallRecorder({
      forCall: () => ({ kind: 'ok', address: { kind: 'root' }, log }),
    }) as unknown as {
      wrapModelCall: (request: unknown, handler: () => Promise<unknown>) => Promise<unknown>;
    };
    await retryModelCall(policy(), { log }, () =>
      recorder.wrapModelCall({ runtime: { configurable: {} } }, async () => {
        for await (const _part of await model.stream('嗨')) void _part;
      }),
    ).catch(() => undefined);

    const modelStarts = log.events.filter((event) => event.type === 'model/start');
    const modelEnds = log.events.filter((event) => event.type === 'model/end');
    expect(modelStarts).toHaveLength(RETRIES + 1);
    expect(modelEnds).toHaveLength(RETRIES + 1);
    expect(retries(log)).toHaveLength(RETRIES);
    retries(log).forEach((event, index) => {
      expect((event.data as { modelCall?: number }).modelCall).toBe(modelStarts[index]!.seq);
    });
    starts(log).forEach((event, index) => {
      expect((event.data as { modelCall?: number }).modelCall).toBe(modelStarts[index]!.seq);
    });
    // 每一次失敗都是拋錯收的：`model/end` 標 `error`（#1022）。
    for (const [index, end] of modelEnds.entries()) {
      expect(end.data).toEqual({ modelCall: modelStarts[index]!.seq, outcome: 'error' });
    }
  }, 30_000);

  it('第一則事件是 503：同上（#516 的串流內錯誤也進得了日誌）', async () => {
    cell = 'head503';
    const log = new SessionLog('r');
    await streamWithRetry(log);

    expect(hits).toBe(RETRIES + 1);
    expect(retries(log)).toHaveLength(RETRIES);
    expect(starts(log)).toHaveLength(RETRIES);
    expect(retries(log)[0]!.data).toMatchObject({ failure: { code: 'SERVER', status: 503 } });
  }, 30_000);

  it('第一則事件是 400：只打一次，0 顆', async () => {
    cell = 'head400';
    const log = new SessionLog('r');
    await streamWithRetry(log);

    expect(hits).toBe(1);
    expect(log.events).toHaveLength(0);
  });

  it('maxRetries 為 0：一次失敗就收，0 顆', async () => {
    cell = 'http500';
    const log = new SessionLog('r');
    await streamWithRetry(log, createLiveModel(config()), { maxRetries: 0 });

    expect(hits).toBe(1);
    expect(log.events).toHaveLength(0);
  });

  it('等待重試時取消：已寫的 llm/retry 留著，不再打、不寫 llm/retry-started', async () => {
    cell = 'http500';
    const log = new SessionLog('r');
    const controller = new AbortController();
    log.subscribe((event) => {
      if (event.type === 'llm/retry') controller.abort();
    });
    await streamWithRetry(log, createLiveModel(config()), {
      signal: controller.signal,
      initialDelayMs: 150,
    });

    expect(hits).toBe(1);
    expect(retries(log)).toHaveLength(1);
    const settled = log.events.length;
    // 等過原本的退避：停了就是停了，背景不會再醒來多打一次。
    await new Promise<void>((done) => setTimeout(done, 400));
    expect(hits).toBe(1);
    expect(starts(log)).toHaveLength(0);
    expect(log.events).toHaveLength(settled);
  }, 30_000);

  /** #1427 D：沒帶 header 的 429 照樣重試（基座的預設 handler 會把它當「容量不足」直接放棄）。 */
  it('沒有 retry-after header 的 429：照樣重試，failure 是 RATE_LIMIT', async () => {
    cell = 'http429';
    const log = new SessionLog('r');
    await streamWithRetry(log);

    expect(hits).toBe(RETRIES + 1);
    expect(retries(log)).toHaveLength(RETRIES);
    expect(retries(log)[0]!.data).toMatchObject({
      failure: { code: 'RATE_LIMIT', status: 429 },
    });
  }, 30_000);

  it('retry-after 不超過 maxDelayMs：照它等（不加抖動、不用本機的退避）', async () => {
    cell = 'http429';
    retryAfter = '1';
    const log = new SessionLog('r');
    await streamWithRetry(log, createLiveModel(config()), {
      maxRetries: 1,
      initialDelayMs: 20,
      maxDelayMs: 5_000,
    });

    expect(hits).toBe(2);
    expect(retries(log)).toHaveLength(1);
    expect(retries(log)[0]!.data).toMatchObject({ delayMs: 1_000 });
    expect((starts(log)[0]!.data as { waitedMs: number }).waitedMs).toBeGreaterThanOrEqual(950);
  }, 30_000);

  it('retry-after 超過 maxDelayMs：不等、不重打，原錯誤往外拋', async () => {
    cell = 'http429';
    retryAfter = '30';
    const log = new SessionLog('r');
    const model = createLiveModel(config());
    const thrown = await retryModelCall(policy(), { log }, async () => {
      for await (const _part of await model.stream('嗨')) void _part;
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(hits).toBe(1);
    expect(thrown).toBeInstanceOf(Error);
    expect(log.events).toHaveLength(0);
  });

  /** #1427：`retryableCodes` 真的是閘門——分類出來的碼不在清單裡就不重打，原錯誤往外拋（dsh 的 `retryableCodes`）。 */
  it('retryableCodes 是閘門：碼不在清單裡的失敗只打一次，在清單裡的照常重打', async () => {
    cell = 'http429';
    const limited = new SessionLog('r');
    await streamWithRetry(limited, createLiveModel(config()), { retryableCodes: ['SERVER'] });
    expect(hits).toBe(1);
    expect(limited.events).toHaveLength(0);

    hits = 0;
    const listed = new SessionLog('r');
    await streamWithRetry(listed, createLiveModel(config()), { retryableCodes: ['RATE_LIMIT'] });
    expect(hits).toBe(RETRIES + 1);
    expect(retries(listed)).toHaveLength(RETRIES);

    hits = 0;
    cell = 'http500';
    const server500 = new SessionLog('r');
    await streamWithRetry(server500, createLiveModel(config()), { retryableCodes: ['RATE_LIMIT'] });
    expect(hits).toBe(1);
  }, 30_000);

  it('HTTP 400：不重試（請求本身有問題）', async () => {
    cell = 'http400';
    const log = new SessionLog('r');
    await streamWithRetry(log);

    expect(hits).toBe(1);
    expect(log.events).toHaveLength(0);
  });

  it('不給日誌（標題、摘要器那種呼叫）：照樣吃同一份預算重打，但一顆都不寫', async () => {
    cell = 'http500';
    const log = new SessionLog('untouched');
    const title = createLiveModel(config(), 'session-title');
    await retryModelCall(policy(), {}, () => title.invoke('嗨')).catch(() => undefined);

    expect(hits).toBe(RETRIES + 1);
    expect(log.events).toHaveLength(0);
  }, 30_000);

  it('兩次呼叫並行共用同一顆模型：各寫各的日誌，retryId 不同', async () => {
    cell = 'http500';
    const model = createLiveModel(config());
    const a = new SessionLog('a');
    const b = new SessionLog('b');
    await Promise.all([streamWithRetry(a, model), streamWithRetry(b, model)]);

    expect(retries(a)).toHaveLength(RETRIES);
    expect(retries(b)).toHaveLength(RETRIES);
    const idOf = (log: SessionLog) => (retries(log)[0]!.data as { retryId: string }).retryId;
    expect(idOf(a)).not.toBe(idOf(b));
  }, 30_000);
});

describe('classifyTurnFailure（也是 llm/retry 用的那一支）：只認碼與名字，不解析訊息', () => {
  it('429 → RATE_LIMIT；5xx → SERVER，狀態碼帶著', () => {
    expect(classifyTurnFailure(Object.assign(new Error('x'), { status: 429 }))).toEqual({
      message: 'x',
      code: 'RATE_LIMIT',
      status: 429,
    });
    expect(classifyTurnFailure(Object.assign(new Error('y'), { status: 502 }))).toMatchObject({
      code: 'SERVER',
      status: 502,
    });
  });

  it('包在 cause 裡的狀態碼也認得', () => {
    const wrapped = new Error('Connection error.', {
      cause: Object.assign(new Error('z'), { status: 503 }),
    });
    expect(classifyTurnFailure(wrapped)).toMatchObject({ code: 'SERVER', status: 503 });
  });

  it('逾時 → TIMEOUT；沒有任何供應商痕跡的錯誤 → UNKNOWN，且不帶 status（#1437：不再一律當 TRANSPORT）', () => {
    expect(classifyTurnFailure(new StreamIdleTimeoutError(100)).code).toBe('TIMEOUT');
    const unknown = classifyTurnFailure(new Error('socket hang up'));
    expect(unknown.code).toBe('UNKNOWN');
    expect('status' in unknown).toBe(false);
  });
});
