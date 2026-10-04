/**
 * **失敗與中止的模型呼叫也進帳**——[#1022](https://github.com/DemianLi/nexus-agent/issues/1022) 的驗收，量的是產品那條路：
 * 真的 `createLiveModel`（串流、疊著 SSE 用量嗅探）接本機的假端點，經 `ThreadPump` 跑一輪，再讀 root 日誌、
 * 即時 frame 與歷史頁。
 *
 * 規則（什麼時候記、記不進去會怎樣）在 `packages/nexus-core/src/model-usage.test.ts`。這裡量三件事：
 *
 * 1. 供應商在串流裡報了用量、之後斷線：記一筆帶 `outcome` 的 `model/usage`，數字原樣，總帳加上它。
 * 2. 供應商沒報：**沒有** `model/usage`——不是 0；`model/end.outcome` 表態那次呼叫沒有正常回來。「未知」與 0 分得開。
 * 3. 使用者按了停止：同上，`outcome` 是 `aborted`。
 *
 * 另外釘：總帳與「目前大小」即時與歷史一致（失敗的呼叫在兩處都算一筆樣本，同 dsh）。
 *
 * **零憑證**：對手方是本機的假端點。
 */

import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MemorySaver } from '@langchain/langgraph';
import { deriveTokenUsage } from '@nexus/core';
import type { SessionEvent, SessionEventMap } from '@nexus/core';
import type { Event } from '@nexus/wire';
import { emptyConversation, reduceAll } from '@nexus/wire';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { historyPage } from './conversation-history.js';
import { createLiveModel, LIVE_API_KEY_ENV } from './live-model.js';
import { liveModelConfigSchema } from './settings/live-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

/** 假端點這一次請求怎麼收場。 */
type Ending =
  /** 正文、用量那一顆之後斷線（socket 被砍，沒有 `[DONE]`）。 */
  | 'break-after-usage'
  /** 同上，但前面每一顆片段都帶 `"usage": null`——真的 OpenAI 相容端點開了 `include_usage` 之後就是這樣。 */
  | 'break-after-usage-null-chunks'
  /** 正文之後斷線，供應商還沒報用量。 */
  | 'break-before-usage'
  /** 正文、用量之後不收尾，等使用者按停止。 */
  | 'hold-after-usage'
  /** 正文之後不收尾也沒報用量，等使用者按停止。 */
  | 'hold-before-usage';

/** 假端點報的那組數字：三個兩兩不同，且 `total` 刻意不等於 `input + output`（我們不替供應商加總）。 */
const REPORTED = { prompt_tokens: 321, completion_tokens: 45, total_tokens: 400 };

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let ending: Ending;
let savedKey: string | undefined;
const bodies: { stream_options?: { include_usage?: boolean } }[] = [];

