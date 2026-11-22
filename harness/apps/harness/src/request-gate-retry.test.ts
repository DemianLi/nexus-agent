/**
 * 全機模型請求並行閘與 #1427 重試政策的界線（[#1505](https://github.com/DemianLi/nexus-agent/issues/1505)）。
 *
 * - **每一次嘗試各自取、各自放**：429 之後的退避那段時間不占名額，別的請求可以在這段時間通過；重打前重新排隊。
 * - **排隊不算重試**：排隊逾時是本機碼，沒有送請求、不經 `noteStreamFailure`，所以重試那一層看不到它、不重打、不寫 `llm/retry`。
 *
 * 做法同 `live-model-retry-events.test.ts`：真的 `createLiveModel` 放進 `retryModelCall`／真的 `createNexusAgent` 跑，對手方是本機假端點。
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { MemorySaver } from '@langchain/langgraph';
import { retryModelCall } from '@nexus/core';
import type { SessionEvent, SessionEventMap } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { createLiveModel, LIVE_API_KEY_ENV } from './live-model.js';
import { LOCAL_CAPACITY_CODE, RequestGate } from './request-gate.js';
import { liveModelConfigSchema, streamRetryOptionsOf } from './settings/live-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

let server: Server;
let baseUrl: string;
/** 到端點的請求，依序記下是誰（訊息文字）。 */
let arrivals: string[];
/** 第一個到端點的請求回 429，之後的都回 200。 */
let firstIs429: boolean;
let savedKey: string | undefined;

beforeEach(async () => {
  arrivals = [];
  firstIs429 = false;
  savedKey = process.env[LIVE_API_KEY_ENV];
  process.env[LIVE_API_KEY_ENV] = 'nvapi-test-value-not-a-real-key';
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        messages: { role: string; content: unknown }[];
      };
      const last = body.messages.at(-1);
      arrivals.push(typeof last?.content === 'string' ? last.content : '?');
      if (firstIs429 && arrivals.length === 1) {
        response.writeHead(429, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Rate limit reached', code: 'x' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'r',
          object: 'chat.completion',
          created: 0,
          model: 'fake',
          choices: [
            { index: 0, message: { role: 'assistant', content: '好' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1`;
});

afterEach(async () => {
  if (savedKey === undefined) delete process.env[LIVE_API_KEY_ENV];
  else process.env[LIVE_API_KEY_ENV] = savedKey;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const config = (maxRetries: number, initialDelayMs: number) =>
  liveModelConfigSchema.parse({
    baseUrl,
    retryPolicy: {
      mode: 'normal',
      maxRetries,
      backoff: { initialDelayMs, maxDelayMs: 2_000, jitterRatio: 0 },
    },
  });

const until = async (condition: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe('每一次嘗試各自取、各自放', () => {
  it('429 之後的退避那段時間不占名額：別的請求可以在 A 退避時通過，A 重打前重新排隊', async () => {
    firstIs429 = true;
    const gate = new RequestGate({ maxConcurrent: 1, maxWaitMs: 10_000 });
    const live = config(1, 600);
    const model = createLiveModel(live, undefined, undefined, { requestGate: gate });

    // A 在重試迴圈裡：第一次嘗試回 429，退避 600 毫秒後重打。
    const a = retryModelCall(streamRetryOptionsOf(live.retryPolicy), {}, () => model.invoke('A'));
    await until(() => arrivals.length === 1, 'A 的第一次嘗試到端點（回 429）');
    // A 正在退避：名額應該已經還了。B 這時進來，要能立刻通過。
    await until(() => gate.active === 0, 'A 退避時名額已還');
    await model.invoke('B');
    expect(arrivals).toEqual(['A', 'B']);
    await a;
    // A 重打：重新排隊、拿到名額、到端點。
    expect(arrivals).toEqual(['A', 'B', 'A']);
    expect(gate.active).toBe(0);
  });
});

describe('排隊不算重試', () => {
  /** 組一個帶重試 middleware 的 agent，跑一輪、讓它失敗，回 pump 的整份日誌事件。 */
  async function runTurnWith(gate: RequestGate, maxRetries: number): Promise<SessionEvent[]> {
    const live = config(maxRetries, 20);
    const built = await createNexusAgent({
      model: createLiveModel(live, undefined, undefined, { requestGate: gate }),
      checkpointer: new MemorySaver(),
      plugins: [],
      streamRetry: streamRetryOptionsOf(live.retryPolicy),
    });
    const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'request-gate-retry');
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

  it('排隊等超過 maxWaitMs：這一輪以 LOCAL_CAPACITY 失敗；端點沒收到請求、沒有 llm/retry、只排一次隊（warn 一行）', async () => {
    const warnings: string[] = [];
    const gate = new RequestGate({
      maxConcurrent: 1,
      maxWaitMs: 150,
      warn: (line) => warnings.push(line),
    });
    // 名額被別人占著，整段時間都沒還。
    const occupied = await gate.acquire();
    const events = await runTurnWith(gate, 3);
    occupied();

    const failed = events.filter((event) => event.type === 'turn/failed');
    expect(failed).toHaveLength(1);
    const data = failed[0]!.data as SessionEventMap['turn/failed'];
    expect(data.error).toMatchObject({ code: LOCAL_CAPACITY_CODE });
    expect(data.error).not.toHaveProperty('status');
    expect(arrivals).toEqual([]);
    expect(events.filter((event) => event.type === 'llm/retry')).toEqual([]);
    expect(events.filter((event) => event.type === 'llm/retry-started')).toEqual([]);
    // 排了一次隊、逾時一次：要是被當成可重試，會再排 3 次、warn 4 行。
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('上限 1');
    expect(gate.waiting).toBe(0);
    expect(gate.active).toBe(0);
  }, 30_000);

  it('名額空著：同一條路徑正常跑完，端點收到一個請求', async () => {
    const gate = new RequestGate({ maxConcurrent: 1, maxWaitMs: 150 });
    const events = await runTurnWith(gate, 3);
    expect(events.filter((event) => event.type === 'turn/failed')).toEqual([]);
    expect(arrivals).toHaveLength(1);
    expect(gate.active).toBe(0);
  }, 30_000);
});
