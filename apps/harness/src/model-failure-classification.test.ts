/**
 * 模型失敗的分類與「碼決定重試」（[#1437](https://github.com/DemianLi/nexus-agent/issues/1437)，S2 地圖 #1339）。
 *
 * 判準是**真的生產者**：真的 `createLiveModel`（真的 `@langchain/openai`、`withInbandStreamErrors`、
 * `withStreamIdleTimeout`、`onFailedAttempt`）放進 `@nexus/core` 的 `retryModelCall`，對 loopback 上的假端點跑，再同時讀
 * 三樣東西：假端點收到幾個請求、日誌上 `llm/retry.failure` 的碼與狀態、拋出來的最後那顆錯誤經 `classifyTurnFailure` 之後
 * 的碼（`turn/failed.error`）。**手刻一顆錯誤物件看不出「投遞方式不同、錯誤長得不同」**——#1437 之前的毛病就在這裡：
 * 串流中段的內帶錯誤與斷流，`llm/retry` 記 `SERVER`／`TRANSPORT`，`turn/failed` 卻記 `UNKNOWN`。
 *
 * 一列一個投遞方式或一個狀態碼：
 *
 * - **B 分類表**：每一列的碼。
 * - **C 同一顆錯同一個碼**：重打過的列，`llm/retry` 的碼等於 `turn/failed` 的碼；沒重打的列，只有 `turn/failed` 那一個。
 * - **D 碼決定重試**：假端點收到的請求數（可重試的碼 `RETRIES + 1`，其餘 1）。
 *
 * 端點的真實信封（逐字，來自 2026-10-15 對 `nvidia/nemotron-3-super-120b-a12b` 的 M2 實測，#1437 的卡上）：
 * 超大 body 回 `400`＋`maximum context length`（沒有 413）、不存在的模型回 `404` 純文字。
 *
 * **零憑證、零外部連線**：loopback 上的假端點，key 是假的。
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MiddlewareError } from 'langchain';
import {
  createTurnCancelModelSignal,
  markModelCallFailure,
  retryModelCall,
  SessionLog,
} from '@nexus/core';
import {
  classifyFailedAttempt,
  classifyTurnFailure,
  createLiveModel,
  LIVE_API_KEY_ENV,
  withStreamIdleTimeout,
} from './live-model.js';
import { liveModelConfigSchema, streamRetryOptionsOf } from './settings/live-model.js';

/** 重打兩次：可重試的列請求數是 3，不可重試的是 1。 */
const RETRIES = 2;

/** 假端點這一次要怎麼回。 */
type Cell =
  | { readonly kind: 'http'; readonly status: number; readonly body: unknown; readonly raw?: true }
  | { readonly kind: 'inband-first'; readonly envelope: Record<string, unknown> }
  | { readonly kind: 'inband-mid'; readonly envelope: Record<string, unknown> }
  | { readonly kind: 'reset-mid' }
  | { readonly kind: 'json-reset-mid' }
  | { readonly kind: 'garbage' }
  | { readonly kind: 'bad-json' }
  | { readonly kind: 'silent' };

let server: Server;
let baseUrl: string;
let hits = 0;
let cell: Cell = { kind: 'http', status: 500, body: {} };
let savedKey: string | undefined;

/** 一個 SSE 事件。 */
const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
/** 一段正文的 chunk。 */
const textChunk = (content: string, finish: string | null = null): unknown => ({
  id: 'chatcmpl-1437',
  object: 'chat.completion.chunk',
  created: 1_790_000_000,
  model: 'fake',
  choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: finish }],
});

