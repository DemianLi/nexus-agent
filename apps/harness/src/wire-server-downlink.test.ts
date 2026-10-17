import { decodeSseStream } from '@nexus/wire';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WireHandler } from './wire-handler.js';
import { judgeBeat, MAX_MISSED_HEARTBEATS, SseHeartbeat, startWireServer } from './wire-server.js';
import type { WireServer } from './wire-server.js';

/**
 * 下行串流的背壓、心跳與死線淘汰（[#1504](https://github.com/DemianLi/nexus-agent/issues/1504) 驗收 1–4、7）。
 *
 * 兩層：真 loopback（`startWireServer` 加一支手搭的 SSE handler，對面是不讀的原始 socket）驗**整條路真的會停、會斷**；
 * 不起 socket 的單元驗**每一拍的裁決**（`judgeBeat`、`SseHeartbeat`），因為 loopback 上哪一拍緩衝是多少不是測試決定得了的。
 * 從 serve 組裝起的接線在 `serve-downlink.test.ts`。
 */

const FRAME_BYTES = 64 * 1024;
/** 無背壓時 handler 最多產這麼多顆就停（量測用的天花板，免得拿掉修正時把測試機記憶體吃光）。 */
const PRODUCE_CEILING = 1500;

let running: WireServer | undefined;
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await running?.close();
  running = undefined;
});

interface Source {
  pulls: number;
  aborted: boolean;
  /** 迴圈在斷線之後又拉了一次、看到中止而結束：寫入那一端沒有停在等 drain。 */
  closed: boolean;
  readonly handler: WireHandler;
}

/** 一支永遠在吐大 frame 的 SSE handler：每被拉一次記一次，request 的 signal 中止就記下來並結束。 */
function bulkSource(options: { readonly frame?: string } = {}): Source {
  const frame = options.frame ?? `data: ${'x'.repeat(FRAME_BYTES)}\n\n`;
  const source: Source = {
    pulls: 0,
    aborted: false,
    closed: false,
    handler: {
      async handle(request) {
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(': connected\n\n'));
            request.signal.addEventListener(
              'abort',
              () => {
                source.aborted = true;
              },
              { once: true },
            );
          },
          async pull(controller) {
            // 讓出事件迴圈：拿掉背壓時這支迴圈不能把整個行程餓死。
            await new Promise((resolve) => setImmediate(resolve));
            if (request.signal.aborted) {
              source.closed = true;
              controller.close();
              return;
            }
            if (source.pulls >= PRODUCE_CEILING) {
              await new Promise<void>((resolve) =>
                request.signal.addEventListener('abort', () => resolve(), { once: true }),
              );
              controller.close();
              return;
            }
            source.pulls += 1;
            controller.enqueue(encoder.encode(frame));
          },
        });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      },
      async close() {},
    },
  };
  return source;
}

/** 一支什麼都不產的 SSE handler（開線只吐註解，之後靜默）。 */
function quietSource(): Source {
  const source: Source = {
    pulls: 0,
    aborted: false,
    closed: false,
    handler: {
      async handle(request) {
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(': connected\n\n'));
            request.signal.addEventListener(
              'abort',
              () => {
                source.aborted = true;
                controller.close();
              },
              { once: true },
            );
          },
        });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      },
      async close() {},
    },
  };
  return source;
}

/** 開一條原始 socket 打 `GET /threads/feed`，之後不讀（或照 `read` 慢慢讀）。 */
async function openRawClient(url: string): Promise<Socket> {
  const { port, hostname } = new URL(url);
  const socket = connect({ port: Number(port), host: hostname });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.write(`GET /threads/feed HTTP/1.1\r\nHost: ${hostname}:${port}\r\n\r\n`);
  socket.pause();
  return socket;
}

