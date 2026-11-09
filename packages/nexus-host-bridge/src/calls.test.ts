import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { HostClient } from './client.js';
import { HostCallError } from './errors.js';
import { FrameReader, PROTOCOL_VERSION, frame, type Json } from './protocol.js';
import { ABSENT_HOST_BRIDGE, createHostBridge, defineHostService } from './service.js';

interface Received {
  readonly type: string;
  readonly id?: number;
  readonly service?: string;
  readonly method?: string;
  readonly payload?: Json;
}

/** 假宿主：hello 一律收下，之後每一框交給 `onFrame`，由測試決定回什麼。 */
function scriptedHost(
  path: string,
  onFrame: (message: Received, reply: (value: object) => void, socket: Socket) => void,
) {
  const received: Received[] = [];
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    const reader = new FrameReader();
    const reply = (value: object) => socket.write(frame(Buffer.from(JSON.stringify(value))));
    socket.on('data', (chunk: Buffer) => {
      for (const payload of reader.push(chunk)) {
        const message = JSON.parse(payload.toString('utf8')) as Received;
        received.push(message);
        if (message.type === 'hello') reply({ type: 'hello', version: PROTOCOL_VERSION });
        else onFrame(message, reply, socket);
      }
    });
    socket.on('error', () => undefined);
  });
  const listening = new Promise<void>((resolve) => server.listen(path, resolve));
  return {
    received,
    listening,
    connections: () => sockets.length,
    dropAll: () => {
      for (const socket of sockets) socket.destroy();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => {
          resolve();
        });
      }),
  };
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function socketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'host-bridge-calls-'));
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return join(dir, 'host.sock');
}

function clientAt(path: string, logs: string[] = []): HostClient {
  const client = new HostClient({
    socketPath: path,
    token: 't',
    log: (line) => logs.push(line),
    backoffMs: 10,
    backoffMaxMs: 40,
  });
  cleanups.push(() => {
    client.close();
  });
  return client;
}

async function readyHost(onFrame: Parameters<typeof scriptedHost>[1]) {
  const path = socketPath();
  const host = scriptedHost(path, onFrame);
  cleanups.push(host.close);
  await host.listening;
  const logs: string[] = [];
  const client = clientAt(path, logs);
  expect(await client.waitReady(5_000)).toBe(true);
  return { path, host, client, logs };
}

async function eventually(check: () => boolean): Promise<void> {
  const until = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > until) throw new Error('等不到');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (error: unknown) => (error instanceof HostCallError ? error.code : String(error)),
  );

/** 照方法名回答的假宿主：echo 原樣回、stream 先推兩塊再回結果、fail 回錯，其他（例如 hang）不回。 */
function echoHost(message: Received, reply: (value: object) => void): void {
  if (message.type !== 'call') return;
  const id = message.id;
  if (message.method === 'echo')
    reply({ type: 'result', side: 'c', id, ok: message.payload ?? null });
  if (message.method === 'stream') {
    reply({ type: 'chunk', side: 'c', id, seq: 0, payload: 'a' });
    reply({ type: 'chunk', side: 'c', id, seq: 1, payload: 'b' });
    reply({ type: 'result', side: 'c', id, ok: 2 });
  }
  if (message.method === 'fail') {
    reply({
      type: 'result',
      side: 'c',
      id,
      error: { code: 'unknown_method', message: '沒有 fail' },
    });
  }
}