function respond(request: IncomingMessage, response: ServerResponse): void {
  hits += 1;
  request.resume();
  const current = cell;
  switch (current.kind) {
    case 'http': {
      response.writeHead(current.status, {
        'content-type': current.raw === true ? 'text/plain' : 'application/json',
      });
      response.end(current.raw === true ? String(current.body) : JSON.stringify(current.body));
      return;
    }
    case 'inband-first': {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(frame({ error: current.envelope }));
      response.end('data: [DONE]\n\n');
      return;
    }
    case 'inband-mid': {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(frame(textChunk('寫到一半')));
      // 內容已經往下送了，錯誤信封才到——SDK 這時拋的 `APIError` 沒有 `status`。
      setTimeout(() => {
        response.write(frame({ error: current.envelope }));
        response.end('data: [DONE]\n\n');
      }, 20);
      return;
    }
    case 'reset-mid': {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(frame(textChunk('寫到一半')));
      // 把連線砍掉：undici 讀端拋 `TypeError: terminated`。
      setTimeout(() => response.socket?.destroy(), 20);
      return;
    }
    case 'json-reset-mid': {
      // 非串流：200＋JSON，body 寫了半段就把連線砍掉（CLI 一輪、標題、摘要器、eval 走的是這一條）。
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': '4096' });
      response.write('{"id":"chatcmpl-1437","object":"chat.completion","choices":[');
      setTimeout(() => response.socket?.destroy(), 20);
      return;
    }
    case 'bad-json': {
      // 非串流：200，body 是壞掉的 JSON（SDK 解析失敗，發生在 AsyncCaller 的呼叫裡面）。
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"id":"chatcmpl-1437","choices":[{這不是 JSON');
      return;
    }
    case 'garbage': {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(frame(textChunk('開頭正常')));
      setTimeout(() => {
        response.write('data: {這不是 JSON\n\n');
        response.end('data: [DONE]\n\n');
      }, 20);
      return;
    }
    case 'silent': {
      // 什麼都不回：到第一則事件的逾時。
      return;
    }
  }
}

beforeEach(async () => {
  hits = 0;
  savedKey = process.env[LIVE_API_KEY_ENV];
  process.env[LIVE_API_KEY_ENV] = 'fake-key-for-loopback';
  server = createServer(respond);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1`;
});

afterEach(async () => {
  if (savedKey === undefined) delete process.env[LIVE_API_KEY_ENV];
  else process.env[LIVE_API_KEY_ENV] = savedKey;
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
});

/** 把一次串流呼叫放進重試迴圈跑完，回日誌與最後那顆錯誤。 */
async function run(
  options: {
    readonly timeoutMs?: number;
    readonly url?: string;
    /** 預設串流；`invoke` 走非串流（`stream: false`）那條。 */
    readonly mode?: 'stream' | 'invoke';
  } = {},
): Promise<{ readonly log: SessionLog; readonly error: unknown }> {
  const url = options.url ?? baseUrl;
  const config = liveModelConfigSchema.parse({
    baseUrl: url,
    ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
    retryPolicy: {
      mode: 'normal',
      maxRetries: RETRIES,
      backoff: { initialDelayMs: 5, maxDelayMs: 20, jitterRatio: 0 },
    },
  });
  const log = new SessionLog('classification');
  const model = createLiveModel(config);
  let error: unknown;
  // 真的圖裡，每一次模型呼叫都經過最內層那一格 `wrapModelCall`（它記下「這顆錯是模型呼叫拋的」，#1778）；這裡照樣包一層。
  const guard = createTurnCancelModelSignal() as unknown as {
    wrapModelCall: (request: unknown, handler: () => Promise<unknown>) => Promise<unknown>;
  };
  await retryModelCall(streamRetryOptionsOf(config.retryPolicy), { log }, () =>
    guard.wrapModelCall({}, async () => {
      if (options.mode === 'invoke') {
        await model.invoke('嗨');
        return undefined;
      }
      for await (const part of await model.stream('嗨')) void part;
      return undefined;
    }),
  ).catch((caught: unknown) => {
    error = caught;
  });
  return { log, error };
}

const retryRows = (log: SessionLog) =>
  log.events
    .filter((event) => event.type === 'llm/retry')
    .map((event) => (event.data as { failure: { code: string; status?: number } }).failure);

/** 一列的期望：碼、有狀態的話狀態、假端點該收到幾個請求。 */
interface Expected {
  readonly code: string;
  readonly status?: number;
  readonly hits: number;
}

const RETRYING = RETRIES + 1;

/** 端點的錯誤信封（OpenAI 形狀）。 */
const envelope = (message: string, code?: number): unknown => ({
  error: { message, type: 'x', ...(code !== undefined && { code }) },
});

describe('B／C／D：HTTP 狀態（首事件之前）', () => {
  const table: readonly (readonly [string, number, Expected])[] = [
    ['401', 401, { code: 'AUTH', status: 401, hits: 1 }],
    ['403', 403, { code: 'AUTH', status: 403, hits: 1 }],
    ['402', 402, { code: 'QUOTA', status: 402, hits: 1 }],
    ['429（沒有 retry-after）', 429, { code: 'RATE_LIMIT', status: 429, hits: RETRYING }],
    ['400', 400, { code: 'INVALID_REQUEST', status: 400, hits: 1 }],
    ['413', 413, { code: 'INVALID_REQUEST', status: 413, hits: 1 }],
    ['404', 404, { code: 'HTTP_404', status: 404, hits: 1 }],
    ['408', 408, { code: 'HTTP_408', status: 408, hits: 1 }],
    ['418', 418, { code: 'HTTP_418', status: 418, hits: 1 }],
    ['422', 422, { code: 'HTTP_422', status: 422, hits: 1 }],
    ['425', 425, { code: 'HTTP_425', status: 425, hits: 1 }],
    ['500', 500, { code: 'SERVER', status: 500, hits: RETRYING }],
    ['502', 502, { code: 'SERVER', status: 502, hits: RETRYING }],
    ['503', 503, { code: 'SERVER', status: 503, hits: RETRYING }],
    ['504', 504, { code: 'SERVER', status: 504, hits: RETRYING }],
  ];

  for (const [name, status, expected] of table) {
    it(`${name} → ${expected.code}，端點收到 ${String(expected.hits)} 個請求`, async () => {
      cell = { kind: 'http', status, body: envelope(`上游回 ${String(status)}`) };
      const { log, error } = await run();

      expect(hits).toBe(expected.hits);
      // C：turn/failed 那一支與 llm/retry 那一支同一個碼。
      const turn = classifyTurnFailure(error);
      expect(turn.code).toBe(expected.code);
      expect(turn.status).toBe(expected.status);
      const rows = retryRows(log);
      expect(rows).toHaveLength(expected.hits - 1);
      for (const row of rows) {
        expect(row.code).toBe(expected.code);
        expect(row.status).toBe(expected.status);
      }
    }, 30_000);
  }

  it('429 帶 insufficient_quota → QUOTA，不重打', async () => {
    cell = {
      kind: 'http',
      status: 429,
      body: {
        error: { message: '額度用完', type: 'insufficient_quota', code: 'insufficient_quota' },
      },
    };
    const { log, error } = await run();

    expect(hits).toBe(1);
    expect(classifyTurnFailure(error).code).toBe('QUOTA');
    expect(retryRows(log)).toEqual([]);
  });

  it('不存在的模型：404 純文字（M2 實測的原樣）→ HTTP_404，不重打', async () => {
    cell = { kind: 'http', status: 404, body: '404 page not found', raw: true };
    const { error } = await run();

    expect(hits).toBe(1);
    expect(classifyTurnFailure(error)).toMatchObject({ code: 'HTTP_404', status: 404 });
  });

  it('超大 body：端點回的是 400（不是 413）＋maximum context length → CONTEXT_WINDOW_EXCEEDED，不被 INVALID_REQUEST 搶走', async () => {
    // M2 實測的 6.3 MB body 回的信封，逐字。`@langchain/openai` 認得 `maximum context length`，
    // 把它包成 `ContextOverflowError`；這一列釘的是併掉分類器之後，400 那一支不會蓋過它。
    cell = {
      kind: 'http',
      status: 400,
      body: {
        message:
          "This model's maximum context length is 1000000 tokens. However, your messages resulted in 1579695 tokens. Please reduce the length of the messages.",
        type: 'Bad Request',
        code: 400,
      },
    };
    const { log, error } = await run();

    expect(hits).toBe(1);
    expect(classifyTurnFailure(error)).toMatchObject({
      code: 'CONTEXT_WINDOW_EXCEEDED',
      status: 400,
    });
    expect(retryRows(log)).toEqual([]);
  });

  it('超大 body：26 MB 的上限信封 → INVALID_REQUEST（400），不重打', async () => {
    cell = {
      kind: 'http',
      status: 400,
      body: {
        error: {
          message:
            'Please make sure your payload is below 26214400 bytes in size. If larger assets are required please refer to our Assets API.',
          type: 'invalid_request_error',
          param: null,
          code: 'invalid_request_body_too_large',
        },
      },
    };
    const { error } = await run();

    expect(hits).toBe(1);
    expect(classifyTurnFailure(error)).toMatchObject({ code: 'INVALID_REQUEST', status: 400 });
  });

  it('導出負 max_tokens 的 400（gpt-oss-20b 的溢出）→ CONTEXT_WINDOW_EXCEEDED，不重打', async () => {
    cell = {
      kind: 'http',
      status: 400,
      body: {
        error: {
          message:
            'max_tokens must be at least 1, got -46771. (parameter=max_tokens, value=-46771)',
          type: 'BadRequestError',
          param: 'max_tokens',
          code: 400,
        },
      },
    };
    const { error } = await run();

    expect(hits).toBe(1);
    expect(classifyTurnFailure(error).code).toBe('CONTEXT_WINDOW_EXCEEDED');
  });

  it('410 → 那句下架的人話照留，碼是 HTTP_410，不重打', async () => {
    cell = {
      kind: 'http',
      status: 410,
      body: {
        type: 'about:blank',
        title: 'Gone',
        status: 410,
        detail:
          "The model 'openai/gpt-oss-120b' has reached its end of life on 2026-09-03T08:00:00Z and is no longer available.",
      },
    };
    const { log, error } = await run();

    expect(hits).toBe(1);
    expect((error as Error).message).toContain('2026-09-03T08:00:00Z');
    expect(classifyTurnFailure(error)).toMatchObject({ code: 'HTTP_410', status: 410 });
    expect(retryRows(log)).toEqual([]);
  });
});

describe('B／C／D：串流（首事件之前與之後）', () => {
  it('第一則事件是 503 的信封 → SERVER，重打', async () => {
    cell = { kind: 'inband-first', envelope: { message: '過載', type: 'x', code: 503 } };
    const { log, error } = await run();

    expect(hits).toBe(RETRYING);
    expect(classifyTurnFailure(error)).toMatchObject({ code: 'SERVER', status: 503 });
    expect(retryRows(log).map((row) => row.code)).toEqual(['SERVER', 'SERVER']);
  }, 30_000);

  it('第一則事件是 400 的信封 → INVALID_REQUEST，不重打', async () => {
    cell = { kind: 'inband-first', envelope: { message: '壞請求', type: 'x', code: 400 } };
    const { error } = await run();

    expect(hits).toBe(1);
    expect(classifyTurnFailure(error)).toMatchObject({ code: 'INVALID_REQUEST', status: 400 });
  });

  it('第一則事件是 422 的信封 → HTTP_422，不重打', async () => {
    cell = { kind: 'inband-first', envelope: { message: '不能處理', type: 'x', code: 422 } };
    const { error } = await run();

    expect(hits).toBe(1);
    expect(classifyTurnFailure(error)).toMatchObject({ code: 'HTTP_422', status: 422 });
  });

  it('第一則事件的信封沒有數字碼 → SERVER，重打（照 providerError）', async () => {
    cell = { kind: 'inband-first', envelope: { message: '出事了', type: 'service_unavailable' } };
    const { log, error } = await run();

    expect(hits).toBe(RETRYING);
    expect(classifyTurnFailure(error).code).toBe('SERVER');
    expect(retryRows(log).map((row) => row.code)).toEqual(['SERVER', 'SERVER']);
  }, 30_000);

  it('串流中段的 503 信封（已經吐了內容）→ llm/retry 與 turn/failed 都是 SERVER', async () => {
    cell = { kind: 'inband-mid', envelope: { message: '過載', type: 'x', code: 503 } };
    const { log, error } = await run();

    expect(hits).toBe(RETRYING);
    // C：#1437 之前這裡 turn/failed 是 UNKNOWN（那顆 APIError 沒有 status），llm/retry 卻是 SERVER。
    expect(classifyTurnFailure(error).code).toBe('SERVER');
    expect(retryRows(log).map((row) => row.code)).toEqual(['SERVER', 'SERVER']);
  }, 30_000);

  it('串流中段的信封沒有數字碼 → SERVER，重打', async () => {
    cell = { kind: 'inband-mid', envelope: { message: '出事了', type: 'service_unavailable' } };
    const { log, error } = await run();

    expect(hits).toBe(RETRYING);
    expect(classifyTurnFailure(error).code).toBe('SERVER');
    expect(retryRows(log).map((row) => row.code)).toEqual(['SERVER', 'SERVER']);
  }, 30_000);

  it('串流中段的 422 信封 → HTTP_422，不重打', async () => {
    cell = { kind: 'inband-mid', envelope: { message: '不能處理', type: 'x', code: 422 } };
    const { error } = await run();

    expect(hits).toBe(1);
    expect(classifyTurnFailure(error).code).toBe('HTTP_422');
  });

  it('串流中段被切斷（undici 的 terminated）→ TRANSPORT，重打；兩邊同一個碼', async () => {
    cell = { kind: 'reset-mid' };
    const { log, error } = await run();

    expect(hits).toBe(RETRYING);
    // C：#1437 之前 turn/failed 是 UNKNOWN。
    expect(classifyTurnFailure(error).code).toBe('TRANSPORT');
    expect(retryRows(log).map((row) => row.code)).toEqual(['TRANSPORT', 'TRANSPORT']);
  }, 30_000);

  it('非串流的 body 讀到一半被切斷 → TRANSPORT，重打；兩邊同一個碼（CLI／標題／摘要器／eval 走的路）', async () => {
    cell = { kind: 'json-reset-mid' };
    const { log, error } = await run({ mode: 'invoke' });

    expect(hits).toBe(RETRYING);
    expect(classifyTurnFailure(error).code).toBe('TRANSPORT');
    expect(retryRows(log).map((row) => row.code)).toEqual(['TRANSPORT', 'TRANSPORT']);
  }, 30_000);

  it('連線被拒（APIConnectionError）→ TRANSPORT，重打', async () => {
    // 先拿一個確定沒人聽的埠。
    const probe = createServer();
    await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
    const dead = `http://127.0.0.1:${String((probe.address() as AddressInfo).port)}/v1`;
    await new Promise<void>((done) => probe.close(() => done()));

    const { log, error } = await run({ url: dead });

    expect(classifyTurnFailure(error).code).toBe('TRANSPORT');
    expect(retryRows(log).map((row) => row.code)).toEqual(['TRANSPORT', 'TRANSPORT']);
  }, 30_000);

  it('到第一則事件的逾時 → TIMEOUT，重打', async () => {
    cell = { kind: 'silent' };
    const { log, error } = await run({ timeoutMs: 150 });

    expect(hits).toBe(RETRYING);
    expect(classifyTurnFailure(error).code).toBe('TIMEOUT');
    expect(retryRows(log).map((row) => row.code)).toEqual(['TIMEOUT', 'TIMEOUT']);
  }, 30_000);

  it('解不開的回應（SSE 事件不是 JSON）→ UNKNOWN，不重打（Q2 (a)）', async () => {
    cell = { kind: 'garbage' };
    const { log, error } = await run();

    // D：碼不在 retryableCodes 裡就不重打。**這一列在 develop 上也只打 1 次**——串流的解析失敗發生在 AsyncCaller 外面，
    // 沒有人回報，所以它分辨不出新舊；分得出來的是下一列（非串流）。
    expect(hits).toBe(1);
    expect(classifyTurnFailure(error).code).toBe('UNKNOWN');
    expect(retryRows(log)).toEqual([]);
  });

  it('解不開的回應（非串流，200＋壞 JSON）→ UNKNOWN，不重打（Q2 (a)；#1437 之前記 TRANSPORT、重打到預算用盡）', async () => {
    cell = { kind: 'bad-json' };
    const { log, error } = await run({ mode: 'invoke' });

    expect(hits).toBe(1);
    expect(classifyTurnFailure(error).code).toBe('UNKNOWN');
    expect(retryRows(log)).toEqual([]);
  });
});

