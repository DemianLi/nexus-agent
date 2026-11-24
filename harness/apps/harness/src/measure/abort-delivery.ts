/**
 * 客戶端斷線時，handler 手上的 `request.signal` 有沒有真的中止——[#983](https://github.com/DemianLi/nexus-agent/issues/983) 之後的追查。
 *
 * #990 發現 `wire-server.ts` 只留 `request.signal`、不留包著它的 Request 時，一部分放棄的請求 handler 永遠收不到中止。
 * 那個缺陷在單一請求、單次量測下看不見（孤立的最小 server 與強制 GC 都重現不出來），要**帶著真實的 handler 形狀與
 * 配置壓力、放棄幾百次**才看得到。這一檔把那個量法留下來：
 *
 * - `list`：走**真的** `createWireHandler` 的 `GET /threads`，`listThreads` 是一個每圈真 I/O ＋配一份大字串、
 *   只在中止時收工的迴圈（長時間 `await` 的形狀：列表、搜尋、`@` 候選、改動比對）。
 * - `sse`：handler 立刻回一個串流、之後只靠 `request.signal` 收尾（`openFeed`／`openStream` 的形狀：
 *   那時 Request 早就沒人抓著了，是最容易斷的一種）。**這一條是形狀的模型，不是真的下行路由**——真的下行
 *   路由裡的訂閱者數量從外面看不到。
 *
 * 判準：**放棄 N 次，handler 的 signal 有幾次到最後都沒中止**。2026-10-04 實測（M3 Pro、Node 25、並行 16、放棄 400 次）：
 * 修前 `list` 24 次、`sse` 250 次沒中止，修後兩條都是 0。
 *
 * @module
 */

import { request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import v8 from 'node:v8';
import vm from 'node:vm';
import { THREADS_PATH } from '@nexus/wire';
import { TEST_BROWSER_AUTH, testSessionCookie } from '../fixtures.js';
import { createWireHandler } from '../wire-handler.js';
import type { WireHandler } from '../wire-handler.js';
import type { WireServer } from '../wire-server.js';

export type DeliveryShape = 'list' | 'sse';

export type StartWireServer = (options: { readonly handler: WireHandler }) => Promise<WireServer>;

export interface DeliveryOptions {
  readonly shape: DeliveryShape;
  /** 放棄幾次。 */
  readonly total: number;
  /** 同時幾條線在放棄。 */
  readonly concurrency: number;
  /** handler 最多撐多久（毫秒）；沒等到中止就算「沒收到」。 */
  readonly holdMs: number;
  /**
   * 量的期間每隔幾毫秒強制做一次完整的垃圾回收，預設 0（不強制）。缺陷要等一次完整回收才發作，強制它就不必靠運氣
   * （`subscriber-leak.ts` 用 25 毫秒，修前漏 396–400／400）。
   */
  readonly gcEveryMs?: number;
  /** 換一份 `startWireServer`（例如修前的那一版）。預設是現行的。 */
  readonly startWireServer?: StartWireServer;
}

export interface DeliveryResult {
  readonly total: number;
  /** handler 收到中止的次數。 */
  readonly noticed: number;
  /** 撐到 `holdMs` 都沒收到的次數。 */
  readonly lost: number;
}

/** 每隔 `everyMs` 毫秒強制一次完整的垃圾回收；回傳停掉它的函式。 */
export function startForcedGc(everyMs: number): () => void {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc') as () => void;
  const timer = setInterval(gc, everyMs);
  return () => {
    clearInterval(timer);
  };
}

function churn(round: number): void {
  // 配一份大字串、燒一點同步時間，像一份日誌被讀進來解析。
  Buffer.alloc(512 * 1024, round).toString('latin1');
  const until = performance.now() + 1;
  while (performance.now() < until) {
    // 空轉。
  }
}

/** 放棄 `total` 次，數 handler 的 signal 有幾次中止。 */
export async function measureAbortDelivery(options: DeliveryOptions): Promise<DeliveryResult> {
  const start: StartWireServer =
    options.startWireServer ?? (await import('../wire-server.js')).startWireServer;
  let noticed = 0;
  let lost = 0;

  const listHandler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    createAgent: () => Promise.reject(new Error('列表不准建 agent')),
    listThreads: async (signal) => {
      const started = performance.now();
      for (
        let round = 0;
        !signal.aborted && performance.now() - started < options.holdMs;
        round += 1
      ) {
        await readFile(new URL(import.meta.url));
        churn(round);
      }
      if (signal.aborted) noticed += 1;
      else lost += 1;
      return { items: [], unreadable: 0 };
    },
  });

  const sseHandler: WireHandler = {
    handle(request) {
      // 立刻回串流：回完之後沒有任何東西抓著 Request，只剩這個 signal。
      const { signal } = request;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(': open\n\n'));
          const churner = setInterval(() => {
            churn(0);
          }, 5);
          const giveUp = setTimeout(() => {
            clearInterval(churner);
            lost += 1;
            try {
              controller.close();
            } catch {
              // 對方早走了。
            }
          }, options.holdMs);
          const onAbort = (): void => {
            clearInterval(churner);
            clearTimeout(giveUp);
            noticed += 1;
            try {
              controller.close();
            } catch {
              // 同上。
            }
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        },
      });
      return Promise.resolve(
        new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
      );
    },
    close: async () => undefined,
  };

  const server = await start({ handler: options.shape === 'sse' ? sseHandler : listHandler });
  const stopGc = (options.gcEveryMs ?? 0) > 0 ? startForcedGc(options.gcEveryMs!) : undefined;
  try {
    const url = new URL(server.url);
    let issued = 0;
    const worker = async (): Promise<void> => {
      while (issued < options.total) {
        issued += 1;
        const outgoing = httpRequest(url.origin + (options.shape === 'sse' ? '/x' : THREADS_PATH), {
          agent: false,
          headers: {
            host: 'localhost',
            cookie: testSessionCookie('localhost'),
            'content-type': 'application/json',
          },
        });
        const closed = new Promise((resolve) => {
          outgoing.on('error', resolve);
          outgoing.on('close', resolve);
        });
        outgoing.end();
        await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 100));
        outgoing.destroy();
        await closed;
      }
    };
    await Promise.all(Array.from({ length: options.concurrency }, worker));
    // 最後一批：等 handler 看完它們自己的 signal（或撐滿 holdMs）。
    const deadline = performance.now() + options.holdMs + 1000;
    while (noticed + lost < options.total && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    stopGc?.();
    await server.close();
  }
  return { total: options.total, noticed, lost };
}
