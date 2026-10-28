/**
 * 一條死掉的下行不再把 thread 釘在行程裡（[#1504](https://github.com/DemianLi/nexus-agent/issues/1504) 驗收 2 的後半，接上 #1484）。
 *
 * **真的 `startWireServer`＋真的 `createWireHandler`＋真的 `ThreadPump`**，agent 是假的（frame 由測試一顆一顆餵）。
 * 對面是一條開了下行卻永遠不讀的真 client（`openEvents` 兌現之後不抽）：undici 的緩衝填滿後不再讀 socket，等同筆電闔上、
 * `ssh -L` 斷在半路。問的是：
 *
 * - 死線連兩拍沒排出去就被斷，server 端的訂閱放掉（`pump.subscriberCount` 回到 0）；
 * - 於是這條 thread 變成「閒置」，`sweepIdle` 撤得掉它——沒有這一張卡，訂閱永遠是 1，這條 thread 永遠撤不掉、一直佔著名額。
 *
 * 每一步都先證它真的發生過（斷線的 warn 出現、撤掉的 thread 在名單上），不是「沒出事」。
 *
 * **零憑證、零外部連線**。
 */

import { createWireClient } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import {
  emptyCommandPoint,
  fetchWithCookie,
  noSessions,
  TEST_BROWSER_AUTH,
  testSessionCookie,
} from './fixtures.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';
import type { IdleSweepingWireHandler } from './wire-handler.js';
import { startWireServer } from './wire-server.js';
import type { WireServer } from './wire-server.js';

const T = 10_000;

async function until(predicate: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const raw = (method: string, data: unknown) => ({
  type: 'event',
  seq: 0,
  method,
  params: { namespace: [] as string[], timestamp: 0, data },
});
const START = raw('messages', { event: 'message-start', role: 'ai', run_id: 'r1', id: 'run-r1' });
const text = (value: string) =>
  raw('messages', {
    event: 'content-block-delta',
    run_id: 'r1',
    index: 0,
    delta: { type: 'text-delta', text: value },
  });
const COMPLETED = raw('lifecycle', { event: 'completed', graph_name: 'root' });

function fedAgent() {
  const pending: unknown[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const agent = {
    streamEvents: async (_input: unknown, config: { configurable: Record<string, unknown> }) => {
      const signal = Object.values(config.configurable).find(
        (value): value is AbortSignal => value instanceof AbortSignal,
      );
      signal?.addEventListener('abort', () => wake?.(), { once: true });
      return (async function* () {
        for (;;) {
          while (pending.length > 0) yield pending.shift();
          if (signal?.aborted === true) throw new Error('被切斷了');
          if (ended) return;
          await new Promise<void>((resolve) => (wake = resolve));
          wake = undefined;
        }
      })();
    },
    getState: async () => ({ values: {} }),
    updateState: async () => ({}),
  };
  return {
    agent: agent as unknown as PumpAgent,
    feed: (frame: unknown) => {
      pending.push(frame);
      wake?.();
    },
    end: () => {
      ended = true;
      wake?.();
    },
  };
}

let server: WireServer | undefined;
let handler: IdleSweepingWireHandler | undefined;
afterEach(async () => {
  await server?.close();
  await handler?.close();
  server = undefined;
  handler = undefined;
});

describe('死線放掉訂閱，閒置逐出撤得掉這條 thread', () => {
  it('不讀的下行：連兩拍沒排出去就被斷、warn 一行、訂閱放掉；之後 sweepIdle 把這條 thread 撤掉', async () => {
    const fed = fedAgent();
    const clock = { now: 1_000_000 };
    const evicted: string[] = [];
    const disconnected: string[] = [];
    handler = createWireHandler({
      auth: TEST_BROWSER_AUTH,
      idleEvictMs: T,
      idleEvictPollMs: 3_600_000,
      now: () => clock.now,
      // 位元組上限放到天花板：這一條量的是死線，不是上限。
      downlinkMaxBytes: 1_000_000_000,
      onThreadEvicted: (threadId) => {
        evicted.push(threadId);
      },
      createAgent: async () => ({
        agent: fed.agent,
        attachSessions: noSessions,
        commands: emptyCommandPoint(),
        dispose: async () => undefined,
      }),
    });
    server = await startWireServer({
      handler,
      heartbeatIntervalMs: 40,
      warnDisconnect: (message) => disconnected.push(message),
    });
    const client = createWireClient({
      baseUrl: server.url,
      fetch: fetchWithCookie(testSessionCookie(new URL(server.url).host)),
    });

    // 開了下行，之後永遠不抽。
    const stuck = await client.openEvents('dl');
    expect((await client.runStart('dl', '嗨')).type).toBe('success');
    fed.feed(START);
    // 灌到塞滿 kernel 與 undici 的緩衝：幾百顆 64 KiB 的 frame。
    const chunk = 'z'.repeat(64 * 1024);
    for (let index = 0; index < 400; index += 1) fed.feed(text(chunk));

    await until(() => disconnected.length > 0);
    expect(disconnected).toHaveLength(1);
    expect(disconnected[0]).toContain('/threads/dl/stream');
    // 沒有 thread 內容進 warn。
    expect(disconnected[0]).not.toContain('zzzz');

    // 這一輪收尾；thread 不再有 run 在跑，唯一擋著的就是那條訂閱。
    fed.feed(COMPLETED);
    fed.end();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // 第一次掃：開始計閒置時間；之後時間過了 T，第二次掃撤掉。
    await handler.sweepIdle();
    clock.now += T + 1;
    await handler.sweepIdle();
    expect(evicted).toEqual(['dl']);
    void stuck.return(undefined);
  });
});
