/**
 * **產品路徑：失敗的那一輪，`turn/failed.error.code` 讀得出為什麼**
 * （[#434](https://github.com/DemianLi/nexus-agent/issues/434)）。
 *
 * 做法同 `stream-idle-timeout.test.ts`：假的 OpenAI 端點、真的 `createLiveModel`、真的 `createNexusAgent`、
 * 真的 `ThreadPump`，讀 pump 那份日誌上的 `turn/failed`。**不直接丟錯誤物件給 `classifyTurnFailure`**：
 * 丟到 pump 那個 catch 的錯是 14 層 `MiddlewareError`（實測），供應商的狀態在最底下；直接餵一個乾淨的
 * `RateLimitError` 會讓「沒拆包裝」的實作也綠。
 *
 * 重試關掉（`maxRetries: 0`）：這裡要的是放棄的那些（金鑰錯、配額、溢出…）怎麼被記，不是重試。
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MemorySaver } from '@langchain/langgraph';
import { SessionLog } from '@nexus/core';
import type { SessionEvent, SessionEventMap } from '@nexus/core';
import { applyTrajectory, initialTrajectory, viewTrajectory } from '@nexus/plugin-trajectory';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { runTurn } from './cli.js';
import { classifyTurnFailure, createLiveModel, LIVE_API_KEY_ENV } from './live-model.js';
import { ScriptedChatModel } from './scripted-model.js';
import { liveModelConfigSchema } from './settings/live-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

type Reply =
  | { readonly status: number; readonly body: unknown }
  | { readonly inband: unknown }
  | { readonly reset: true }
  | { readonly hang: true };

let server: Server;
let baseUrl: string;
let reply: Reply;
let savedKey: string | undefined;

beforeEach(async () => {
  savedKey = process.env[LIVE_API_KEY_ENV];
  process.env[LIVE_API_KEY_ENV] = 'nvapi-test-value-not-a-real-key';
  server = createServer((request, response) => {
    request.resume();
    if ('hang' in reply) return;
    if ('reset' in reply) {
      request.socket.destroy();
      return;
    }
    if ('inband' in reply) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify(reply.inband)}\n\n`);
      response.end('data: [DONE]\n\n');
      return;
    }
    response.writeHead(reply.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterEach(async () => {
  if (savedKey === undefined) delete process.env[LIVE_API_KEY_ENV];
  else process.env[LIVE_API_KEY_ENV] = savedKey;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** 跑一輪、讓它失敗，回 pump 日誌上那一顆 `turn/failed` 的資料。 */
async function failedTurn(
  model: Parameters<typeof createNexusAgent>[0]['model'],
): Promise<SessionEventMap['turn/failed']> {
  const failed = (await failedLog(model)).filter((event) => event.type === 'turn/failed');
  expect(failed).toHaveLength(1);
  return failed[0]!.data as SessionEventMap['turn/failed'];
}

/** 跑一輪、讓它失敗，回 pump 的整份日誌事件。 */
async function failedLog(
  model: Parameters<typeof createNexusAgent>[0]['model'],
): Promise<readonly SessionEvent[]> {
  const built = await createNexusAgent({ model, checkpointer: new MemorySaver(), plugins: [] });
  const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'turn-failed-code');
  const detach = built.attachSession(pump.sessions);
  try {
    await pump.submit({ kind: 'message', text: '說點什麼' }).then(
      () => undefined,
      () => undefined,
    );
    return [...pump.sessions.root.events];
  } finally {
    detach();
    await built.dispose();
  }
}

const live = (timeoutMs?: number) =>
  createLiveModel(
    liveModelConfigSchema.parse({
      baseUrl,
      maxRetries: 0,
      ...(timeoutMs !== undefined && { timeoutMs }),
    }),
  );

const error = (message: string, extra: Record<string, unknown> = {}) => ({
  error: { message, ...extra },
});