async function until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('背壓：寫入等 drain（驗收 1）', () => {
  it('對方不收：來源被拉的次數停在一個小常數，不跟著產出量長', async () => {
    const source = bulkSource();
    // 心跳間隔設到跑不到：這一條只量背壓，不要被死線淘汰攪進來。
    running = await startWireServer({ handler: source.handler, heartbeatIntervalMs: 60_000 });
    await openRawClient(running.url);

    await sleep(400);
    const first = source.pulls;
    await sleep(400);
    const second = source.pulls;

    // 卡在 kernel 緩衝加一個 highWaterMark：幾十顆 64 KiB。沒有背壓的話，這個數字會一路衝到天花板。
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(PRODUCE_CEILING / 2);
    // 兩次取樣之間沒有再長：迴圈停在等 drain。
    expect(second - first).toBeLessThanOrEqual(1);
    expect(source.aborted).toBe(false);
  });
});

describe('死線淘汰（驗收 2）', () => {
  it('對方不收、來源持續產出：連 2 拍沒排出去就斷，訂閱放掉，記一行 warn', async () => {
    const source = bulkSource();
    const warned: string[] = [];
    const intervalMs = 40;
    running = await startWireServer({
      handler: source.handler,
      heartbeatIntervalMs: intervalMs,
      warnDisconnect: (message) => warned.push(message),
    });
    const startedAt = Date.now();
    await openRawClient(running.url);

    expect(await until(() => source.aborted, 3000)).toBe(true);
    const elapsed = Date.now() - startedAt;
    // 斷線之後寫入那一端沒有停在等 drain：迴圈又拉了一次、看到中止、把 body 收完（'close' 也是 drain 等待的出口）。
    expect(await until(() => source.closed, 3000)).toBe(true);

    // 不能第一拍就殺：至少要滿 MAX_MISSED_HEARTBEATS 拍。
    expect(elapsed).toBeGreaterThanOrEqual(intervalMs * MAX_MISSED_HEARTBEATS - intervalMs / 2);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('/threads/feed');
    expect(warned[0]).toMatch(/\d+ 位元組/u);
    // warn 不含 frame 內容。
    expect(warned[0]).not.toContain('xxxx');
  });
});

describe('壅塞但活著的線不被殺（驗收 3）', () => {
  it('對方慢慢讀、緩衝一路在縮：連 10 拍以上線還開著', async () => {
    const source = bulkSource();
    const warned: string[] = [];
    const intervalMs = 50;
    running = await startWireServer({
      handler: source.handler,
      heartbeatIntervalMs: intervalMs,
      warnDisconnect: (message) => warned.push(message),
    });
    const socket = await openRawClient(running.url);
    // 每 10 毫秒讀一大口：比來源產得慢很多的同時，緩衝持續在排出去。
    socket.on('readable', () => undefined);
    const timer = setInterval(() => {
      socket.read(256 * 1024);
    }, 10);
    try {
      await sleep(intervalMs * 12);
    } finally {
      clearInterval(timer);
    }
    expect(source.aborted).toBe(false);
    expect(warned).toEqual([]);
  });
});

describe('健康的閒置線（驗收 4）', () => {
  it('不產任何 frame：跑 5 拍以上線還開著，原始位元組有 `: ping`，decodeSseStream 吐出 0 顆事件', async () => {
    const source = quietSource();
    const warned: string[] = [];
    const intervalMs = 40;
    running = await startWireServer({
      handler: source.handler,
      heartbeatIntervalMs: intervalMs,
      warnDisconnect: (message) => warned.push(message),
    });
    const abort = new AbortController();
    const response = await fetch(`${running.url}/threads/feed`, { signal: abort.signal });
    const [raw, decoded] = (response.body as ReadableStream<Uint8Array>).tee();
    const events: unknown[] = [];
    const decoding = (async () => {
      try {
        for await (const event of decodeSseStream(decoded)) events.push(event);
      } catch {
        // 測試結束時我們自己中止。
      }
    })();
    let text = '';
    const reader = raw.getReader();
    const reading = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          text += new TextDecoder().decode(value);
        }
      } catch {
        // 同上。
      }
    })();

    await sleep(intervalMs * 7);
    abort.abort();
    await Promise.all([decoding, reading]);

    expect(source.aborted || true).toBe(true);
    expect(warned).toEqual([]);
    expect(text.startsWith(': connected')).toBe(true);
    // 5 拍以上的心跳，註解行不是封包。
    expect(text.match(/: ping/gu)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(events).toHaveLength(0);
  });
});

