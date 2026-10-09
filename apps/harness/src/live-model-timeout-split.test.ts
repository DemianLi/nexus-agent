/**
 * **逾時拆兩格（[#1251](https://github.com/DemianLi/nexus-agent/issues/1251)）：`timeoutMs` 只管連線到第一則事件，
 * `streamIdleTimeoutMs` 只管第一則事件之後段與段之間。**
 *
 * 原本一個旋鈕管兩段，視覺模型吐第一則事件前先吃圖（90b 實測 133 秒）被 90 秒砍掉。這裡用 loopback 的假 SSE 端點
 * 把兩段的等待分別撐長，量的是**兩格各管各的、互不牽動**：每個方向各一條測試，所以誰把哪一格接到另一格的位置都會紅。
 *
 * 模型是 **`createLiveModel` 本身**（不是測試自己組的 `ChatOpenAI`），工廠有沒有把兩格接對一起在射程裡。
 * **零憑證**：金鑰是假的，只為了過工廠的「缺 key 當場失敗」。
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createLiveModel, LIVE_API_KEY_ENV, StreamIdleTimeoutError } from './live-model.js';
import { liveModelConfigSchema } from './settings/live-model.js';

/** 假端點的兩段等待：吐第一則事件之前等多久、第一則事件之後到下一段之間等多久（毫秒）。 */
interface Pacing {
  readonly firstEventDelayMs: number;
  readonly gapMs: number;
}

async function pacedOpenAi(pacing: Pacing) {
  const server = createServer((req, res) => {
    req.resume();
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
      `data: ${JSON.stringify({
        id: 'c',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'fake',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    const timers: NodeJS.Timeout[] = [];
    res.on('close', () => timers.forEach(clearTimeout));
    timers.push(
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(chunk({ role: 'assistant', content: '甲' }));
        timers.push(
          setTimeout(() => {
            res.write(chunk({ content: '乙' }, 'stop'));
            res.write('data: [DONE]\n\n');
            res.end();
          }, pacing.gapMs),
        );
      }, pacing.firstEventDelayMs),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** 對假端點跑一次串流，回頭交出拼起來的文字或拋出的東西，以及花了多久。 */
async function streamOnce(
  pacing: Pacing,
  timeouts: { readonly timeoutMs: number; readonly streamIdleTimeoutMs: number },
) {
  const upstream = await pacedOpenAi(pacing);
  try {
    const model = createLiveModel(
      liveModelConfigSchema.parse({ baseUrl: upstream.baseUrl, maxRetries: 0, ...timeouts }),
    );
    const started = Date.now();
    let text = '';
    const thrown = await (async () => {
      for await (const part of await model.stream('說點什麼')) text += String(part.content);
    })().then(
      () => undefined,
      (error: unknown) => error,
    );
    return { text, thrown, elapsed: Date.now() - started };
  } finally {
    await upstream.close();
  }
}

describe('逾時拆兩格（#1251）', () => {
  const original = process.env[LIVE_API_KEY_ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[LIVE_API_KEY_ENV];
    else process.env[LIVE_API_KEY_ENV] = original;
  });

  it('首事件比閒置那格慢、但在 timeoutMs 之內：照樣成功（首事件不受 streamIdleTimeoutMs 管）', async () => {
    process.env[LIVE_API_KEY_ENV] = 'nvapi-test-value-not-a-real-key';
    const { text, thrown } = await streamOnce(
      { firstEventDelayMs: 500, gapMs: 20 },
      { timeoutMs: 5_000, streamIdleTimeoutMs: 150 },
    );
    expect(thrown).toBeUndefined();
    expect(text).toBe('甲乙');
  }, 20_000);

  it('第一則事件之後的停頓比 streamIdleTimeoutMs 久、但沒超過 timeoutMs：照閒置那格逾時', async () => {
    process.env[LIVE_API_KEY_ENV] = 'nvapi-test-value-not-a-real-key';
    const { text, thrown, elapsed } = await streamOnce(
      { firstEventDelayMs: 0, gapMs: 3_000 },
      { timeoutMs: 10_000, streamIdleTimeoutMs: 200 },
    );
    expect(String((thrown as Error | undefined)?.message)).toContain('串流閒置逾時');
    expect(String((thrown as Error).message)).toContain('200 毫秒');
    // 逾時值是閒置那格，不是 timeoutMs（10 秒）；拋的也是閒置逾時那個型別，不是 SDK 的逾時。
    expect(elapsed).toBeLessThan(2_500);
    expect(text).toBe('甲');
  }, 20_000);

  it('第一則事件之後的停頓比 timeoutMs 久、但沒超過 streamIdleTimeoutMs：成功（timeoutMs 不管段與段之間）', async () => {
    process.env[LIVE_API_KEY_ENV] = 'nvapi-test-value-not-a-real-key';
    const { text, thrown } = await streamOnce(
      { firstEventDelayMs: 0, gapMs: 600 },
      { timeoutMs: 200, streamIdleTimeoutMs: 5_000 },
    );
    expect(thrown).toBeUndefined();
    expect(text).toBe('甲乙');
  }, 20_000);

  it('首事件超過 timeoutMs：照 timeoutMs 逾時，不等閒置那格', async () => {
    process.env[LIVE_API_KEY_ENV] = 'nvapi-test-value-not-a-real-key';
    const { thrown, elapsed } = await streamOnce(
      { firstEventDelayMs: 4_000, gapMs: 20 },
      { timeoutMs: 300, streamIdleTimeoutMs: 60_000 },
    );
    expect(thrown).toBeDefined();
    // 逾時的是首事件那一段（SDK 的計時器），不是閒置那一層。
    expect(thrown).not.toBeInstanceOf(StreamIdleTimeoutError);
    expect(String((thrown as Error).message)).not.toContain('串流閒置逾時');
    expect(elapsed).toBeLessThan(3_000);
  }, 20_000);
});
