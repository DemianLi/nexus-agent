/**
 * 掛了全機並行閘的 `ChatOpenAI` 子類（[#1505](https://github.com/DemianLi/nexus-agent/issues/1505)）。對手方是本機假端點：
 * 它把每個請求握住不放，記「同時有幾條連線」，測試決定什麼時候放哪一個。
 *
 * 基座有三條出請求的路（`invoke`→`_generate`、`stream`→`_streamResponseChunks`、v3 的 `_streamChatModelEvents`），加上
 * `withConfig`／`bindTools` 會重建實例——**每一條都得過閘**，漏一條，那一條路上的請求就不受管。
 * 所有「上限 1」的測試同時是防重入死鎖的測試：若子類的方法內部又走回子類的方法，這些測試會卡死、由逾時抓到。
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AttachmentChatOpenAI } from './attachment-chat-openai.js';
import { GatedChatOpenAI } from './gated-chat-openai.js';
import { LocalCapacityError, RequestGate } from './request-gate.js';

interface Held {
  readonly stream: boolean;
  readonly res: ServerResponse;
  finish(): void;
}

let server: Server;
let held: Held[];
let inflight: number;
let maxInflight: number;
let requestCount: number;

const completionChunk = (delta: Record<string, unknown>, finish: string | null = null): string =>
  `data: ${JSON.stringify({
    id: 'r',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'fake',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

beforeEach(async () => {
  held = [];
  inflight = 0;
  maxInflight = 0;
  requestCount = 0;
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const stream = (JSON.parse(body) as { stream?: boolean }).stream === true;
      requestCount += 1;
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      res.on('close', () => {
        inflight -= 1;
      });
      if (stream) {
        // 先吐第一段，讓串流處在「進行中」；剩下的握著，等測試放。
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(completionChunk({ role: 'assistant', content: 'hi' }));
        held.push({
          stream,
          res,
          finish: () => {
            res.write(completionChunk({}, 'stop'));
            res.end('data: [DONE]\n\n');
          },
        });
        return;
      }
      held.push({
        stream,
        res,
        finish: () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'r',
              object: 'chat.completion',
              created: 0,
              model: 'fake',
              choices: [
                { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
              ],
            }),
          );
        },
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
});

afterEach(async () => {
  for (const request of held) request.res.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function model(gate?: RequestGate, extra: { streaming?: boolean } = {}): GatedChatOpenAI {
  const { port } = server.address() as AddressInfo;
  return new GatedChatOpenAI(
    {
      model: 'fake',
      apiKey: 'sk-loopback',
      maxRetries: 0,
      ...extra,
      configuration: { baseURL: `http://127.0.0.1:${port}/v1` },
    },
    gate,
  );
}

const ask = (): BaseMessage[] => [new HumanMessage('hi')];

/** 輪詢到條件成立；逾時就拋（防重入死鎖時由這裡抓到）。 */
async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 給「還沒到」的斷言一點時間：確認這段時間內端點沒有收到請求。 */
const quiet = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 80));

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const chunk of iterable) void chunk;
}

