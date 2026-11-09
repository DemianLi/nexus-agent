import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { HostClient } from './client.js';
import { FrameReader, PROTOCOL_VERSION, frame } from './protocol.js';

type Reply = 'hello' | 'rejected' | 'wrong-version' | 'garbage';

/** 假宿主：每條連線收到第一框之後照 `replies` 的第 n 個回答（用完就重複最後一個），收到的框都記下來。 */
function fakeHost(path: string, replies: readonly Reply[]) {
  const hellos: unknown[] = [];
  const sockets: Socket[] = [];
  let n = 0;
  const server: Server = createServer((socket) => {
    sockets.push(socket);
    const reply = replies[Math.min(n, replies.length - 1)];
    n += 1;
    const reader = new FrameReader();
    socket.on('data', (chunk: Buffer) => {
      for (const payload of reader.push(chunk)) {
        hellos.push(JSON.parse(payload.toString('utf8')));
        if (reply === 'hello')
          socket.write(
            frame(Buffer.from(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION }))),
          );
        if (reply === 'wrong-version')
          socket.write(frame(Buffer.from(JSON.stringify({ type: 'hello', version: 99 }))));
        if (reply === 'garbage') socket.write(frame(Buffer.from('[')));
        if (reply === 'rejected')
          socket.end(frame(Buffer.from(JSON.stringify({ type: 'rejected', reason: '沒有登記' }))));
      }
    });
    socket.on('error', () => undefined);
  });
  const listening = new Promise<void>((resolve) => server.listen(path, resolve));
  return {
    hellos,
    listening,
    connections: () => n,
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

function setup(): { path: string; logs: string[]; client: (path?: string) => HostClient } {
  const dir = mkdtempSync(join(tmpdir(), 'host-bridge-'));
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const path = join(dir, 'host.sock');
  const logs: string[] = [];
  return {
    path,
    logs,
    client: (at = path) => {
      const client = new HostClient({
        socketPath: at,
        token: 'abc',
        log: (line) => logs.push(line),
        backoffMs: 10,
        backoffMaxMs: 40,
      });
      cleanups.push(() => {
        client.close();
      });
      return client;
    },
  };
}

async function eventually(check: () => boolean): Promise<void> {
  const until = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > until) throw new Error('等不到');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('HostClient', () => {
  it('連上先送帶 token 的 hello，宿主回 hello 就 ready', async () => {
    const { path, logs, client } = setup();
    const host = fakeHost(path, ['hello']);
    cleanups.push(host.close);
    await host.listening;
    const c = client();
    expect(await c.waitReady(5_000)).toBe(true);
    expect(c.state).toBe('ready');
    expect(host.hellos).toEqual([{ type: 'hello', version: PROTOCOL_VERSION, token: 'abc' }]);
    expect(logs).toEqual(['[宿主] 連上了']);
  });

  it('宿主還不在：有上限的等待到時回 false；宿主起來之後自己連上', async () => {
    const { path, logs, client } = setup();
    const c = client();
    expect(await c.waitReady(50)).toBe(false);
    expect(c.state).toBe('connecting');
    const host = fakeHost(path, ['hello']);
    cleanups.push(host.close);
    await host.listening;
    expect(await c.waitReady(5_000)).toBe(true);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatch(/^\[宿主\] 連不上（.*），重連中$/);
    expect(logs[1]).toBe('[宿主] 連上了');
  });

  it.each<Reply>(['rejected', 'wrong-version', 'garbage'])(
    '宿主回 %s：關掉重連，下一次收下就 ready',
    async (first) => {
      const { path, logs, client } = setup();
      const host = fakeHost(path, [first, 'hello']);
      cleanups.push(host.close);
      await host.listening;
      const c = client();
      expect(await c.waitReady(5_000)).toBe(true);
      expect(host.connections()).toBe(2);
      expect(logs[0]).toMatch(/重連中$/);
      if (first === 'rejected') expect(logs[0]).toContain('宿主拒絕：沒有登記');
    },
  );

  it('ready 之後斷線：記一行、重連，同一個 token 再送一次', async () => {
    const { path, logs, client } = setup();
    const host = fakeHost(path, ['hello']);
    cleanups.push(host.close);
    await host.listening;
    const c = client();
    expect(await c.waitReady(5_000)).toBe(true);
    host.dropAll();
    await eventually(() => host.connections() === 2 && c.state === 'ready');
    expect(host.hellos).toEqual([
      { type: 'hello', version: PROTOCOL_VERSION, token: 'abc' },
      { type: 'hello', version: PROTOCOL_VERSION, token: 'abc' },
    ]);
    expect(logs).toEqual(['[宿主] 連上了', '[宿主] 斷線（連線關了），重連中', '[宿主] 連上了']);
  });

  it('一段連不上的期間只記第一次失敗', async () => {
    const { logs, client } = setup();
    const c = client();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(c.state).toBe('connecting');
    expect(logs).toHaveLength(1);
  });

  it('close 讓等待中的回 false，之後不再重連', async () => {
    const { path, client } = setup();
    const c = client();
    const waiting = c.waitReady(5_000);
    c.close();
    expect(await waiting).toBe(false);
    expect(c.state).toBe('closed');
    const host = fakeHost(path, ['hello']);
    cleanups.push(host.close);
    await host.listening;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(host.connections()).toBe(0);
    expect(await c.waitReady(10)).toBe(false);
  });
});