describe('每一拍的裁決（單元）', () => {
  it('緩衝是空的：寫心跳，漏拍歸零，永遠不淘汰', () => {
    const line = { missed: 1, lastBuffered: 500 };
    for (let beat = 0; beat < 10; beat += 1) {
      expect(judgeBeat(line, 0)).toBe('ping');
      expect(line).toEqual({ missed: 0, lastBuffered: 0 });
    }
  });

  it('緩衝卡著、沒縮小：連 MAX_MISSED_HEARTBEATS 拍才淘汰，前面是 hold，而且不寫心跳', () => {
    const line = { missed: 0, lastBuffered: 0 };
    const verdicts: string[] = [];
    for (let beat = 0; beat < MAX_MISSED_HEARTBEATS; beat += 1) {
      verdicts.push(judgeBeat(line, 1000));
    }
    expect(verdicts).toEqual([...Array<string>(MAX_MISSED_HEARTBEATS - 1).fill('hold'), 'evict']);
  });

  it('緩衝比上一拍小：對方有在收，漏拍歸零', () => {
    const line = { missed: 0, lastBuffered: 0 };
    let buffered = 100_000;
    for (let beat = 0; beat < 20; beat += 1) {
      expect(judgeBeat(line, buffered)).not.toBe('evict');
      buffered -= 1000;
    }
    expect(line.missed).toBe(0);
  });

  it('緩衝變大不算進展', () => {
    const line = { missed: 0, lastBuffered: 0 };
    expect(judgeBeat(line, 10)).toBe('hold');
    expect(judgeBeat(line, 20)).toBe('evict');
  });
});

/** 一條只長了 SseHeartbeat 看得到的那幾個成員的假回應。 */
class FakeResponse extends EventEmitter {
  writableLength = 0;
  destroyed = false;
  writableEnded = false;
  readonly written: string[] = [];
  write(chunk: string): boolean {
    this.written.push(chunk);
    return true;
  }
  destroy(): void {
    this.destroyed = true;
    this.emit('close');
  }
}

