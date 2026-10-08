/**
 * **token 帳分四桶：未快取輸入、輸出、快取讀、快取寫**——
 * [#724](https://github.com/DemianLi/nexus-agent/issues/724) 的 harness 那一半。
 *
 * 真的圖、真的 pump，模型是腳本、每一次呼叫報一組用量（含快取細節）。每個案例比三條路：日誌本身、即時的 frame、
 * 重新整理拿到的歷史，三者折出來的 `tokenUsage` 要相等；壓力那格的「目前多大」要和沒有快取的同一段對話**同一個數**
 * （它量的是完整 prompt，不隨快取分桶而變）。
 *
 * 缺席是「沒記」不是 0；報得自相矛盾的整筆不記。規則本身（哪些數字收、哪些不收）在 core 的
 * `model-usage.test.ts`，這裡量的是走完產品路徑之後線上看得到什麼。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`，測試不碰真的 `~/.nexus-agent`。
 */

import { MemorySaver } from '@langchain/langgraph';
import type { SessionEvent } from '@nexus/core';
import { deriveTokenUsage, SESSION_LOG_FORMAT_VERSION } from '@nexus/core';
import type { Event } from '@nexus/wire';
import { emptyConversation, reduceAll } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { historyPage } from './conversation-history.js';
import type { ScriptedTurn, ScriptedUsage } from './scripted-model.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import { ThreadPump } from './thread-pump.js';

async function runTurns(turns: ScriptedTurn[]) {
  const built = await createNexusAgent({
    model: new ScriptedChatModel({ turns }) as never,
    checkpointer: new MemorySaver(),
    plugins: [],
    summarization: false,
    observationPolicy: false,
  });
  const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'cache-buckets');
  const detach = built.attachSession(pump.sessions);
  const frames: Event[] = [];
  const line = new AbortController();
  const stream = pump.subscribe(['messages', 'tools', 'lifecycle', 'custom'], line.signal);
  const draining = (async () => {
    for await (const frame of stream) frames.push(frame);
  })();
  try {
    for (const [index] of turns.entries()) {
      await pump.submit({ kind: 'message', text: `第 ${index + 1} 句` });
    }
    // 日誌訂閱者合成的 frame 跟收工那一顆不在同一個 tick。
    await new Promise((resolve) => setImmediate(resolve));
    return { frames, root: [...pump.sessionLog.events] };
  } finally {
    line.abort();
    await draining;
    detach();
    await built.dispose();
  }
}

const usageEvents = (events: readonly SessionEvent[]) =>
  events.filter((event) => event.type === 'model/usage').map((event) => event.data);

const stateOf = (frames: readonly Event[]) => reduceAll(emptyConversation(), frames);

/** 即時、歷史整頁、只收最後一輪那一頁、直接折日誌：四條路的 `tokenUsage`。 */
function ledgers(run: { frames: Event[]; root: SessionEvent[] }) {
  return {
    live: stateOf(run.frames).tokenUsage,
    page: stateOf(historyPage(run.root).events).tokenUsage,
    lastPage: stateOf(historyPage(run.root, { maxMessages: 1 }).events).tokenUsage,
    derived: deriveTokenUsage(run.root),
  };
}

const cached = (extra: Partial<ScriptedUsage> = {}): ScriptedUsage => ({
  inputTokens: 1000,
  outputTokens: 20,
  cacheReadTokens: 900,
  ...extra,
});

