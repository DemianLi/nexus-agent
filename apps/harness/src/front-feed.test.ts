import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Event, ThreadFeedFrame } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { FrontFeed } from './front-feed.js';
import { FrontForwarder } from './front-forward.js';

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** 一題 `input.requested`。 */
function question(interruptId: string): Event {
  return {
    type: 'event',
    method: 'input.requested',
    params: { namespace: [], data: { interrupt_id: interruptId, payload: {} } },
  } as unknown as Event;
}

/** 假的對話行程：`/threads/feed` 開著的線收 {@link push} 的每一顆，`activity` 答 `activity`。 */
async function conversation(threadId: string, activity: string[] = []) {
  const dir = await mkdtemp(join(tmpdir(), 'front-feed-'));
  const socket = join(dir, 'c.sock');
  const lines = new Set<ServerResponse>();
  let opened = 0;
  const seed: ThreadFeedFrame[] = [];
  const server = createServer((request, response) => {
    if (request.url === '/threads/feed') {
      opened += 1;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
      for (const frame of seed) response.write(`data: ${JSON.stringify(frame)}\n\n`);
      lines.add(response);
      response.once('close', () => lines.delete(response));
      return;
    }
    if (request.url === `/internal/threads/${threadId}/activity`) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ activity }));
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
  return {
    socket,
    seed,
    opened: () => opened,
    lines: () => lines.size,
    push: (frame: ThreadFeedFrame) => {
      for (const line of lines) line.write(`data: ${JSON.stringify(frame)}\n\n`);
    },
    cut: () => {
      for (const line of lines) line.destroy();
    },
  };
}

function frontFeed() {
  const forwarder = new FrontForwarder();
  const warnings: string[] = [];
  const feed = new FrontFeed({ forwarder, warn: (message) => warnings.push(message) });
  cleanups.push(() => {
    feed.close();
    forwarder.close();
  });
  return { feed, warnings };
}

/** 開一條前台的線，收到的照順序記在 `frames`。 */
function listen(feed: FrontFeed) {
  const controller = new AbortController();
  const frames: ThreadFeedFrame[] = [];
  const line = feed.feed.subscribe(controller.signal);
  void (async () => {
    for await (const frame of line) frames.push(frame);
  })();
  cleanups.push(() => controller.abort());
  return frames;
}

describe('FrontFeed', () => {
  it('對話行程那條線上的每一顆照原樣轉給前台的線；還掛著的題由前台補送給後開的線', async () => {
    const upstream = await conversation('t1');
    const { feed } = frontFeed();
    const early = listen(feed);
    feed.up('t1', upstream.socket);
    await expect.poll(() => upstream.lines()).toBe(1);

    upstream.push({ type: 'status', threadId: 't1', running: true });
    upstream.push({ type: 'input-requested', threadId: 't1', event: question('i1') });
    upstream.push({ type: 'input-requested', threadId: 't1', event: question('i2') });
    upstream.push({ type: 'input-withdrawn', threadId: 't1', interruptId: 'i1' });
    await expect.poll(() => early.length).toBe(4);
    expect(early.map(({ type }) => type)).toEqual([
      'status',
      'input-requested',
      'input-requested',
      'input-withdrawn',
    ]);
    expect(feed.running('t1')).toBe(true);

    const late = listen(feed);
    await expect.poll(() => late.length).toBe(1);
    expect(late[0]).toEqual({ type: 'input-requested', threadId: 't1', event: question('i2') });
  });

  it('接上時問一次在跑沒：在跑就補一顆狀態框，列表也答在跑', async () => {
    const upstream = await conversation('t1', ['turn']);
    const { feed } = frontFeed();
    const frames = listen(feed);
    expect(feed.running('t1')).toBeUndefined();
    feed.up('t1', upstream.socket);
    await expect.poll(() => feed.running('t1')).toBe(true);
    expect(frames).toEqual([{ type: 'status', threadId: 't1', running: true }]);
  });

  it('同一個 socket 重複 up 不重接', async () => {
    const upstream = await conversation('t1');
    const { feed } = frontFeed();
    feed.up('t1', upstream.socket);
    await expect.poll(() => upstream.lines()).toBe(1);
    feed.up('t1', upstream.socket);
    feed.up('t1', upstream.socket);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(upstream.opened()).toBe(1);
  });

  it('行程走了（down）：還掛著的題撤回，在跑的補一顆閒著，列表不再知道它', async () => {
    const upstream = await conversation('t1');
    const { feed } = frontFeed();
    const frames = listen(feed);
    feed.up('t1', upstream.socket);
    await expect.poll(() => upstream.lines()).toBe(1);
    upstream.push({ type: 'status', threadId: 't1', running: true });
    upstream.push({ type: 'input-requested', threadId: 't1', event: question('i1') });
    await expect.poll(() => frames.length).toBe(2);

    feed.down('t1');
    await expect.poll(() => frames.length).toBe(4);
    expect(frames.slice(2)).toEqual([
      { type: 'input-withdrawn', threadId: 't1', interruptId: 'i1' },
      { type: 'status', threadId: 't1', running: false },
    ]);
    expect(feed.running('t1')).toBeUndefined();
    await expect.poll(() => upstream.lines()).toBe(0);
  });

  it('對話行程那條線斷了：先撤回記著的題，重連後由它再補送', async () => {
    const upstream = await conversation('t1');
    const { feed, warnings } = frontFeed();
    const frames = listen(feed);
    feed.up('t1', upstream.socket);
    await expect.poll(() => upstream.lines()).toBe(1);
    upstream.push({ type: 'input-requested', threadId: 't1', event: question('i1') });
    await expect.poll(() => frames.length).toBe(1);

    upstream.seed.push({ type: 'input-requested', threadId: 't1', event: question('i1') });
    upstream.cut();
    await expect.poll(() => upstream.opened(), { timeout: 3_000 }).toBe(2);
    await expect.poll(() => frames.length).toBe(3);
    expect(frames.slice(1).map(({ type }) => type)).toEqual(['input-withdrawn', 'input-requested']);
    expect(warnings).toHaveLength(1);
  });

  it('別條 thread 的框不轉', async () => {
    const upstream = await conversation('t1');
    const { feed } = frontFeed();
    const frames = listen(feed);
    feed.up('t1', upstream.socket);
    await expect.poll(() => upstream.lines()).toBe(1);
    upstream.push({ type: 'input-requested', threadId: 'other', event: question('i1') });
    upstream.push({ type: 'status', threadId: 't1', running: true });
    await expect.poll(() => frames.some(({ type }) => type === 'status')).toBe(true);
    expect(frames).toEqual([{ type: 'status', threadId: 't1', running: true }]);
  });
});
