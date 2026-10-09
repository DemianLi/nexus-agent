/**
 * **產品路徑：串流第一則事件之後才出錯，整次重打，失敗那次作廢**
 * （[#520](https://github.com/DemianLi/nexus-agent/issues/520)）。
 *
 * 一條測試走完整條：假的 SSE 端點 → `createLiveModel`（真的 fetch 包裝層）→ `createNexusAgent` 的重試 middleware →
 * `ThreadPump`（日誌、`message-discard`）→ `@nexus/wire` 的折疊器。只證其中一段的話，另一段接不接得上沒人知道。
 *
 * **零憑證**：對手方是本機的假端點；金鑰是假的，只為了過工廠的「缺 key 當場失敗」。
 */

import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MemorySaver } from '@langchain/langgraph';
import type { SessionEventMap } from '@nexus/core';
import { emptyConversation, MESSAGE_DISCARD, reduceConversation } from '@nexus/wire';
import type { AiEntry, Event } from '@nexus/wire';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { createLiveModel, LIVE_API_KEY_ENV } from './live-model.js';
import { liveModelConfigSchema } from './settings/live-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

/** 第 n 次請求端點要演哪一齣。 */
type Act =
  /** 吐完整個回覆（丙丁）並正常收尾。 */
  | 'ok'
  /** 吐兩個字（甲乙）之後送一個 503 的錯誤事件。 */
  | 'mid503'
  /** 吐兩個字之後送一個 400 的錯誤事件（請求本身有問題，重打沒用）。 */
  | 'mid400'
  /** 吐兩個字之後把連線掐斷。 */
  | 'cut'
  /** 吐兩個字之後停住。 */
  | 'stall'
  /** 第一則事件就是 503 的錯誤（第一則事件之前，歸 SDK 層管）。 */
  | 'first503';