describe('三條出請求的路都過閘', () => {
  it('invoke（_generate）：上限 2，三個請求端點最多同時看到 2 條，第一個結束第三個才送出', async () => {
    const gate = new RequestGate({ maxConcurrent: 2, maxWaitMs: 5_000 });
    const llm = model(gate);
    const calls = [0, 1, 2].map(() => llm.invoke(ask()));
    await until(() => requestCount === 2, '前兩個請求到端點');
    await quiet();
    expect(requestCount).toBe(2);
    expect(gate.waiting).toBe(1);
    held[0]!.finish();
    await until(() => requestCount === 3, '第三個請求在第一個結束後才到端點');
    held[1]!.finish();
    held[2]!.finish();
    await Promise.all(calls);
    expect(maxInflight).toBe(2);
    expect(gate.active).toBe(0);
  });

  it('stream（_streamResponseChunks）：同上', async () => {
    const gate = new RequestGate({ maxConcurrent: 2, maxWaitMs: 5_000 });
    const llm = model(gate);
    const runs = [0, 1, 2].map(async () => drain(await llm.stream(ask())));
    await until(() => requestCount === 2, '前兩條串流到端點');
    await quiet();
    expect(requestCount).toBe(2);
    held[0]!.finish();
    await until(() => requestCount === 3, '第三條串流在第一條結束後才到端點');
    held[1]!.finish();
    held[2]!.finish();
    await Promise.all(runs);
    expect(maxInflight).toBe(2);
    expect(gate.active).toBe(0);
  });

  it('v3 的事件串流（_streamChatModelEvents）：上限 1，第二個等第一個', async () => {
    const gate = new RequestGate({ maxConcurrent: 1, maxWaitMs: 5_000 });
    const llm = model(gate) as unknown as {
      _streamChatModelEvents(m: BaseMessage[], o: object): AsyncGenerator<unknown>;
    };
    const runs = [0, 1].map(() => drain(llm._streamChatModelEvents(ask(), {})));
    await until(() => requestCount === 1, '第一條到端點');
    await quiet();
    expect(requestCount).toBe(1);
    held[0]!.finish();
    await until(() => requestCount === 2, '第二條在第一條結束後才到端點');
    held[1]!.finish();
    await Promise.all(runs);
    expect(maxInflight).toBe(1);
    expect(gate.active).toBe(0);
  });

  it('streaming: true 的 invoke（_generate 內部走串流）：上限 1 不會自己等自己', async () => {
    const gate = new RequestGate({ maxConcurrent: 1, maxWaitMs: 5_000 });
    const call = model(gate, { streaming: true }).invoke(ask());
    await until(() => requestCount === 1, '請求到端點（沒有卡在重入）');
    held[0]!.finish();
    await call;
    expect(gate.active).toBe(0);
    expect(requestCount).toBe(1);
  });

  it('withConfig／bindTools 建出來的新實例仍是子類、仍帶同一份閘', async () => {
    const gate = new RequestGate({ maxConcurrent: 1, maxWaitMs: 5_000 });
    const llm = model(gate);
    const configured = llm.withConfig({ stop: ['END'] });
    expect(configured).toBeInstanceOf(GatedChatOpenAI);
    expect((configured as unknown as GatedChatOpenAI).requestGate).toBe(gate);
    const bound = llm.bindTools([
      {
        type: 'function',
        function: { name: 't', description: 'd', parameters: { type: 'object', properties: {} } },
      },
    ]) as unknown as { invoke(m: BaseMessage[]): Promise<unknown> };
    // 名額被別人占著：從 bindTools 建出來的實例發的請求不能溜過去。
    const occupied = await gate.acquire();
    const call = bound.invoke(ask());
    await quiet();
    expect(requestCount).toBe(0);
    occupied();
    await until(() => requestCount === 1, '名額還了之後請求才到端點');
    held[0]!.finish();
    await call;
  });

  it('沒給閘就是原本的 ChatOpenAI 行為：請求不排隊', async () => {
    const llm = model(undefined);
    const calls = [0, 1, 2].map(() => llm.invoke(ask()));
    await until(() => requestCount === 3, '三個請求同時到端點');
    for (const request of held) request.finish();
    await Promise.all(calls);
    expect(maxInflight).toBe(3);
  });
});

describe('名額一定還回來', () => {
  // 假端點握著第二段不放：`break` 要能在它到之前回來，而且連線要真的關掉（#1546）。Node 24 上少了 `stream()` 那層中止，`break` 會卡到下一段到。
  it('串流的消費者讀一段就 break：請求中止、連線關掉、名額還回來', async () => {
    const gate = new RequestGate({ maxConcurrent: 1, maxWaitMs: 5_000 });
    const iterable = await model(gate).stream(ask());
    for await (const chunk of iterable) {
      void chunk;
      expect(gate.active).toBe(1);
      expect(inflight).toBe(1);
      break;
    }
    await until(() => gate.active === 0, '消費者丟掉串流後名額還回來');
    await until(() => inflight === 0, '消費者丟掉串流後連線關掉');
  });

  it('串流讀一段之後呼叫 throw()：錯原樣丟回、請求中止、連線關掉、名額還回來', async () => {
    const gate = new RequestGate({ maxConcurrent: 1, maxWaitMs: 5_000 });
    const iterable = await model(gate).stream(ask());
    expect((await iterable.next()).done).toBe(false);
    const thrown = new Error('消費者不要了');
    await expect(iterable.throw(thrown)).rejects.toBe(thrown);
    await until(() => gate.active === 0, 'throw 之後名額還回來');
    await until(() => inflight === 0, 'throw 之後連線關掉');
  });

  it('串流到一半被中止：名額還回來', async () => {
    const gate = new RequestGate({ maxConcurrent: 1, maxWaitMs: 5_000 });
    const controller = new AbortController();
    const run = drain(await model(gate).stream(ask(), { signal: controller.signal })).catch(
      (error: unknown) => error,
    );
    await until(() => requestCount === 1, '串流開始');
    controller.abort(new Error('按了停止'));
    await run;
    await until(() => gate.active === 0, '中止之後名額還回來');
    // 名額沒漏：下一個請求拿得到。
    const next = model(gate).invoke(ask());
    await until(() => requestCount === 2, '下一個請求拿到名額');
    held[1]!.finish();
    await next;
  });

  it('請求失敗：名額還回來', async () => {
    const gate = new RequestGate({ maxConcurrent: 1, maxWaitMs: 5_000 });
    const failing = model(gate)
      .invoke(ask())
      .catch((error: unknown) => error);
    await until(() => requestCount === 1, '請求到端點');
    held[0]!.res.destroy();
    expect(await failing).toBeInstanceOf(Error);
    await until(() => gate.active === 0, '失敗之後名額還回來');
  });
});