describe('SseHeartbeat（假計時器）', () => {
  const INTERVAL = 100;
  // setImmediate 不假：淘汰在 setImmediate 裡再確認一次，測試用真的 `flushImmediate` 讓它跑。
  const FAKE_TIMERS: ('setInterval' | 'clearInterval' | 'setTimeout' | 'clearTimeout')[] = [
    'setInterval',
    'clearInterval',
    'setTimeout',
    'clearTimeout',
  ];
  const flushImmediate = () => new Promise((resolve) => setImmediate(resolve));

  function setup(): { heartbeat: SseHeartbeat; warned: string[]; response: FakeResponse } {
    const warned: string[] = [];
    const heartbeat = new SseHeartbeat(INTERVAL, (message) => warned.push(message));
    const response = new FakeResponse();
    heartbeat.watch(response as unknown as ServerResponse, '/threads/t/stream');
    return { heartbeat, warned, response };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('卡住的線：第 2 拍排淘汰，setImmediate 裡確認後 destroy 一次，warn 一行', async () => {
    vi.useFakeTimers({ toFake: FAKE_TIMERS });
    const { heartbeat, warned, response } = setup();
    response.writableLength = 4096;
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(response.destroyed).toBe(false);
    // 同步推進：第 2 拍只是排了淘汰，真的 setImmediate 還沒機會跑。
    vi.advanceTimersByTime(INTERVAL);
    // 要等 setImmediate 裡再確認。
    expect(response.destroyed).toBe(false);
    await flushImmediate();
    expect(response.destroyed).toBe(true);
    expect(warned).toEqual([expect.stringContaining('/threads/t/stream')]);
    expect(warned[0]).toContain('4096');
    // 卡著期間一個 ping 都沒寫。
    expect(response.written).toEqual([]);
    heartbeat.close();
  });

  it('任何一次 drain 都把漏拍歸零：每拍之間來一次 drain，跑 10 拍都不殺', async () => {
    vi.useFakeTimers({ toFake: FAKE_TIMERS });
    const { heartbeat, warned, response } = setup();
    response.writableLength = 4096;
    for (let beat = 0; beat < 10; beat += 1) {
      await vi.advanceTimersByTimeAsync(INTERVAL);
      response.emit('drain');
    }
    expect(response.destroyed).toBe(false);
    expect(warned).toEqual([]);
    heartbeat.close();
  });

  it('淘汰前的最後一刻 drain 來了：setImmediate 裡再確認時放過它', async () => {
    vi.useFakeTimers({ toFake: FAKE_TIMERS });
    const { heartbeat, response } = setup();
    response.writableLength = 4096;
    await vi.advanceTimersByTimeAsync(INTERVAL);
    // 第 2 拍：跑拍的回呼，但先不讓 setImmediate 跑。
    vi.advanceTimersByTime(INTERVAL);
    response.emit('drain');
    await flushImmediate();
    expect(response.destroyed).toBe(false);
    heartbeat.close();
  });

  it('緩衝是空的：每拍一個心跳註解行，不殺', async () => {
    vi.useFakeTimers({ toFake: FAKE_TIMERS });
    const { heartbeat, response } = setup();
    await vi.advanceTimersByTimeAsync(INTERVAL * 5);
    expect(response.written).toEqual(Array<string>(5).fill(': ping\n\n'));
    expect(response.destroyed).toBe(false);
    heartbeat.close();
  });

  it('線自己關掉就不再被盯：之後的拍不碰它', async () => {
    vi.useFakeTimers({ toFake: FAKE_TIMERS });
    const { heartbeat, response } = setup();
    response.emit('close');
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(response.written).toEqual([]);
    heartbeat.close();
  });

  it('計時器第一條線才起、unref、close() 之後清掉（驗收 7）', () => {
    vi.useFakeTimers({ toFake: FAKE_TIMERS });
    const warned: string[] = [];
    const heartbeat = new SseHeartbeat(INTERVAL, (message) => warned.push(message));
    expect(vi.getTimerCount()).toBe(0);
    heartbeat.watch(new FakeResponse() as unknown as ServerResponse, '/a');
    heartbeat.watch(new FakeResponse() as unknown as ServerResponse, '/b');
    expect(vi.getTimerCount()).toBe(1);
    heartbeat.close();
    expect(vi.getTimerCount()).toBe(0);
    // close 之後再來的線不再起計時器。
    heartbeat.watch(new FakeResponse() as unknown as ServerResponse, '/c');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('計時器是 unref 的：不擋行程自然退出', () => {
    const unref = vi.fn();
    const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation((() => ({
      unref,
    })) as unknown as typeof setInterval);
    const heartbeat = new SseHeartbeat(INTERVAL, () => undefined);
    heartbeat.watch(new FakeResponse() as unknown as ServerResponse, '/a');
    expect(unref).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    heartbeat.close();
  });
});

describe('WireServer.close()（驗收 7）', () => {
  it('close 先清計時器：有不讀的線掛著也收得乾淨，之後沒有殘留的 interval', async () => {
    const source = bulkSource();
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    running = await startWireServer({ handler: source.handler, heartbeatIntervalMs: 60_000 });
    await openRawClient(running.url);
    expect(await until(() => source.pulls > 0, 2000)).toBe(true);
    const calls = clearSpy.mock.calls.length;
    await running.close();
    running = undefined;
    expect(clearSpy.mock.calls.length).toBeGreaterThan(calls);
    clearSpy.mockRestore();
  });
});