describe('turn/failed 帶分類碼（假端點＋真的 pump）', () => {
  const table: readonly [string, Reply, string, number | undefined][] = [
    [
      '401 金鑰不對',
      {
        status: 401,
        body: error('Invalid API key', { type: 'invalid_request_error', code: 'invalid_api_key' }),
      },
      'AUTH',
      401,
    ],
    ['403', { status: 403, body: error('forbidden') }, 'AUTH', 403],
    [
      '429 配額耗盡（跟限流共用 429，要先認它）',
      {
        status: 429,
        body: error('You exceeded your current quota', {
          type: 'insufficient_quota',
          code: 'insufficient_quota',
        }),
      },
      'QUOTA',
      429,
    ],
    [
      '429 限流',
      {
        status: 429,
        body: error('Rate limit reached', { type: 'requests', code: 'rate_limit_exceeded' }),
      },
      'RATE_LIMIT',
      429,
    ],
    [
      '400 上下文溢出',
      {
        status: 400,
        body: error(
          "This model's maximum context length is 131072 tokens. However, you requested 200000",
          { type: 'invalid_request_error', code: 'context_length_exceeded' },
        ),
      },
      'CONTEXT_WINDOW_EXCEEDED',
      400,
    ],
    [
      '400 一般',
      { status: 400, body: error('bad param', { type: 'invalid_request_error' }) },
      'INVALID_REQUEST',
      400,
    ],
    [
      '404 沒有這個模型',
      { status: 404, body: error('The model does not exist', { code: 'model_not_found' }) },
      'HTTP_404',
      404,
    ],
    ['410 模型下架', { status: 410, body: error('gone') }, 'HTTP_410', 410],
    ['500', { status: 500, body: error('boom') }, 'SERVER', 500],
    [
      '串流內回報的 503（#516 翻成 HTTP 錯誤）',
      { inband: error('in-band failure', { type: 'x', code: 503 }) },
      'SERVER',
      503,
    ],
    ['連線被重設', { reset: true }, 'TRANSPORT', undefined],
  ];

  it.each(table)('%s', async (_name, scripted, code, status) => {
    reply = scripted;
    const data = await failedTurn(live());
    expect(data.error).toMatchObject({ code, ...(status !== undefined && { status }) });
    // 沒有狀態的那一類不該憑空多一格 `status`。
    if (status === undefined) expect(data.error).not.toHaveProperty('status');
    // 訊息兩處是同一句：`turn/failed.message` 照舊，`error.message` 不是另一個版本。
    expect(data.error?.message).toBe(data.message);
  });

  it('端點不回：SDK 逾時是 TIMEOUT，不是 TRANSPORT（原本認不出那個名字）', async () => {
    reply = { hang: true };
    const data = await failedTurn(live(300));
    expect(data.error?.code).toBe('TIMEOUT');
  });

  it('不是供應商的錯（模型那一格拋了個普通的錯）是 UNKNOWN，不是 TRANSPORT', async () => {
    const data = await failedTurn(
      new ScriptedChatModel({ turns: [{ content: '', error: '腳本裡的錯' }] }),
    );
    expect(data.error).toEqual({ message: data.message, code: 'UNKNOWN' });
  });
});

describe('軌跡投影讀得到這個碼（#1115 之後補上）', () => {
  it('真的失敗的那一輪：投影的 failureCode 就是日誌上 turn/failed 的 error.code', async () => {
    reply = {
      status: 429,
      body: error('You exceeded your current quota', {
        type: 'insufficient_quota',
        code: 'insufficient_quota',
      }),
    };
    const events = await failedLog(live());
    let state = initialTrajectory();
    for (const event of events) state = applyTrajectory(state, event);
    const view = viewTrajectory(state);
    expect(view.turns).toHaveLength(1);
    expect(view.turns[0]).toMatchObject({ end: 'failed', failureCode: 'QUOTA' });
    // 同一份日誌上的碼，不是投影自己猜的。
    const logged = events.find((event) => event.type === 'turn/failed')
      ?.data as SessionEventMap['turn/failed'];
    expect(view.turns[0]?.failureCode).toBe(logged.error?.code);
  });
});

describe('另外三個寫入點', () => {
  it('CLI（runTurn）：同一份分類——401 是 AUTH，不是 UNKNOWN', async () => {
    reply = { status: 401, body: error('Invalid API key', { code: 'invalid_api_key' }) };
    const built = await createNexusAgent({
      model: live(),
      checkpointer: new MemorySaver(),
      plugins: [],
    });
    const log = new SessionLog('cli-turn-failed-code');
    const printer = { log: () => undefined, error: () => undefined };
    try {
      await expect(runTurn(built.agent, '嗨', printer, log)).rejects.toThrow();
    } finally {
      await built.dispose();
    }
    const failed = log.events.filter((event) => event.type === 'turn/failed');
    expect(failed).toHaveLength(1);
    expect((failed[0]!.data as SessionEventMap['turn/failed']).error).toMatchObject({
      code: 'AUTH',
      status: 401,
    });
  });
});

describe('classifyTurnFailure 本身', () => {
  it('抓得住的邊界：沒有 `status` 的非 Error 值也不拋，是 UNKNOWN', () => {
    expect(classifyTurnFailure('字串')).toEqual({ message: '字串', code: 'UNKNOWN' });
    expect(classifyTurnFailure(undefined)).toEqual({ message: 'undefined', code: 'UNKNOWN' });
  });
});