describe('排隊中的行為', () => {
  it('排隊時被中止：立刻拋原因、請求從沒送到端點、名額沒漏', async () => {
    const gate = new RequestGate({ maxConcurrent: 1, maxWaitMs: 5_000 });
    const llm = model(gate);
    const first = llm.invoke(ask());
    await until(() => requestCount === 1, '第一個請求到端點');
    const controller = new AbortController();
    const second = llm
      .invoke(ask(), { signal: controller.signal })
      .catch((error: unknown) => error);
    await until(() => gate.waiting === 1, '第二個在排隊');
    controller.abort(new Error('按了停止'));
    expect(((await second) as Error).message).toContain('停止');
    expect(requestCount).toBe(1);
    expect(gate.waiting).toBe(0);
    held[0]!.finish();
    await first;
    expect(gate.active).toBe(0);
  });

  it('排隊等超過 maxWaitMs：以 LocalCapacityError 失敗、請求從沒送到端點', async () => {
    const gate = new RequestGate({ maxConcurrent: 1, maxWaitMs: 60 });
    const llm = model(gate);
    const first = llm.invoke(ask());
    await until(() => requestCount === 1, '第一個請求到端點');
    const error = await llm.invoke(ask()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LocalCapacityError);
    expect(requestCount).toBe(1);
    held[0]!.finish();
    await first;
    expect(gate.active).toBe(0);
  });
});

describe('帶附件投影的子類（AttachmentChatOpenAI）也受閘管，順序是「額度檢查 → 取名額 → 投影」', () => {
  function attachmentModel(
    gate: RequestGate,
    hooks: { project: () => void; guard?: () => void },
  ): AttachmentChatOpenAI {
    const { port } = server.address() as AddressInfo;
    return new AttachmentChatOpenAI(
      {
        model: 'fake',
        apiKey: 'sk-loopback',
        maxRetries: 0,
        configuration: { baseURL: `http://127.0.0.1:${port}/v1` },
      },
      (messages) => {
        hooks.project();
        return Promise.resolve(messages);
      },
      hooks.guard === undefined
        ? undefined
        : () => {
            hooks.guard!();
          },
      gate,
    );
  }

  it('名額被占著時：額度檢查先跑（超額直接拋、不排隊），投影等拿到名額才跑，請求不到端點', async () => {
    const gate = new RequestGate({ maxConcurrent: 1, maxWaitMs: 5_000 });
    const order: string[] = [];
    const llm = attachmentModel(gate, {
      guard: () => order.push('guard'),
      project: () => order.push('project'),
    });
    const occupied = await gate.acquire();
    const call = llm.invoke(ask());
    await quiet();
    // 排隊中：額度檢查已經過了，投影還沒跑，請求還沒送。
    expect(order).toEqual(['guard']);
    expect(requestCount).toBe(0);
    occupied();
    await until(() => requestCount === 1, '拿到名額後請求才到端點');
    expect(order).toEqual(['guard', 'project']);
    held[0]!.finish();
    await call;
    expect(gate.active).toBe(0);
  });

  it('額度超額：直接拋，不占名額、不排隊', async () => {
    const gate = new RequestGate({ maxConcurrent: 1, maxWaitMs: 5_000 });
    const llm = attachmentModel(gate, {
      guard: () => {
        throw new Error('超額');
      },
      project: () => undefined,
    });
    const occupied = await gate.acquire();
    await expect(llm.invoke(ask())).rejects.toThrow('超額');
    expect(gate.waiting).toBe(0);
    occupied();
  });

  it('withConfig／bindTools 之後仍是帶閘的 AttachmentChatOpenAI', async () => {
    const gate = new RequestGate({ maxConcurrent: 1, maxWaitMs: 5_000 });
    const llm = attachmentModel(gate, { project: () => undefined });
    const configured = llm.withConfig({ stop: ['END'] });
    expect(configured).toBeInstanceOf(AttachmentChatOpenAI);
    expect((configured as unknown as AttachmentChatOpenAI).requestGate).toBe(gate);
    const occupied = await gate.acquire();
    const call = (configured as unknown as { invoke(m: BaseMessage[]): Promise<unknown> }).invoke(
      ask(),
    );
    await quiet();
    expect(requestCount).toBe(0);
    occupied();
    await until(() => requestCount === 1, '名額還了之後請求才到端點');
    held[0]!.finish();
    await call;
  });
});