function finish(res: ServerResponse, how: Ending): void {
  const id = 'chatcmpl-failed';
  const nulls = how === 'break-after-usage-null-chunks';
  const chunk = (extra: Record<string, unknown>) =>
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: 'fake', ...('usage' in extra || !nulls ? {} : { usage: null }), ...extra })}\n\n`;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }));
  res.write(
    chunk({ choices: [{ index: 0, delta: { content: '說到一半' }, finish_reason: null }] }),
  );
  if (how.includes('after-usage')) res.write(chunk({ choices: [], usage: REPORTED }));
  if (how.startsWith('break')) {
    // 等寫出去的位元組到了對面再砍，不然「用量那一顆」可能還在送出緩衝裡就被丟掉。
    setTimeout(() => res.socket?.destroy(), 60);
  }
  // `hold-*`：什麼都不做，連線一直開著，直到客戶端自己切斷。
}

beforeEach(async () => {
  bodies.length = 0;
  savedKey = process.env[LIVE_API_KEY_ENV];
  process.env[LIVE_API_KEY_ENV] = 'fake-key-for-loopback';
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (part: Buffer) => (raw += part.toString()));
    req.on('end', () => {
      bodies.push(JSON.parse(raw) as (typeof bodies)[number]);
      finish(res, ending);
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterEach(async () => {
  if (savedKey === undefined) delete process.env[LIVE_API_KEY_ENV];
  else process.env[LIVE_API_KEY_ENV] = savedKey;
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
});

const isRootDone = (frame: Event): boolean =>
  frame.method === 'lifecycle' &&
  frame.params.namespace.length === 0 &&
  ['completed', 'failed'].includes(String((frame.params.data as { event?: unknown }).event));

async function until(predicate: () => boolean, ms = 15_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 經 pump 跑一輪：`stopAfterText` 為真就等正文上線之後按停止；否則等這一輪自己收（斷線那種）。 */
async function runTurn(stopAfterText: boolean) {
  const built = await createNexusAgent({
    model: createLiveModel(liveModelConfigSchema.parse({ baseUrl, maxRetries: 0 })),
    checkpointer: new MemorySaver(),
    plugins: [],
  });
  const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'failed-usage');
  const detach = built.attachSession(pump.sessions);
  const frames: Event[] = [];
  const line = new AbortController();
  const stream = pump.subscribe(['messages', 'tools', 'lifecycle', 'custom'], line.signal);
  const draining = (async () => {
    for await (const frame of stream) frames.push(frame);
  })();
  try {
    const turn = pump.submit({ kind: 'message', text: '說點什麼' }).catch(() => undefined);
    if (stopAfterText) {
      await until(() => JSON.stringify(frames).includes('說到一半'));
      // 用量那一顆（若有）要先到對面，才不是「按停止的同一刻它還在路上」。
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(pump.cancel()).toBe('run');
    }
    await turn;
    await until(() => frames.some(isRootDone));
    await new Promise((resolve) => setImmediate(resolve));
    return { frames, root: pump.sessionLog.events };
  } finally {
    line.abort();
    await draining;
    detach();
    await built.dispose();
  }
}

const eventsOf = <T extends keyof SessionEventMap>(events: readonly SessionEvent[], type: T) =>
  events.filter((event) => event.type === type).map((event) => event.data as SessionEventMap[T]);

const LEDGER = { inputTokens: 321, outputTokens: 45 };

describe('供應商報了用量、呼叫之後沒有正常回來', () => {
  it('斷線：記一筆 error 的 model/usage（數字原樣），model/end 同樣標 error，總帳加上它，即時與歷史一致', async () => {
    ending = 'break-after-usage';
    const { frames, root } = await runTurn(false);

    // 前提：請求真的要了串流用量，不然「沒報」只是我們沒開。
    expect(bodies[0]?.stream_options?.include_usage).toBe(true);
    const usage = eventsOf(root, 'model/usage');
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      inputTokens: 321,
      outputTokens: 45,
      totalTokens: 400,
      outcome: 'error',
    });
    // 歸給那次呼叫：識別就是 model/start 的 seq，model/end 指回同一個。
    const start = root.find((event) => event.type === 'model/start')!;
    expect(usage[0]?.modelCall).toBe(start.seq);
    expect(eventsOf(root, 'model/end')).toEqual([{ modelCall: start.seq, outcome: 'error' }]);

    expect(deriveTokenUsage(root)).toEqual(LEDGER);
    expect(reduceAll(emptyConversation(), frames).tokenUsage).toEqual(LEDGER);
    expect(reduceAll(emptyConversation(), historyPage(root).events).tokenUsage).toEqual(LEDGER);

    // 「目前大小」：失敗的那份請求也是一筆樣本（同 dsh 的 `contextPressure`，連 `assistant/attempt` 的用量也取樣），
    // 即時與歷史兩條路拿到同一個數。
    expect(reduceAll(emptyConversation(), frames).contextPressure?.inputTokens).toBe(321);
    expect(
      reduceAll(emptyConversation(), historyPage(root).events).contextPressure?.inputTokens,
    ).toBe(321);
  }, 30_000);

  it('中間每顆片段都帶 usage: null：null 不覆蓋，以最後一個有數字的為準', async () => {
    ending = 'break-after-usage-null-chunks';
    const { root } = await runTurn(false);

    expect(eventsOf(root, 'model/usage')).toEqual([
      expect.objectContaining({
        inputTokens: 321,
        outputTokens: 45,
        totalTokens: 400,
        outcome: 'error',
      }),
    ]);
  }, 30_000);

  it('使用者按了停止：同樣記下，outcome 是 aborted', async () => {
    ending = 'hold-after-usage';
    const { frames, root } = await runTurn(true);

    expect(eventsOf(root, 'model/usage')).toEqual([
      expect.objectContaining({
        inputTokens: 321,
        outputTokens: 45,
        totalTokens: 400,
        outcome: 'aborted',
      }),
    ]);
    expect(eventsOf(root, 'model/end')).toEqual([expect.objectContaining({ outcome: 'aborted' })]);
    expect(deriveTokenUsage(root)).toEqual(LEDGER);
    expect(reduceAll(emptyConversation(), frames).tokenUsage).toEqual(LEDGER);
    expect(reduceAll(emptyConversation(), historyPage(root).events).tokenUsage).toEqual(LEDGER);
  }, 30_000);
});

describe('供應商沒報用量：未知，不是 0', () => {
  it('斷線：沒有 model/usage，總帳不動，model/end 標 error——分得出「沒報」與「報了 0」', async () => {
    ending = 'break-before-usage';
    const { frames, root } = await runTurn(false);

    expect(eventsOf(root, 'model/usage')).toEqual([]);
    expect(eventsOf(root, 'model/end')).toEqual([expect.objectContaining({ outcome: 'error' })]);
    expect(deriveTokenUsage(root)).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(reduceAll(emptyConversation(), frames).tokenUsage).toBeNull();
  }, 30_000);

  it('按停止：同上，outcome 是 aborted', async () => {
    ending = 'hold-before-usage';
    const { root } = await runTurn(true);

    expect(eventsOf(root, 'model/usage')).toEqual([]);
    expect(eventsOf(root, 'model/end')).toEqual([expect.objectContaining({ outcome: 'aborted' })]);
  }, 30_000);
});