/** 每個 chunk 帶所屬請求的編號當 id：兩次嘗試的 id 不同，作廢記號指對了哪一則才分得出來。 */
const chunk = (id: string, delta: Record<string, unknown>, finish: string | null = null): string =>
  `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: 0,
    model: 'fake',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

const envelope = (code: number): string =>
  `data: ${JSON.stringify({ error: { message: '上游出事了', type: 'upstream', code } })}\n\n`;

/** 照劇本演的假 OpenAI 端點。劇本用完之後的請求一律演 `ok`。 */
async function scriptedOpenAi(script: readonly Act[]) {
  let hits = 0;
  const server = createServer((req, res: ServerResponse) => {
    const act = script[hits] ?? 'ok';
    hits += 1;
    const id = `chatcmpl-${hits}`;
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (act === 'first503') {
      res.write(envelope(503));
      res.end('data: [DONE]\n\n');
      return;
    }
    res.write(chunk(id, { role: 'assistant', content: '' }));
    if (act === 'ok') {
      res.write(chunk(id, { content: '丙' }));
      res.write(chunk(id, { content: '丁' }));
      res.write(chunk(id, {}, 'stop'));
      res.end('data: [DONE]\n\n');
      return;
    }
    res.write(chunk(id, { content: '甲' }));
    res.write(chunk(id, { content: '乙' }));
    if (act === 'stall') return;
    if (act === 'cut') {
      setTimeout(() => res.socket?.destroy(), 30);
      return;
    }
    setTimeout(() => {
      res.write(envelope(act === 'mid400' ? 400 : 503));
      res.end('data: [DONE]\n\n');
    }, 30);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    hits: () => hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

interface RunOptions {
  /** 預算；省略就是不給（等於不重打）。 */
  readonly streamRetry?: { maxRetries: number; baseDelayMs: number };
  /** SDK 層的重試次數（第一則事件之前的失敗）。 */
  readonly sdkRetries?: number;
  /** 這一輪跑著的時候同時跑的東西（例如在特定時刻按停止）。 */
  readonly during?: (pump: ThreadPump) => Promise<void>;
}

/** 起一個 pump 跑一輪，回頭交出日誌、線上 frame 與 `submit` 拋出的東西。 */
async function runTurn(script: readonly Act[], options: RunOptions = {}) {
  const upstream = await scriptedOpenAi(script);
  const built = await createNexusAgent({
    model: createLiveModel(
      liveModelConfigSchema.parse({
        baseUrl: upstream.baseUrl,
        timeoutMs: 400,
        maxRetries: options.sdkRetries ?? 0,
      }),
    ),
    checkpointer: new MemorySaver(),
    plugins: [],
    ...(options.streamRetry !== undefined && { streamRetry: options.streamRetry }),
  });
  const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'stream-retry');
  const detach = built.attachSession(pump.sessions);
  const frames: Event[] = [];
  const line = new AbortController();
  const draining = (async () => {
    for await (const frame of pump.subscribe(['messages', 'lifecycle', 'custom'], line.signal))
      frames.push(frame);
  })();
  try {
    const turn = pump.submit({ kind: 'message', text: '說點什麼' }).then(
      () => undefined,
      (error: unknown) => error,
    );
    const [thrown] = await Promise.all([turn, options.during?.(pump)]);
    return {
      thrown,
      frames,
      events: pump.sessions.root.events,
      hits: upstream.hits(),
    };
  } finally {
    line.abort();
    await draining;
    detach();
    await upstream.close();
  }
}

/** 一組 frame 折出來的助手回覆（照畫面的折疊器，不是自己算）。 */
function shownReplies(frames: readonly Event[]): AiEntry[] {
  let state = emptyConversation();
  for (const frame of frames) state = reduceConversation(state, frame);
  return state.entries.filter((entry): entry is AiEntry => entry.kind === 'ai');
}

const BUDGET = { maxRetries: 2, baseDelayMs: 20 } as const;

describe('串流第一則事件之後才出錯（#520）', () => {
  const original = process.env[LIVE_API_KEY_ENV];
  beforeEach(() => {
    process.env[LIVE_API_KEY_ENV] = 'nvapi-test-value-not-a-real-key';
  });
  afterEach(() => {
    if (original === undefined) delete process.env[LIVE_API_KEY_ENV];
    else process.env[LIVE_API_KEY_ENV] = original;
  });

  it.each([
    ['中段的錯誤事件（503）', 'mid503'],
    ['連線中途斷掉', 'cut'],
    ['吐了內容之後停住', 'stall'],
  ] as const)(
    '%s：整次重打，這一輪成功，畫面只剩第二次的回覆',
    async (_label, act) => {
      const run = await runTurn([act], { streamRetry: BUDGET });
      expect(run.thrown).toBeUndefined();
      expect(run.hits).toBe(2);

      // 日誌：兩對起訖，失敗那次帶 outcome，作廢的那半段留在 assistant/attempt，最後只有一則正常回覆。
      const types = run.events.map((event) => event.type);
      expect(types.filter((type) => type === 'model/start')).toHaveLength(2);
      expect(types.filter((type) => type === 'turn/failed')).toHaveLength(0);
      const ends = run.events.filter((event) => event.type === 'model/end');
      expect(ends.map((event) => (event.data as SessionEventMap['model/end']).outcome)).toEqual([
        'error',
        undefined,
      ]);
      const attempts = run.events.filter((event) => event.type === 'assistant/attempt');
      expect(attempts).toHaveLength(1);
      const attempt = attempts[0]!;
      expect(
        JSON.stringify((attempt.data as SessionEventMap['assistant/attempt']).message),
      ).toContain('甲乙');
      // 作廢的是第一次呼叫：指回第一顆 model/start。
      const firstStart = run.events.find((event) => event.type === 'model/start')!;
      expect((attempt.data as SessionEventMap['assistant/attempt']).modelCall).toBe(firstStart.seq);
      expect(attempt.ignorable).toBe(true);
      const messages = run.events.filter((event) => event.type === 'assistant/message');
      expect(messages).toHaveLength(1);
      expect(JSON.stringify(messages[0]!.data)).toContain('丙丁');

      // 線上：作廢記號在第二次的 message-start 之前，酬載指著第一則；折疊之後畫面只剩第二則。
      const discards = run.frames.filter(
        (frame) =>
          frame.method === 'custom' &&
          (frame.params.data as { name?: string } | null)?.name === MESSAGE_DISCARD,
      );
      expect(discards).toHaveLength(1);
      const starts = run.frames.filter(
        (frame) =>
          frame.method === 'messages' &&
          (frame.params.data as { event?: string }).event === 'message-start',
      );
      expect(starts).toHaveLength(2);
      expect(starts[0]!.seq!).toBeLessThan(discards[0]!.seq!);
      expect(discards[0]!.seq!).toBeLessThan(starts[1]!.seq!);
      const keyOf = (frame: Event): string => {
        const data = frame.params.data as { run_id?: string; id?: string };
        return data.run_id ?? data.id!;
      };
      const discarded = (discards[0]!.params.data as { payload: { messageId: string } }).payload
        .messageId;
      // 兩次嘗試是兩個不同的 id；作廢指的是第一則，不是存活的那一則。
      expect(keyOf(starts[0]!)).not.toBe(keyOf(starts[1]!));
      expect(discarded).toBe(keyOf(starts[0]!));
      expect(discarded).not.toBe(keyOf(starts[1]!));
      const shown = shownReplies(run.frames);
      expect(shown.map((entry) => entry.text)).toEqual(['丙丁']);
      expect(shown.map((entry) => entry.id)).toEqual([keyOf(starts[1]!)]);
    },
    30_000,
  );

  it('預算用完還是失敗：打了 1 + 2 次，每一次作廢都留下記號，最後一次的錯誤照原樣往外拋', async () => {
    const run = await runTurn(['mid503', 'mid503', 'mid503'], { streamRetry: BUDGET });
    expect(run.hits).toBe(3);
    expect(run.thrown).toBeInstanceOf(Error);
    expect(run.events.filter((event) => event.type === 'turn/failed')).toHaveLength(1);
    expect(run.events.filter((event) => event.type === 'assistant/attempt')).toHaveLength(2);
    expect(run.events.filter((event) => event.type === 'model/start')).toHaveLength(3);
    // 最後一次吐的那半段沒有人作廢它，維持今天的行為（畫面上留著斷尾的回覆，輪次標失敗）。
    expect(shownReplies(run.frames).map((entry) => entry.text)).toEqual(['甲乙']);
  }, 30_000);

  it('請求本身有問題（400）：不重打', async () => {
    const run = await runTurn(['mid400', 'ok'], { streamRetry: BUDGET });
    expect(run.hits).toBe(1);
    expect(run.thrown).toBeInstanceOf(Error);
    expect(run.events.filter((event) => event.type === 'assistant/attempt')).toHaveLength(0);
  }, 30_000);

  it('沒給預算（出廠之外的呼叫端、maxRetries 0）：維持只打一次', async () => {
    const none = await runTurn(['mid503', 'ok']);
    expect(none.hits).toBe(1);
    expect(none.thrown).toBeInstanceOf(Error);
    const zero = await runTurn(['mid503', 'ok'], {
      streamRetry: { maxRetries: 0, baseDelayMs: 20 },
    });
    expect(zero.hits).toBe(1);
    expect(zero.thrown).toBeInstanceOf(Error);
  }, 30_000);

  it('等重打的退避時按了停止：不再打，輪次收成中止，失敗那次的半段記成 attempt、不存回對話', async () => {
    const run = await runTurn(['mid503', 'ok'], {
      // 退避拉到 30 秒：按停止時一定還在等。
      streamRetry: { maxRetries: 2, baseDelayMs: 30_000 },
      during: async (pump) => {
        // 等到第一次嘗試失敗收尾（model/end 帶 error），這時就在退避裡。
        for (let waited = 0; waited < 10_000; waited += 20) {
          const failed = pump.sessions.root.events.some(
            (event) =>
              event.type === 'model/end' &&
              (event.data as SessionEventMap['model/end']).outcome === 'error',
          );
          if (failed) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(pump.cancel()).toBe('run');
      },
    });
    // 一路上只打過一次，輪次以中止收尾，不是失敗。
    expect(run.hits).toBe(1);
    const ends = run.events.filter((event) => event.type === 'turn/end');
    expect(ends).toHaveLength(1);
    expect(ends[0]!.data).toMatchObject({ reason: { kind: 'aborted', cause: { kind: 'user' } } });
    expect(run.events.filter((event) => event.type === 'turn/failed')).toHaveLength(0);
    // 失敗那次的半段：記成 attempt、畫面擦掉；不是被打斷的回覆（那會進對話歷史，下一輪模型看得到）。
    expect(run.events.filter((event) => event.type === 'assistant/attempt')).toHaveLength(1);
    expect(run.events.filter((event) => event.type === 'assistant/message')).toHaveLength(0);
    expect(shownReplies(run.frames)).toEqual([]);
  }, 30_000);

  it('第一則事件就是錯誤的：歸 SDK 層，不跟串流重試相乘', async () => {
    // SDK 重試 1 次（1–2 秒退避）；兩次都在第一則事件失敗。串流重試的預算是 2，但它不該被叫到。
    const run = await runTurn(['first503', 'first503', 'first503', 'first503'], {
      streamRetry: BUDGET,
      sdkRetries: 1,
    });
    expect(run.hits).toBe(2);
    expect(run.thrown).toBeInstanceOf(Error);
    expect(run.events.filter((event) => event.type === 'assistant/attempt')).toHaveLength(0);
  }, 30_000);
});