describe('HostClient.call', () => {
  it('單次的方法回 ok；宿主回錯就以那個錯誤碼結算', async () => {
    const { client, host } = await readyHost(echoHost);
    expect(await client.call('s', 'echo', { a: [1, 'x'] })).toEqual({ a: [1, 'x'] });
    const failed = client.call('s', 'fail', null);
    await expect(failed).rejects.toThrow(HostCallError);
    expect(await codeOf(client.call('s', 'fail', null))).toBe('unknown_method');
    expect(host.received.filter((m) => m.type === 'call').map((m) => m.service)).toEqual([
      's',
      's',
      's',
    ]);
  });

  it('串流的方法照 seq 交塊，再回結果', async () => {
    const { client } = await readyHost(echoHost);
    const chunks: Json[] = [];
    expect(await client.call('s', 'stream', null, { onChunk: (p) => chunks.push(p) })).toBe(2);
    expect(chunks).toEqual(['a', 'b']);
  });

  it('取消：當場以 cancelled 結算並送 cancel；宿主之後回的 result 丟掉，連線照常', async () => {
    const { client, host, logs } = await readyHost((message, reply) => {
      if (message.type === 'cancel') {
        reply({
          type: 'result',
          side: 'c',
          id: message.id,
          error: { code: 'cancelled', message: '' },
        });
      } else echoHost(message, reply);
    });
    const abort = new AbortController();
    const hanging = client.call('s', 'hang', null, { signal: abort.signal });
    await eventually(() => host.received.some((m) => m.type === 'call'));
    abort.abort();
    expect(await codeOf(hanging)).toBe('cancelled');
    await eventually(() => host.received.some((m) => m.type === 'cancel'));
    const [call] = host.received.filter((m) => m.type === 'call');
    expect(host.received.find((m) => m.type === 'cancel')?.id).toBe(call?.id);
    expect(await client.call('s', 'echo', 1)).toBe(1);
    expect(host.connections()).toBe(1);
    expect(logs).toEqual(['[宿主] 連上了']);
  });

  it('已經中止的 signal 不送出', async () => {
    const { client, host } = await readyHost(echoHost);
    expect(await codeOf(client.call('s', 'echo', 1, { signal: AbortSignal.abort() }))).toBe(
      'cancelled',
    );
    expect(host.received.some((m) => m.type === 'call')).toBe(false);
  });

  it('onChunk 丟錯：呼叫以那個錯結算，並送 cancel', async () => {
    const { client, host } = await readyHost(echoHost);
    const boom = new Error('收不下');
    await expect(
      client.call('s', 'stream', null, {
        onChunk: () => {
          throw boom;
        },
      }),
    ).rejects.toBe(boom);
    await eventually(() => host.received.some((m) => m.type === 'cancel'));
  });

  it('送出之後斷線：在跑的呼叫以 host_lost 結算；重連之後 onReady 再叫一次', async () => {
    const { client, host } = await readyHost(() => undefined);
    let readies = 0;
    client.onReady(() => {
      readies += 1;
    });
    const hanging = client.call('s', 'hang', null);
    await eventually(() => host.received.some((m) => m.type === 'call'));
    host.dropAll();
    expect(await codeOf(hanging)).toBe('host_lost');
    await eventually(() => readies === 1 && client.state === 'ready');
  });

  it('還沒 ready 是 host_unavailable，close 之後是 host_absent，在跑的以 host_lost 結算', async () => {
    const path = socketPath();
    const pending = clientAt(path);
    expect(await codeOf(pending.call('s', 'echo', 1))).toBe('host_unavailable');

    const { client } = await readyHost(() => undefined);
    const hanging = client.call('s', 'hang', null);
    client.close();
    expect(await codeOf(hanging)).toBe('host_lost');
    expect(await codeOf(client.call('s', 'echo', 1))).toBe('host_absent');
  });

  it.each<[string, (id: number) => object]>([
    ['不認得的 id', (id) => ({ type: 'result', side: 'c', id: id + 1000, ok: null })],
    ['seq 跳號', (id) => ({ type: 'chunk', side: 'c', id, seq: 1, payload: null })],
    ["side 是 'h'", (id) => ({ type: 'result', side: 'h', id, ok: null })],
  ])('%s：當成這條連線壞了，在跑的 host_lost，重連', async (_name, bad) => {
    const { client, host } = await readyHost((message, reply) => {
      if (message.type === 'call' && message.id !== undefined) reply(bad(message.id));
    });
    expect(await codeOf(client.call('s', 'x', null))).toBe('host_lost');
    await eventually(() => host.connections() === 2 && client.state === 'ready');
  });

  it('事件交給 onEvent；處理丟錯只記 log，連線照常', async () => {
    const { client, host, logs } = await readyHost((message, reply) => {
      if (message.type === 'call') {
        reply({ type: 'event', service: 's', topic: 'ping', payload: { n: 1 } });
        reply({ type: 'result', side: 'c', id: message.id, ok: null });
      }
    });
    const events: unknown[] = [];
    client.onEvent(() => {
      throw new Error('壞了');
    });
    client.onEvent((event) => events.push(event));
    await client.call('s', 'emit', null);
    expect(events).toEqual([{ type: 'event', service: 's', topic: 'ping', payload: { n: 1 } }]);
    expect(logs).toContain('[宿主] 事件的處理丟了錯：壞了');
    expect(host.connections()).toBe(1);
  });

  it('同一塊裡壞框後面跟著 hello：那條已經關了，不算連上', async () => {
    // 兩框要落在同一次 data 裡，才走得到「前一框關掉之後同一個迴圈還有下一框」。
    const path = socketPath();
    let connections = 0;
    const server = createServer((socket) => {
      connections += 1;
      socket.once('data', () => {
        socket.write(
          Buffer.concat([
            frame(
              Buffer.from(
                JSON.stringify({ type: 'event', service: 's', topic: 't', payload: null }),
              ),
            ),
            frame(Buffer.from(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION }))),
          ]),
        );
      });
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    );
    const logs: string[] = [];
    const client = clientAt(path, logs);
    let readies = 0;
    client.onReady(() => {
      readies += 1;
    });
    // 等它重連兩輪：每一輪都停在這種失敗，從沒被當成連上。
    await eventually(() => connections >= 3);
    client.close();
    expect(readies).toBe(0);
    expect(logs).not.toContain('[宿主] 連上了');
  });

  it('ready listener 裡 close 之後，同一塊裡的下一個 hello 不讓它復活', async () => {
    const path = socketPath();
    const hello = frame(Buffer.from(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION })));
    const server = createServer((socket) => {
      socket.once('data', () => socket.write(Buffer.concat([hello, hello])));
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    );
    const client = clientAt(path);
    let readies = 0;
    client.onReady(() => {
      readies += 1;
      client.close();
    });
    await eventually(() => readies > 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readies).toBe(1);
    expect(client.state).toBe('closed');
  });

  it('ready 而且閒著時沒有任何計時器', async () => {
    // 連線的計時器都 unref，`process.getActiveResourcesInfo()` 看不到，所以用假計時器數。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const { client } = await readyHost(echoHost);
      await client.call('s', 'echo', 1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createHostBridge', () => {
  it('沒有宿主的門面一律 host_absent', async () => {
    expect(await codeOf(ABSENT_HOST_BRIDGE.call('s', 'm', null))).toBe('host_absent');
  });

  it('還沒接上連線：等到上限回 host_unavailable；上限內接上就照常呼叫', async () => {
    const lonely = createHostBridge({ waitMs: 30 });
    expect(await codeOf(lonely.bridge.call('s', 'echo', 1))).toBe('host_unavailable');

    const path = socketPath();
    const host = scriptedHost(path, echoHost);
    cleanups.push(host.close);
    await host.listening;
    const handle = createHostBridge({ waitMs: 5_000 });
    const early = handle.bridge.call('s', 'echo', 7);
    handle.attach(clientAt(path));
    expect(await early).toBe(7);
  });

  it('接上了但一直連不上：到上限回 host_unavailable', async () => {
    const handle = createHostBridge({ waitMs: 30 });
    handle.attach(clientAt(socketPath()));
    expect(await codeOf(handle.bridge.call('s', 'echo', 1))).toBe('host_unavailable');
  });

  it('onReady 在每次連上時叫，登記時已經 ready 也叫；onEvent 照服務名分', async () => {
    const path = socketPath();
    const host = scriptedHost(path, (message, reply) => {
      if (message.type === 'call') {
        reply({ type: 'event', service: 'a', topic: 'x', payload: 1 });
        reply({ type: 'event', service: 'b', topic: 'y', payload: 2 });
        reply({ type: 'result', side: 'c', id: message.id, ok: null });
      }
    });
    cleanups.push(host.close);
    await host.listening;
    const handle = createHostBridge();
    let readies = 0;
    handle.bridge.onReady(() => {
      readies += 1;
    });
    const client = clientAt(path);
    handle.attach(client);
    await eventually(() => readies === 1);
    let late = 0;
    handle.bridge.onReady(() => {
      late += 1;
    });
    expect(late).toBe(1);

    const seen: unknown[] = [];
    const service = defineHostService('a')(handle.bridge);
    const off = service.onEvent((topic, payload) => seen.push([topic, payload]));
    await service.call('m', null);
    expect(seen).toEqual([['x', 1]]);
    off();
    await service.call('m', null);
    expect(seen).toEqual([['x', 1]]);
    expect(
      host.received.filter((m) => m.type === 'call').map((m) => [m.service, m.method]),
    ).toEqual([
      ['a', 'm'],
      ['a', 'm'],
    ]);

    host.dropAll();
    await eventually(() => readies === 2 && late === 2);
  });

  it('等連線的期間取消：當場以 cancelled 結算，不送出', async () => {
    const lonely = createHostBridge({ waitMs: 5_000 });
    const controller = new AbortController();
    const waiting = codeOf(lonely.bridge.call('s', 'echo', 1, { signal: controller.signal }));
    controller.abort();
    expect(await waiting).toBe('cancelled');

    const path = socketPath();
    const host = scriptedHost(path, echoHost);
    cleanups.push(host.close);
    const handle = createHostBridge({ waitMs: 5_000 });
    handle.attach(clientAt(path));
    const connecting = new AbortController();
    const pending = codeOf(handle.bridge.call('s', 'echo', 2, { signal: connecting.signal }));
    connecting.abort();
    expect(await pending).toBe('cancelled');
    await host.listening;
    expect(await handle.bridge.call('s', 'echo', 3)).toBe(3);
    expect(host.received.filter((m) => m.type === 'call').map((m) => m.payload)).toEqual([3]);
  });

  it('一個 listener 丟錯，其他照叫，錯由連線記 log', async () => {
    const path = socketPath();
    const host = scriptedHost(path, (message, reply) => {
      if (message.type === 'call') {
        reply({ type: 'event', service: 'a', topic: 'x', payload: 1 });
        reply({ type: 'result', side: 'c', id: message.id, ok: null });
      }
    });
    cleanups.push(host.close);
    await host.listening;
    const handle = createHostBridge();
    let readies = 0;
    handle.bridge.onReady(() => {
      throw new Error('ready 壞了');
    });
    handle.bridge.onReady(() => {
      readies += 1;
    });
    const seen: unknown[] = [];
    handle.bridge.onEvent('a', () => {
      throw new Error('事件壞了');
    });
    handle.bridge.onEvent('a', (topic) => seen.push(topic));
    const logs: string[] = [];
    handle.attach(clientAt(path, logs));
    await eventually(() => readies === 1);
    await handle.bridge.call('a', 'm', null);
    expect(seen).toEqual(['x']);
    expect(logs).toContain('[宿主] ready 的處理丟了錯：ready 壞了');
    expect(logs).toContain('[宿主] 事件的處理丟了錯：事件壞了');
  });

  it('只能接一次', () => {
    const handle = createHostBridge();
    handle.attach(clientAt(socketPath()));
    expect(() => {
      handle.attach(clientAt(socketPath()));
    }).toThrow('宿主連線已經接過了');
  });
});
