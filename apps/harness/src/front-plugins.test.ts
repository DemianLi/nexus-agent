import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FrontForwarder } from './front-forward.js';
import { FrontPluginBindings } from './front-plugins.js';
import type { LiveRowBinding } from './plugin-live-versions.js';

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** 假的對話行程：`plugins` 答 `bindings` 現在的值，問了幾次記在 `asked`。 */
async function conversation(threadId: string) {
  const dir = await mkdtemp(join(tmpdir(), 'front-plugins-'));
  const socket = join(dir, 'c.sock');
  const state = { bindings: [] as LiveRowBinding[], asked: 0 };
  const server = createServer((request, response) => {
    if (request.url === `/internal/threads/${threadId}/plugins` && request.method === 'GET') {
      state.asked += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ bindings: state.bindings }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  return { socket, state };
}

function plugins() {
  const forwarder = new FrontForwarder();
  const bound: { threadId: string; bindings: readonly LiveRowBinding[] }[] = [];
  const released: string[] = [];
  const subject = new FrontPluginBindings({ forwarder });
  subject.bindWith(async (threadId, bindings) => {
    bound.push({ threadId, bindings });
    return async () => {
      released.push(threadId);
    };
  });
  cleanups.push(() => {
    subject.close();
    forwarder.close();
  });
  return { subject, bound, released };
}

const ROW: LiveRowBinding = { id: 'row-a', signature: 'sig-1' };

describe('FrontPluginBindings', () => {
  it('還沒組裝（答空的）就不綁，下一次轉送再問；問到了綁一次，之後不再問', async () => {
    const upstream = await conversation('t1');
    const { subject, bound, released } = plugins();
    subject.up('t1', upstream.socket);
    await expect.poll(() => upstream.state.asked).toBe(1);
    expect(bound).toEqual([]);

    upstream.state.bindings = [ROW];
    subject.touched('t1');
    await expect.poll(() => bound).toEqual([{ threadId: 't1', bindings: [ROW] }]);
    const asked = upstream.state.asked;
    subject.touched('t1');
    subject.touched('t1');
    // 監督行程重送同一個 socket 的 `up`（例如前台重連控制面）：不放掉、不重綁。
    subject.up('t1', upstream.socket);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(upstream.state.asked).toBe(asked);
    expect(bound).toHaveLength(1);
    expect(released).toEqual([]);
  });

  it('down 放掉；同一條換了 socket 先放掉舊的再重問', async () => {
    const first = await conversation('t1');
    const second = await conversation('t1');
    first.state.bindings = [ROW];
    second.state.bindings = [{ id: 'row-a', signature: 'sig-2' }];
    const { subject, bound, released } = plugins();
    subject.up('t1', first.socket);
    await expect.poll(() => bound.length).toBe(1);

    subject.up('t1', second.socket);
    await expect.poll(() => bound.length).toBe(2);
    expect(released).toEqual(['t1']);
    expect(bound[1]!.bindings).toEqual([{ id: 'row-a', signature: 'sig-2' }]);

    subject.down('t1');
    await expect.poll(() => released).toEqual(['t1', 't1']);
  });

  it('問到一半行程走了：綁上之後立刻放掉', async () => {
    const upstream = await conversation('t1');
    upstream.state.bindings = [ROW];
    const forwarder = new FrontForwarder();
    const released: string[] = [];
    let finishBind: () => void = () => {};
    const subject = new FrontPluginBindings({ forwarder });
    subject.bindWith(async (threadId) => {
      await new Promise<void>((resolve) => (finishBind = resolve));
      return async () => {
        released.push(threadId);
      };
    });
    cleanups.push(() => {
      subject.close();
      forwarder.close();
    });
    subject.up('t1', upstream.socket);
    await expect.poll(() => upstream.state.asked).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    subject.down('t1');
    finishBind();
    await expect.poll(() => released).toEqual(['t1']);
  });

  it('還沒接上綁定那一支之前的 up：接上時才問', async () => {
    const upstream = await conversation('t1');
    upstream.state.bindings = [ROW];
    const forwarder = new FrontForwarder();
    const subject = new FrontPluginBindings({ forwarder });
    cleanups.push(() => {
      subject.close();
      forwarder.close();
    });
    subject.up('t1', upstream.socket);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(upstream.state.asked).toBe(0);
    const bound: string[] = [];
    subject.bindWith(async (threadId) => {
      bound.push(threadId);
      return async () => {};
    });
    await expect.poll(() => bound).toEqual(['t1']);
  });
});