describe('快取桶走完產品路徑', () => {
  it('有快取讀：日誌記未快取那桶，即時與歷史的總帳帶四桶，三條路相等', async () => {
    const run = await runTurns([
      { content: '好。', usage: cached() },
      { content: '再好。', usage: cached({ inputTokens: 1200, cacheReadTokens: 1000 }) },
    ]);

    expect(usageEvents(run.root)).toEqual([
      expect.objectContaining({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 900 }),
      expect.objectContaining({ inputTokens: 200, outputTokens: 20, cacheReadTokens: 1000 }),
    ]);
    // 沒報快取寫就不放那個 key。
    for (const data of usageEvents(run.root)) expect(data).not.toHaveProperty('cacheWriteTokens');

    const expected = {
      inputTokens: 1000 + 1200,
      uncachedInputTokens: 300,
      outputTokens: 40,
      cacheReadTokens: 1900,
    };
    const { live, page, lastPage, derived } = ledgers(run);
    expect(derived).toEqual(expected);
    expect(live).toEqual(expected);
    expect(page).toEqual(expected);
    expect(lastPage).toEqual(expected);
  }, 30_000);

  it('兩桶都報：寫快取也進帳，inputTokens 仍是三桶相加', async () => {
    const run = await runTurns([
      {
        content: '好。',
        usage: cached({ inputTokens: 194, cacheReadTokens: 64, cacheWriteTokens: 100 }),
      },
    ]);
    expect(usageEvents(run.root)).toEqual([
      expect.objectContaining({
        inputTokens: 30,
        cacheReadTokens: 64,
        cacheWriteTokens: 100,
      }),
    ]);
    const expected = {
      inputTokens: 194,
      uncachedInputTokens: 30,
      outputTokens: 20,
      cacheReadTokens: 64,
      cacheWriteTokens: 100,
    };
    const { live, page, derived } = ledgers(run);
    expect(derived).toEqual(expected);
    expect(live).toEqual(expected);
    expect(page).toEqual(expected);
  }, 30_000);

  it.each([
    ['供應商沒報快取細節', {}],
    [
      'LangChain 在整個 prompt_tokens_details 缺席時建出的 { cache_read: undefined }',
      { cacheDetailsUndefined: true as const },
    ],
  ])(
    '%s：記錄沒有快取 key，總帳也沒有，inputTokens 仍是整個 prompt',
    async (_label, extra) => {
      const run = await runTurns([
        { content: '好。', usage: { inputTokens: 500, outputTokens: 5, ...extra } },
      ]);
      const [data] = usageEvents(run.root);
      expect(data).toMatchObject({ inputTokens: 500, outputTokens: 5 });
      expect(data).not.toHaveProperty('cacheReadTokens');
      expect(data).not.toHaveProperty('cacheWriteTokens');

      const expected = { inputTokens: 500, uncachedInputTokens: 500, outputTokens: 5 };
      const { live, page, derived } = ledgers(run);
      for (const totals of [derived, live, page]) {
        expect(totals).toEqual(expected);
        expect(totals).not.toHaveProperty('cacheReadTokens');
        expect(totals).not.toHaveProperty('cacheWriteTokens');
      }
    },
    30_000,
  );

  it.each([
    ['快取讀比整個 prompt 大', cached({ inputTokens: 500, cacheReadTokens: 600 })],
    [
      '兩桶都報但總量對不上 prompt',
      cached({ inputTokens: 194, cacheReadTokens: 64, cacheWriteTokens: 100, totalTokens: 999 }),
    ],
  ])(
    '%s：整筆不記，帳上是沒有',
    async (_label, usage) => {
      const run = await runTurns([{ content: '好。', usage }]);
      expect(usageEvents(run.root)).toEqual([]);
      expect(stateOf(run.frames).tokenUsage).toBeNull();
      expect(deriveTokenUsage(run.root)).toEqual({
        inputTokens: 0,
        uncachedInputTokens: 0,
        outputTokens: 0,
      });
    },
    30_000,
  );

  it('壓力那格的「目前多大」不隨快取分桶而變：同一段對話有無快取是同一個數', async () => {
    const withCache = await runTurns([{ content: '好。', usage: cached() }]);
    const without = await runTurns([
      { content: '好。', usage: { inputTokens: 1000, outputTokens: 20 } },
    ]);
    expect(stateOf(withCache.frames).contextPressure?.inputTokens).toBe(1000);
    expect(stateOf(without.frames).contextPressure?.inputTokens).toBe(1000);
    // 歷史重放也是同一個數。
    expect(stateOf(historyPage(withCache.root).events).contextPressure?.inputTokens).toBe(1000);
  }, 30_000);

  it('web 讀的 inputTokens 語義沒變：總帳的 inputTokens 是三桶相加（舊欄位）', async () => {
    const run = await runTurns([{ content: '好。', usage: cached({ cacheWriteTokens: 50 }) }]);
    // 1000 是完整 prompt：未快取 50＋讀 900＋寫 50。
    expect(stateOf(run.frames).tokenUsage).toMatchObject({
      inputTokens: 1000,
      uncachedInputTokens: 50,
      cacheReadTokens: 900,
      cacheWriteTokens: 50,
    });
  }, 30_000);
});

describe('舊日誌（格式 35 以前）照舊讀', () => {
  it('格式版本不低於 36，而且舊的 model/usage（沒有快取兩格）折出來的數字跟以前一樣', () => {
    // 36 是分四桶的那一版；之後只會更大（模型選擇是 37）。
    expect(SESSION_LOG_FORMAT_VERSION).toBeGreaterThanOrEqual(36);
    const old = [
      {
        type: 'model/usage',
        time: 0,
        seq: 0,
        data: { inputTokens: 700, outputTokens: 30, totalTokens: 730 },
      },
      {
        type: 'model/usage',
        time: 0,
        seq: 1,
        data: { inputTokens: 900, outputTokens: 10, totalTokens: 910 },
      },
    ] as unknown as SessionEvent[];
    const expected = { inputTokens: 1600, uncachedInputTokens: 1600, outputTokens: 40 };
    expect(deriveTokenUsage(old)).toEqual(expected);
    expect(stateOf(historyPage(old).events).tokenUsage).toEqual(expected);
  });
});
