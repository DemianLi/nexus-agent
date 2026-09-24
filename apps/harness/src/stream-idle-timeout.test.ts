/**
 * **產品路徑：供應商吐一段就停住，那一輪會結束，失敗寫進日誌。**
 * [#521](https://github.com/DemianLi/nexus-agent/issues/521)。
 *
 * `live-model.test.ts` 證的是 `ChatOpenAI.stream` 會拋；這裡證的是拋出來的東西**走到了 serve 那一輪
 * 的終點**：pump 收得了尾、`turn/failed` 帶著閒置逾時那句話。只證前者的話，拋出來卻被中間哪一層吃掉、
 * 那一輪照樣掛著，測試不會紅。
 *
 * 模型用的是 **`createLiveModel` 本身**（不是測試自己組的 `ChatOpenAI`），所以工廠有沒有把那一層
 * 接上、接的是不是設定裡的 `timeoutMs`，也一起在射程裡。
 *
 * **零憑證**：對手方是本機的假 SSE 端點；金鑰是假的，只為了過工廠的「缺 key 當場失敗」。
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MemorySaver } from '@langchain/langgraph';
import type { SessionEventMap } from '@nexus/core';
import type { Event } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { createLiveModel, LIVE_API_KEY_ENV } from './live-model.js';
import { liveModelConfigSchema } from './settings/live-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

/** 吐一個字就停住的端點。 */
async function stallingOpenAi() {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    req.resume();
    const chunk = (delta: Record<string, unknown>) =>
      `data: ${JSON.stringify({
        id: 'c',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'fake',
        choices: [{ index: 0, delta, finish_reason: null }],
      })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(chunk({ role: 'assistant', content: '' }));
    res.write(chunk({ content: '甲' }));
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

describe('供應商吐一段就停住（#521）', () => {
  const original = process.env[LIVE_API_KEY_ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[LIVE_API_KEY_ENV];
    else process.env[LIVE_API_KEY_ENV] = original;
  });

  it('那一輪在閒置逾時之後結束，turn/failed 帶著那句話，只打一次', async () => {
    process.env[LIVE_API_KEY_ENV] = 'nvapi-test-value-not-a-real-key';
    const upstream = await stallingOpenAi();
    const built = await createNexusAgent({
      model: createLiveModel(
        liveModelConfigSchema.parse({ baseUrl: upstream.baseUrl, timeoutMs: 300, maxRetries: 2 }),
      ),
      checkpointer: new MemorySaver(),
      plugins: [],
    });
    const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'idle-timeout');
    const detach = built.attachSession(pump.sessions);
    const frames: Event[] = [];
    const line = new AbortController();
    const draining = (async () => {
      for await (const frame of pump.subscribe(['messages', 'lifecycle'], line.signal))
        frames.push(frame);
    })();
    try {
      const started = Date.now();
      // 失敗的一輪，`submit` 把錯誤原樣往外拋（同 context-pressure.test.ts 收 failures 的做法）。
      const thrown = await pump.submit({ kind: 'message', text: '說點什麼' }).then(
        () => undefined,
        (error: unknown) => error,
      );
      const elapsed = Date.now() - started;
      expect(String((thrown as Error | undefined)?.message)).toContain('串流閒置逾時');

      const events = pump.sessions.root.events;
      const failed = events.filter((event) => event.type === 'turn/failed');
      expect(failed).toHaveLength(1);
      expect((failed[0]!.data as SessionEventMap['turn/failed']).message).toContain('串流閒置逾時');
      // 中段逾時不重試：吐過內容的那一次作廢不了。
      expect(upstream.hits()).toBe(1);
      // 閒置逾時是 300 毫秒；修之前這一輪永遠不會結束，這裡是整條測試的逾時先到。
      expect(elapsed).toBeLessThan(5_000);
      // **前提**：畫面上真的出現過那個字，量到的才是「吐了一段才停」，不是連線失敗。
      const shown = frames
        .filter((frame) => frame.method === 'messages')
        .map((frame) => frame.params.data as { event?: string; delta?: { text?: string } })
        .filter((data) => data.event === 'content-block-delta')
        .map((data) => data.delta?.text ?? '')
        .join('');
      expect(shown).toBe('甲');
    } finally {
      line.abort();
      await draining;
      detach();
      await upstream.close();
    }
  }, 20_000);
});
