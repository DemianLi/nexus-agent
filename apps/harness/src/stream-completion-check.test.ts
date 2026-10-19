/**
 * 串流完成檢查（[#1538](https://github.com/DemianLi/nexus-agent/issues/1538)）：沒收到結束原因就斷的串流算 `TRANSPORT` 整次重打，
 * 陌生的 `finish_reason` 算失敗、不重打。
 *
 * 沿用 `live-model-retry-events.test.ts` 的 loopback 假端點（零憑證、零外部連線），把**真的 `createLiveModel`**（它組出來的實際 fetch 疊，
 * 不是單獨呼叫 `withStreamCompletionCheck`）放進 `@nexus/core` 的 `retryModelCall` 跑，再數端點收到幾個請求、日誌有幾顆 `llm/retry`、
 * 最後拋出來的錯分類成什麼碼。退避縮成幾十毫秒（`jitterRatio: 0`）。
 *
 * | 假端點送什麼 | 預期 |
 * | --- | --- |
 * | 兩段文字後 EOF（沒有 finish、沒有 `[DONE]`） | 重打到預算用完，`TRANSPORT` |
 * | 兩段文字後只有 `[DONE]` | 同上（只在 EOF 判斷抓不到這一種） |
 * | 正常 `stop`、`stop` 後多一則 usage 事件、`tool_calls` 收尾 | 打 1 次，正常結束 |
 * | 中段錯誤信封後 `[DONE]` | 照信封分類（`SERVER`），不是 `TRANSPORT` |
 * | 使用者中止 | 不重打 |
 * | 工具呼叫參數送到一半 EOF | `TRANSPORT` 重打（不產生壞參數的呼叫） |
 * | 陌生 `finish_reason` | `UNKNOWN`、打 1 次、訊息帶原字串 |
 * | 型錄條目 `compat.supportsFinishReason: false` | 沒有 finish 也正常結束 |
 */

import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { retryModelCall, SessionLog } from '@nexus/core';
import {
  classifyTurnFailure,
  createLiveModel,
  DEFAULT_LIVE_MODEL_ENTRY,
  LIVE_API_KEY_ENV,
  StreamEndedWithoutFinishError,
  UnknownFinishReasonError,
  withStreamCompletionCheck,
} from './live-model.js';
import { liveModelConfigSchema, streamRetryOptionsOf } from './settings/live-model.js';

const RETRIES = 1;

type Body = (response: ServerResponse) => void;

