/**
 * 摘要器生摘要的那一次模型呼叫也算全機並行閘的一個名額（[#1505](https://github.com/DemianLi/nexus-agent/issues/1505)，驗收 4 的後半）。
 *
 * 閘掛在模型類別的呼叫方法上，摘要器的呼叫長在基座的 middleware 裡、不一定經過重試那一層（`maxRetries` 為 0 時重試 middleware 根本不掛，
 * 摘要器自己也有一條繞過 `retryModelCall` 的路）。放在重試層的閘在這裡會失效；這一條就是為了證明放在模型類別上的閘沒有這個洞。
 * 做法：真的 `createLiveModel`（帶閘）＋真的 `createNexusAgent` 的摘要器，端點把摘要請求扣住，量這時閘上有沒有人占著名額。
 *
 * **零憑證、零外部連線。**
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemorySaver } from '@langchain/langgraph';
import { SessionRegistry, SUMMARY_PROMPT } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { createLiveModel, LIVE_API_KEY_ENV } from './live-model.js';
import { toAgentInvocation } from './messages.js';
import { RequestGate } from './request-gate.js';
import { liveModelConfigSchema } from './settings/live-model.js';

/** 摘要那次呼叫的提示詞開頭；用它從請求裡把摘要請求挑出來。 */
const SUMMARY_MARK = SUMMARY_PROMPT.split('\n')[0]!;

let server: Server;
let baseUrl: string;
let dir: string;
let savedKey: string | undefined;
/** 到端點的請求，依序記下是不是摘要請求。 */
let arrivals: boolean[];
/** 扣住的摘要請求：呼叫它才回。 */
let heldSummary: (() => void) | undefined;
/** 摘要請求到了就扣住（`false`＝照常回）。 */
let holdSummary: boolean;

beforeEach(async () => {
  arrivals = [];
  heldSummary = undefined;
  holdSummary = true;
  dir = await mkdtemp(join(tmpdir(), 'nexus-gate-summary-'));
  savedKey = process.env[LIVE_API_KEY_ENV];
  process.env[LIVE_API_KEY_ENV] = 'nvapi-test-value-not-a-real-key';
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        stream?: boolean;
        messages: { content: unknown }[];
      };
      const summary = body.messages.some((message) =>
        JSON.stringify(message.content).includes(SUMMARY_MARK),
      );
      arrivals.push(summary);
      const reply = (): void => {
        const text = summary ? '摘要' : '好';
        if (body.stream !== true) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              id: 'r',
              object: 'chat.completion',
              created: 0,
              model: 'fake',
              choices: [
                { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
          );
          return;
        }
        const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
          `data: ${JSON.stringify({
            id: 'r',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'fake',
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(chunk({ role: 'assistant', content: text }, null));
        response.write(chunk({}, 'stop'));
        response.end('data: [DONE]\n\n');
      };
      if (summary && holdSummary) heldSummary = reply;
      else reply();
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
  await rm(dir, { recursive: true, force: true });
});

const until = async (condition: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 8_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe('摘要器生摘要的那一次呼叫', () => {
  it('maxRetries 為 0（重試 middleware 不掛）也占一個名額；摘要請求被扣住時閘上有人，放掉才還', async () => {
    const gate = new RequestGate({ maxConcurrent: 1, maxWaitMs: 10_000 });
    const live = liveModelConfigSchema.parse({
      baseUrl,
      retryPolicy: { mode: 'normal', maxRetries: 0 },
    });
    const built = await createNexusAgent({
      model: createLiveModel(live, undefined, undefined, { requestGate: gate }),
      checkpointer: new MemorySaver(),
      backend: new ContainedFilesystemBackend({ rootDir: dir, mode: 'workspace-write' }),
      plugins: [],
      // 重試政策與產品一樣：次數為 0 就不傳，重試 middleware 不會掛。
      summarization: { trigger: [{ type: 'messages', value: 3 }], retainTokens: 12 },
      modelLimits: () => ({ contextWindow: 700_045, maxOutputTokens: 16_384 }),
    });
    const sessions = new SessionRegistry('root-1');
    const detach = built.attachSession(sessions, {});
    try {
      const turns = (async () => {
        for (let round = 0; round < 4; round += 1) {
          await built.agent.invoke(toAgentInvocation(`第 ${String(round + 1)} 句。`), {
            configurable: { thread_id: 'thread-1' },
          });
        }
      })();
      await until(() => arrivals.includes(true), '摘要請求到端點（被扣住）');
      // 這一刻主模型的呼叫都已經結束（摘要發生在下一次主呼叫之前），在跑的就是這一個摘要請求。
      expect(gate.active).toBe(1);
      expect(gate.waiting).toBe(0);
      holdSummary = false;
      heldSummary?.();
      await turns;
      expect(gate.active).toBe(0);
    } finally {
      detach();
      await built.dispose();
    }
  }, 60_000);
});