describe('讀端的失敗：沒有任何碼的錯，也跟 llm/retry 同一個碼', () => {
  it('讀上游 body 時失敗（沒有 code、不是 APIConnectionError）→ TRANSPORT，不是 UNKNOWN', async () => {
    // 閒置監看在 `reader.read()` 失敗時把那顆錯標成連線層的（`connectionFailures`）；
    // 分類器靠這個記號，不必猜每一種讀端錯誤帶不帶 `cause.code`。
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('讀不下去了'));
      },
    });
    const watched = withStreamIdleTimeout(
      1_000,
      async () =>
        new Response(source, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    const response = await watched('http://127.0.0.1:1/v1', {});
    let caught: unknown;
    try {
      await response.text();
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(classifyTurnFailure(caught).code).toBe('TRANSPORT');
  });
});

describe('連線碼是列舉，不是前綴；逾時類記 TIMEOUT', () => {
  /** 一顆「模型呼叫拋的」undici 形狀的錯：外層 `TypeError`，真正的碼在 `cause`。 */
  const undici = (code: string): unknown => {
    const error = new TypeError('fetch failed', {
      cause: Object.assign(new Error(code), { code }),
    });
    markModelCallFailure(error);
    return error;
  };

  it.each([
    'UND_ERR_SOCKET',
    'UND_ERR_CLOSED',
    'ECONNRESET',
    'ECONNREFUSED',
    'EPIPE',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'ERR_INCOMPLETE_CHUNKED_ENCODING',
  ])('%s → TRANSPORT', (code) => {
    expect(classifyTurnFailure(undici(code)).code).toBe('TRANSPORT');
  });

  it.each([
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'ETIMEDOUT',
  ])('%s → TIMEOUT（照 pi-ai：逾時排在連線之前）', (code) => {
    expect(classifyTurnFailure(undici(code)).code).toBe('TIMEOUT');
  });

  it('UND_ERR_INVALID_ARG（我們自己的程式錯誤）→ UNKNOWN，而且 onFailedAttempt 放棄、不重打', () => {
    const error = undici('UND_ERR_INVALID_ARG');
    expect(classifyTurnFailure(error).code).toBe('UNKNOWN');
    expect(() => classifyFailedAttempt(error)).toThrow();
  });
});