const chunk = (delta: Record<string, unknown>, finish: string | null = null): string =>
  `data: ${JSON.stringify({
    id: 'c1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'fake',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
const usageOnly = `data: ${JSON.stringify({
  id: 'c1',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'fake',
  choices: [],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
})}\n\n`;
const DONE = 'data: [DONE]\n\n';

let server: Server;
let baseUrl: string;
let hits = 0;
let body: Body = () => undefined;
let savedKey: string | undefined;

beforeEach(async () => {
  hits = 0;
  savedKey = process.env[LIVE_API_KEY_ENV];
  process.env[LIVE_API_KEY_ENV] = 'fake-key-for-loopback';
  server = createServer((request, response) => {
    hits += 1;
    request.resume();
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    body(response);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('拿不到 loopback 埠');
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

afterEach(async () => {
  if (savedKey === undefined) delete process.env[LIVE_API_KEY_ENV];
  else process.env[LIVE_API_KEY_ENV] = savedKey;
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
});

const config = () => liveModelConfigSchema.parse({ baseUrl });

const policy = () =>
  streamRetryOptionsOf(
    liveModelConfigSchema.parse({
      baseUrl,
      retryPolicy: {
        mode: 'normal',
        maxRetries: RETRIES,
        backoff: { initialDelayMs: 20, maxDelayMs: 50, jitterRatio: 0 },
      },
    }).retryPolicy,
  );

interface Outcome {
  readonly error: unknown;
  readonly text: string;
  readonly log: SessionLog;
}

/** 把一次串流呼叫放進重試迴圈跑完；回最後拋出來的錯（沒有就 `undefined`）、成功那一次讀到的文字、日誌。 */
async function run(model = createLiveModel(config()), signal?: AbortSignal): Promise<Outcome> {
  const log = new SessionLog('r');
  let text = '';
  let error: unknown;
  try {
    await retryModelCall(policy(), { log, ...(signal !== undefined && { signal }) }, async () => {
      text = '';
      for await (const part of await model.stream('嗨', signal === undefined ? {} : { signal })) {
        if (typeof part.content === 'string') text += part.content;
      }
    });
  } catch (caught: unknown) {
    error = caught;
  }
  return { error, text, log };
}

const retries = (log: SessionLog) => log.events.filter((event) => event.type === 'llm/retry');
const codeOf = (error: unknown): string => classifyTurnFailure(error).code;

describe('沒有 finish_reason 的串流算斷線', () => {
  it('兩段文字後 EOF：重打到預算用完，碼是 TRANSPORT，日誌有一顆 llm/retry', async () => {
    body = (response) => {
      response.write(chunk({ role: 'assistant', content: '報表要' }));
      response.write(chunk({ content: '按部門' }));
      response.end();
    };
    const { error, log } = await run();

    expect(hits).toBe(RETRIES + 1);
    expect(codeOf(error)).toBe('TRANSPORT');
    expect(retries(log)).toHaveLength(RETRIES);
    expect(retries(log)[0]?.data).toMatchObject({ failure: { code: 'TRANSPORT' } });
  });

  it('兩段文字後只有 [DONE]、沒有 finish：同樣 TRANSPORT（只在 EOF 判斷抓不到這一種）', async () => {
    body = (response) => {
      response.write(chunk({ role: 'assistant', content: '報表要' }));
      response.write(chunk({ content: '按部門' }));
      response.end(DONE);
    };
    const { error, log } = await run();

    expect(hits).toBe(RETRIES + 1);
    expect(codeOf(error)).toBe('TRANSPORT');
    expect(retries(log)).toHaveLength(RETRIES);
  });

  it('整個 body 是空的：也算沒收到結束原因', async () => {
    body = (response) => response.end();
    const { error } = await run();
    expect(hits).toBe(RETRIES + 1);
    expect(codeOf(error)).toBe('TRANSPORT');
  });

  it('工具呼叫參數送到一半就 EOF：TRANSPORT 重打，不會變成一顆壞參數的呼叫', async () => {
    body = (response) => {
      response.write(
        chunk({
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"/a' },
            },
          ],
        }),
      );
      response.end();
    };
    const { error } = await run();
    expect(hits).toBe(RETRIES + 1);
    expect(codeOf(error)).toBe('TRANSPORT');
  });

  it('錯誤是 StreamEndedWithoutFinishError，名字不是 AbortError', async () => {
    body = (response) => {
      response.write(chunk({ role: 'assistant', content: '半' }));
      response.end();
    };
    const model = createLiveModel(config());
    const caught = await (async () => {
      try {
        for await (const _part of await model.stream('嗨')) void _part;
      } catch (error: unknown) {
        return error;
      }
      return undefined;
    })();
    const found = [caught, (caught as { cause?: unknown } | undefined)?.cause].find(
      (link) => link instanceof StreamEndedWithoutFinishError,
    ) as StreamEndedWithoutFinishError | undefined;
    expect(found).toBeDefined();
    expect(found?.name).toBe('StreamEndedWithoutFinishError');
    expect(found?.via).toBe('eof');
  });
});

describe('不誤傷正常的串流', () => {
  const normal: ReadonlyArray<[string, Body]> = [
    [
      'stop 收尾',
      (response) => {
        response.write(chunk({ role: 'assistant', content: '好' }));
        response.write(chunk({}, 'stop'));
        response.end(DONE);
      },
    ],
    [
      'finish_reason 之後還有一則只帶 usage 的事件，再 [DONE]',
      (response) => {
        response.write(chunk({ role: 'assistant', content: '好' }));
        response.write(chunk({}, 'stop'));
        response.write(usageOnly);
        response.end(DONE);
      },
    ],
    [
      'finish_reason 與 [DONE] 在同一段位元組',
      (response) => {
        response.end(chunk({ role: 'assistant', content: '好' }) + chunk({}, 'stop') + DONE);
      },
    ],
    [
      'tool_calls 收尾',
      (response) => {
        response.write(
          chunk({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"/a"}' },
              },
            ],
          }),
        );
        response.write(chunk({}, 'tool_calls'));
        response.end(DONE);
      },
    ],
    [
      'length 收尾（撞輸出上限，由 max-tokens 那一顆處理，不是這一層的事）',
      (response) => {
        response.write(chunk({ role: 'assistant', content: '好' }));
        response.write(chunk({}, 'length'));
        response.end(DONE);
      },
    ],
    [
      'finish_reason 之後沒有 [DONE]、直接 EOF',
      (response) => {
        response.write(chunk({ role: 'assistant', content: '好' }));
        response.end(chunk({}, 'stop'));
      },
    ],
  ];

  it.each(normal)('%s：打 1 次、正常結束', async (_name, send) => {
    body = send;
    const { error, log } = await run();
    expect(error).toBeUndefined();
    expect(hits).toBe(1);
    expect(retries(log)).toHaveLength(0);
  });
});

describe('其他失敗不被這一層改判', () => {
  it('中段的錯誤信封（不是第一則事件）後接 [DONE]、沒有 finish：碼照信封分類（SERVER），不是 TRANSPORT', async () => {
    body = (response) => {
      response.write(chunk({ role: 'assistant', content: '半' }));
      response.write(
        `data: ${JSON.stringify({ error: { message: 'mid failure', type: 'x', code: 503 } })}\n\n`,
      );
      response.end(DONE);
    };
    const { log } = await run();
    // 重試那一層讀到的碼（信封那一條回報的），不是這一層的 TRANSPORT。
    expect(retries(log)).toHaveLength(RETRIES);
    expect(retries(log)[0]?.data).toMatchObject({ failure: { code: 'SERVER', status: 503 } });
  });

  it('使用者中止：沒有 TRANSPORT 回報、不重打', async () => {
    const controller = new AbortController();
    body = (response) => {
      response.write(chunk({ role: 'assistant', content: '半' }));
      setTimeout(() => controller.abort(), 30);
      // 不關線：等使用者中止。
    };
    const { log } = await run(createLiveModel(config()), controller.signal);
    expect(hits).toBe(1);
    expect(retries(log)).toHaveLength(0);
  });
});

describe('陌生的 finish_reason 算失敗（Q1 (a)）', () => {
  it('insufficient_system_resource：UNKNOWN、只打 1 次、訊息帶原字串', async () => {
    body = (response) => {
      response.write(chunk({ role: 'assistant', content: '半' }));
      response.write(chunk({}, 'insufficient_system_resource'));
      response.end(DONE);
    };
    const { error, log } = await run();

    expect(hits).toBe(1);
    expect(retries(log)).toHaveLength(0);
    const failure = classifyTurnFailure(error);
    expect(failure.code).toBe('UNKNOWN');
    expect(failure.message).toContain('insufficient_system_resource');
  });

  it('錯誤是 UnknownFinishReasonError，帶原字串', async () => {
    body = (response) => {
      response.end(chunk({ role: 'assistant', content: '半' }) + chunk({}, 'weird') + DONE);
    };
    const model = createLiveModel(config());
    const caught = await (async () => {
      try {
        for await (const _part of await model.stream('嗨')) void _part;
      } catch (error: unknown) {
        return error;
      }
      return undefined;
    })();
    const found = [caught, (caught as { cause?: unknown } | undefined)?.cause].find(
      (link) => link instanceof UnknownFinishReasonError,
    ) as UnknownFinishReasonError | undefined;
    expect(found?.reason).toBe('weird');
  });
});

describe('相容開關 compat.supportsFinishReason', () => {
  const entry = (supportsFinishReason: boolean | undefined) => ({
    ...DEFAULT_LIVE_MODEL_ENTRY,
    compat: {
      ...DEFAULT_LIVE_MODEL_ENTRY.compat,
      ...(supportsFinishReason !== undefined && { supportsFinishReason }),
    },
  });
  const modelWith = (supportsFinishReason: boolean | undefined) =>
    createLiveModel(
      liveModelConfigSchema.parse({
        baseUrl,
        models: [entry(supportsFinishReason)],
        modelId: DEFAULT_LIVE_MODEL_ENTRY.id,
      }),
    );
  const noFinish: Body = (response) => {
    response.write(chunk({ role: 'assistant', content: '好' }));
    response.end(DONE);
  };

  it('false：沒有 finish_reason 的端點照常結束，打 1 次', async () => {
    body = noFinish;
    const { error, text } = await run(modelWith(false));
    expect(error).toBeUndefined();
    expect(text).toBe('好');
    expect(hits).toBe(1);
  });

  it('false：陌生的 finish_reason 也不再算失敗', async () => {
    body = (response) => {
      response.write(chunk({ role: 'assistant', content: '好' }));
      response.write(chunk({}, 'insufficient_system_resource'));
      response.end(DONE);
    };
    const { error } = await run(modelWith(false));
    expect(error).toBeUndefined();
    expect(hits).toBe(1);
  });

  it('沒寫 / true：預設檢查', async () => {
    body = noFinish;
    expect(codeOf((await run(modelWith(undefined))).error)).toBe('TRANSPORT');
    hits = 0;
    expect(codeOf((await run(modelWith(true))).error)).toBe('TRANSPORT');
  });
});

describe('withStreamCompletionCheck 單獨：不改位元組、非 SSE 與非 2xx 原樣放行', () => {
  const sse =
    (...parts: string[]): typeof fetch =>
    async () =>
      new Response(parts.join(''), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });

  it('完整的串流：位元組逐字相同', async () => {
    const parts = [chunk({ content: '好' }), chunk({}, 'stop'), DONE];
    const response = await withStreamCompletionCheck(sse(...parts))('http://x/');
    expect(await response.text()).toBe(parts.join(''));
  });

  it('JSON 回應與非 2xx：不看', async () => {
    const json: typeof fetch = async () =>
      new Response('{"choices":[]}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    expect(await (await withStreamCompletionCheck(json)('http://x/')).text()).toBe(
      '{"choices":[]}',
    );
    const bad: typeof fetch = async () =>
      new Response('x', { status: 500, headers: { 'content-type': 'text/event-stream' } });
    expect(await (await withStreamCompletionCheck(bad)('http://x/')).text()).toBe('x');
  });

  it('事件被切在任意位置也認得（一個位元組一個位元組送）', async () => {
    const text = chunk({ content: '好' }) + chunk({}, 'stop') + DONE;
    const bytes = new TextEncoder().encode(text);
    const slow: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
            controller.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    expect(await (await withStreamCompletionCheck(slow)('http://x/')).text()).toBe(text);
  });

  it('看過錯誤信封：後面接 [DONE]、沒有 finish，這一層不再加一顆錯（錯誤歸信封那一條）', async () => {
    const envelope = `data: ${JSON.stringify({ error: { message: 'x', code: 503 } })}\n\n`;
    const parts = [chunk({ content: '半' }), envelope, DONE];
    const response = await withStreamCompletionCheck(sse(...parts))('http://x/');
    expect(await response.text()).toBe(parts.join(''));
  });

  it('單一事件超過上限就放棄監看：沒有 finish 也不報錯', async () => {
    const huge = `data: ${'x'.repeat(1_048_577)}`;
    const response = await withStreamCompletionCheck(sse(huge))('http://x/');
    await expect(response.text()).resolves.toBe(huge);
  });
});
