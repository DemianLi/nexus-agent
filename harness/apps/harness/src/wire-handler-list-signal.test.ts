/**
 * 會掃一大片東西的幾條路由，把「這一個請求」的中止訊號交給底下的實作——[#983](https://github.com/DemianLi/nexus-agent/issues/983)。
 *
 * 列表掃整個專案的日誌，客戶端斷線之後還掃完的話是白花 CPU（實測 1000 份 × 1 MB 約 2.6 秒）；搜尋對帳與 `@` 的會話候選
 * 一樣是一圈一圈讀。這一檔只問「handler 有沒有把 `request.signal` 交下去」；「拿到之後每份之間看一次」在各自的實作的測試
 * （`session-list.test.ts` 等）。「斷線之後 `request.signal` 真的會動」在 `measure/abort-delivery.test.ts`。
 *
 * 沒列在這裡的：檔案候選（`file-references`）刻意**不**取消共用的走訪，只取消這個呼叫者的等待；下行（`stream`、`feed`）要
 * 起 agent，訂閱者數量從外面看不到；`changes/diff` 與斜線指令沒有夠長的東西可放棄。
 */

import { sessionReferencesPath, THREAD_SEARCH_PATH, THREADS_PATH } from '@nexus/wire';
import { describe, expect, it } from 'vitest';
import { loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import { createWireHandler } from './wire-handler.js';
import type { WireHandlerOptions } from './wire-handler.js';

interface Route {
  readonly name: string;
  /** 把「卡到被中止才結束」的實作裝進 handler 選項，並回報它拿到的訊號。 */
  readonly options: (hold: (signal: AbortSignal) => Promise<never>) => Partial<WireHandlerOptions>;
  readonly request: (signal: AbortSignal) => Request;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

const ROUTES: readonly Route[] = [
  {
    name: 'GET /threads（listThreads）',
    options: (hold) => ({ listThreads: hold }),
    request: (signal) =>
      loopbackRequest(`http://list-signal.test${THREADS_PATH}`, {
        method: 'GET',
        headers: JSON_HEADERS,
        signal,
      }),
  },
  {
    name: 'POST /threads/search（searchThreads）',
    options: (hold) => ({ searchThreads: (_query, signal) => hold(signal) }),
    request: (signal) =>
      loopbackRequest(`http://list-signal.test${THREAD_SEARCH_PATH}`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ query: '想找的字' }),
        signal,
      }),
  },
  {
    name: 'GET /threads/:id/session-references（listSessionReferences）',
    options: (hold) => ({ listSessionReferences: (_thread, _query, signal) => hold(signal) }),
    request: (signal) =>
      loopbackRequest(`http://list-signal.test${sessionReferencesPath('t1')}?query=abc`, {
        method: 'GET',
        headers: JSON_HEADERS,
        signal,
      }),
  },
];

describe.each(ROUTES)('$name 的中止訊號', (route) => {
  it('客戶端中止請求，實作拿到的訊號跟著中止；沒中止就不動', async () => {
    let seen: AbortSignal | undefined;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const hold = (signal: AbortSignal): Promise<never> => {
      seen = signal;
      markStarted();
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    };
    const handler = createWireHandler({
      auth: TEST_BROWSER_AUTH,
      createAgent: () => Promise.reject(new Error('這幾條不准建 agent')),
      ...route.options(hold),
    });
    const controller = new AbortController();
    // 先掛上 catch：被中止的路由照協定拋出去、由載體收掉，這裡不能讓它變成沒人接的 rejection。
    const settled = handler.handle(route.request(controller.signal)).then(
      (response) => ({ response }),
      (error: unknown) => ({ error }),
    );

    await started;
    expect(seen?.aborted).toBe(false);
    controller.abort(new Error('客戶端斷線'));
    expect(seen?.aborted).toBe(true);
    const outcome = await settled;
    // 不管是包成錯誤回應還是照樣拋出去，都不能是一個成功的結果。
    if ('response' in outcome) {
      const body = (await outcome.response.json()) as { type?: string };
      expect(body.type).toBe('error');
    } else {
      expect(String(outcome.error)).toContain('客戶端斷線');
    }
  });
});