describe('E：不是供應商的錯，與被層層包住的供應商錯', () => {
  it('工具 middleware 拋的、遞迴上限這類沒有供應商痕跡的錯 → UNKNOWN', () => {
    expect(classifyTurnFailure(new Error('工具壞了')).code).toBe('UNKNOWN');
    expect(classifyTurnFailure(new Error('Recursion limit of 100 reached')).code).toBe('UNKNOWN');
  });

  it('被十四層 MiddlewareError 包住的 401 仍是 AUTH', () => {
    let wrapped: unknown = Object.assign(new Error('Unauthorized'), { status: 401 });
    for (let layer = 0; layer < 14; layer += 1) {
      wrapped = MiddlewareError.wrap(wrapped, `middleware-${String(layer)}`);
    }
    expect(classifyTurnFailure(wrapped)).toMatchObject({ code: 'AUTH', status: 401 });
  });

  it('工具 middleware 拋的錯、cause 帶 ECONNREFUSED（MCP 伺服器連不上）→ UNKNOWN，不被連線規則搶走', () => {
    const tool = new Error('MCP 伺服器連不上', {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' }),
    });
    const wrapped = MiddlewareError.wrap(MiddlewareError.wrap(tool, 'mcp'), 'outer');
    expect(classifyTurnFailure(wrapped).code).toBe('UNKNOWN');
    // 同一個形狀，若是模型呼叫拋的就是 TRANSPORT——差別只在有沒有「模型呼叫」的記號。
    markModelCallFailure(tool);
    expect(classifyTurnFailure(wrapped).code).toBe('TRANSPORT');
  });

  it('「模型呼叫」的記號標在 MiddlewareError 包裝層上（wrapModelCall 的 catch 實際拿到的）→ 仍認得串流中段的 in-band 錯誤（#1763）', () => {
    // 形狀同 openai SDK 在串流中段拋的那顆：基底類別 APIError、沒有 status，信封在 `error`。
    class APIError extends Error {
      constructor(readonly error: unknown) {
        super('mid in-band failure');
      }
    }
    const inband = new APIError({ message: '過載', type: 'x', code: 503 });
    // 標記標在包裝層，不是底下的供應商錯——`turn-cancel.ts` 那一格的 catch 看到的可能是基座包過的那一層（deepagents 的中介層在它裡面）。
    const wrapped = MiddlewareError.wrap(MiddlewareError.wrap(inband, 'inner'), 'outer');
    expect(classifyTurnFailure(wrapped).code).toBe('UNKNOWN');
    let layer: unknown = wrapped;
    while (MiddlewareError.isInstance(layer) && MiddlewareError.isInstance(layer.cause)) {
      layer = layer.cause;
    }
    markModelCallFailure(layer);
    expect(classifyTurnFailure(wrapped)).toMatchObject({ code: 'SERVER', status: 503 });
  });

  it('同一個標記位置對連線錯誤也成立；沒有標記的工具錯誤仍是 UNKNOWN（#1763）', () => {
    const reset = new TypeError('fetch failed', {
      cause: Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }),
    });
    const wrapped = MiddlewareError.wrap(reset, 'model');
    expect(classifyTurnFailure(wrapped).code).toBe('UNKNOWN');
    markModelCallFailure(wrapped);
    expect(classifyTurnFailure(wrapped).code).toBe('TRANSPORT');
    // 另一條沒被標的鏈（工具的錯）不受影響。
    const tool = MiddlewareError.wrap(
      new Error('MCP 伺服器連不上', {
        cause: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      }),
      'mcp',
    );
    expect(classifyTurnFailure(tool).code).toBe('UNKNOWN');
  });

  it('被包住的 422 與 408 也是 HTTP_<n>', () => {
    for (const status of [408, 422, 425]) {
      const inner = Object.assign(new Error(String(status)), { status });
      const outer = MiddlewareError.wrap(MiddlewareError.wrap(inner, 'a'), 'b');
      expect(classifyTurnFailure(outer).code).toBe(`HTTP_${String(status)}`);
    }
  });

  it('配額的兩個名字（RateLimitQuotaExhaustedError、InsufficientQuotaError）→ QUOTA，不是 RATE_LIMIT', () => {
    for (const name of ['RateLimitQuotaExhaustedError', 'InsufficientQuotaError']) {
      const quota = Object.assign(new Error('額度'), { name, status: 429 });
      expect(classifyTurnFailure(quota).code).toBe('QUOTA');
    }
  });
});
