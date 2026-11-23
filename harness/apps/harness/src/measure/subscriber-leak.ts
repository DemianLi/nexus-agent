/**
 * 客戶端斷線之後，**真的**下行路由（`POST /threads/:id/stream`、`GET /threads/feed`）有沒有把訂閱收掉——
 * [#990](https://github.com/DemianLi/nexus-agent/pull/990) 之後的追查。
 *
 * `abort-delivery.ts` 用一個串流形狀的模型量過「handler 的 `request.signal` 有沒有中止」：修前放棄 400 次最多 250 次沒中止。
 * 但那是模型。真的下行路由裡的訂閱者數量從外面看不到（`ThreadFeed.#subscribers`、`ThreadPump.#subscribers` 都是私有的），
 * 所以這裡換一個辦法：**在量測行程裡把兩個類別的 `subscribe` 包一層**，數「訂了、還沒收」的條數——訂的時候加一，
 * 回傳的 generator 收掉（`finally`）時減一。包的只是計數，轉給原本的方法，不改它的行為與壽命。
 * 放棄之後等一下還剩幾條，就是漏掉的。
 *
 * 一次放棄 = 開一條真連線、等一小段、直接砍 socket（瀏覽器關分頁的樣子），走真的 `createWireHandler` 與 `startWireServer`。
 *
 * @module
 */

import { request as httpRequest } from 'node:http';
import { createDeepAgent, StateBackend } from 'deepagents';
import { THREAD_FEED_PATH } from '@nexus/wire';
import {
  emptyCommandPoint,
  noSessions,
  TEST_BROWSER_AUTH,
  testSessionCookie,
} from '../fixtures.js';
import { ScriptedChatModel } from '../scripted-model.js';
import { ThreadFeed } from '../thread-feed.js';
import { ThreadPump } from '../thread-pump.js';
import type { PumpAgent } from '../thread-pump.js';
import { createWireHandler } from '../wire-handler.js';
import { startForcedGc } from './abort-delivery.js';
import type { StartWireServer } from './abort-delivery.js';

export type LeakRoute = 'stream' | 'feed';

export interface LeakOptions {
  readonly route: LeakRoute;
  /** 放棄幾次。 */
  readonly total: number;
  /** 同時幾條線在放棄。 */
  readonly concurrency: number;
  /** 放棄之後最多等多久讓訂閱收掉（毫秒）。 */
  readonly settleMs: number;
  /**
   * 量的期間每隔幾毫秒強制做一次完整的垃圾回收。**預設開（25）**：缺陷要等一次完整回收收掉那個沒人抓著的 Request 才會發作，
   * 一個剛起來的行程第一輪量測常常根本沒碰到回收，量到 0 是假的（2026-10-04：修前的 wire-server 在同一個行程裡第一個量的路由
   * 0 條、之後的路由漏十幾條）。給 0 就不強制，看自然回收。
   */
  readonly gcEveryMs?: number;
  readonly startWireServer?: StartWireServer;
}

export interface LeakResult {
  readonly total: number;
  /** 一共訂了幾次（比 `total` 少代表有請求沒走到訂閱，量測無效）。 */
  readonly subscribed: number;
  /** 最後還沒收掉的訂閱。 */
  readonly leaked: number;
}

type Subscribe = (...args: never[]) => AsyncGenerator<unknown, void, undefined>;

/** 把 `prototype.subscribe` 換成會數條數的版本，回傳還原函式與讀數。 */
function countSubscriptions(target: { subscribe: Subscribe }): {
  read: () => { subscribed: number; live: number };
  restore: () => void;
} {
  const original = target.subscribe;
  let subscribed = 0;
  let live = 0;
  target.subscribe = function (this: unknown, ...args: never[]) {
    const inner = original.apply(this, args);
    subscribed += 1;
    live += 1;
    return (async function* () {
      try {
        yield* inner;
      } finally {
        live -= 1;
      }
    })();
  };
  return {
    read: () => ({ subscribed, live }),
    restore: () => {
      target.subscribe = original;
    },
  };
}

function scriptedAgent(): PumpAgent {
  return createDeepAgent({
    model: new ScriptedChatModel({ turns: [{ content: '好。' }] }),
    tools: [],
    backend: new StateBackend(),
  }) as unknown as PumpAgent;
}

/** 放棄 `total` 次，數有幾條訂閱沒收掉。 */
export async function measureSubscriberLeak(options: LeakOptions): Promise<LeakResult> {
  const start: StartWireServer =
    options.startWireServer ?? (await import('../wire-server.js')).startWireServer;
  const counter = countSubscriptions(
    (options.route === 'feed' ? ThreadFeed.prototype : ThreadPump.prototype) as unknown as {
      subscribe: Subscribe;
    },
  );
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    createAgent: async () => ({
      agent: scriptedAgent(),
      attachSessions: noSessions,
      commands: emptyCommandPoint(),
      dispose: async () => undefined,
    }),
  });
  const server = await start({ handler });
  const gcEveryMs = options.gcEveryMs ?? 25;
  const stopGc = gcEveryMs > 0 ? startForcedGc(gcEveryMs) : undefined;
  try {
    const url = new URL(server.url);
    let issued = 0;
    const worker = async (): Promise<void> => {
      while (issued < options.total) {
        const index = issued;
        issued += 1;
        const body = options.route === 'stream' ? JSON.stringify({ channels: ['lifecycle'] }) : '';
        const path =
          options.route === 'stream' ? `/threads/leak-${index % 4}/stream` : THREAD_FEED_PATH;
        const outgoing = httpRequest(url.origin + path, {
          agent: false,
          method: options.route === 'stream' ? 'POST' : 'GET',
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
        outgoing.end(body);
        await new Promise((resolve) => setTimeout(resolve, 30 + Math.random() * 100));
        outgoing.destroy();
        await closed;
      }
    };
    await Promise.all(Array.from({ length: options.concurrency }, worker));
    const deadline = performance.now() + options.settleMs;
    while (counter.read().live > 0 && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const { subscribed, live } = counter.read();
    return { total: options.total, subscribed, leaked: live };
  } finally {
    stopGc?.();
    counter.restore();
    await server.close();
    await handler.close();
  }
}
