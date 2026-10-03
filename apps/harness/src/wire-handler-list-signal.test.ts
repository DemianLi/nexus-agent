/**
 * `GET /threads` 把這一個請求的中止訊號交給 `listThreads`——[#983](https://github.com/DemianLi/nexus-agent/issues/983)。
 *
 * 列表掃的是整個專案的日誌，客戶端斷線之後還掃完的話是白花 CPU（實測 1000 份 × 1 MB 約 2.6 秒）。這一檔只問
 * 「handler 有沒有把 `request.signal` 交下去」；「拿到之後每份之間看一次」在 `session-list.test.ts`。
 */

import { THREADS_PATH } from '@nexus/wire';
import { describe, expect, it } from 'vitest';
import { loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import { createWireHandler } from './wire-handler.js';

describe('GET /threads 的中止訊號', () => {
  it('客戶端中止請求，listThreads 拿到的訊號跟著中止；沒中止就不動', async () => {
    let seen: AbortSignal | undefined;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const handler = createWireHandler({
      auth: TEST_BROWSER_AUTH,
      createAgent: () => Promise.reject(new Error('列表不准建 agent')),
      listThreads: (signal) => {
        seen = signal;
        markStarted();
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    });
    const controller = new AbortController();
    const pending = handler.handle(
      loopbackRequest(`http://list-signal.test${THREADS_PATH}`, {
        method: 'GET',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
      }),
    );

    await started;
    expect(seen?.aborted).toBe(false);
    controller.abort(new Error('客戶端斷線'));
    expect(seen?.aborted).toBe(true);
    // 實作拋出來的原因照舊包成錯誤回應，不讓 handler 自己炸掉。
    const response = await pending;
    expect(response.status).toBe(200);
    const body = (await response.json()) as { type: string; message?: string };
    expect(body.type).toBe('error');
    expect(body.message).toContain('客戶端斷線');
  });
});
