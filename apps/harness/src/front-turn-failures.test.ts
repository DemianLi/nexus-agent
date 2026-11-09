import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { FrontForwarder } from './front-forward.js';
import { FrontTurnFailures, TurnFailureOutbox } from './front-turn-failures.js';

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** 假的對話行程：`turn-failures` 接真的 {@link TurnFailureOutbox}；接了幾次記在 `connects`。 */
async function conversation(threadId: string) {
  const dir = await mkdtemp(join(tmpdir(), 'front-turn-failures-'));
  const socket = join(dir, 'c.sock');
  const outbox = new TurnFailureOutbox();
  const state = { connects: 0 };
  const server = createServer((request, response) => {
    if (request.url === `/internal/threads/${threadId}/turn-failures` && request.method === 'GET') {
      state.connects += 1;
      const answer = outbox.stream();
      response.writeHead(answer.status, Object.fromEntries(answer.headers));
      const body = Readable.fromWeb(answer.body as never);
      request.once('close', () => body.destroy());
      body.pipe(response);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  const stop = async (): Promise<void> => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  cleanups.push(async () => {
    await stop().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  return { socket, outbox, state, stop };
}

function front() {
  const forwarder = new FrontForwarder();
  const counted = new Map<string, number>();
  const subject = new FrontTurnFailures({ forwarder });
  cleanups.push(() => {
    subject.close();
    forwarder.close();
  });
  const count = (code: string, n: number): void => {
    counted.set(code, (counted.get(code) ?? 0) + n);
  };
  return { subject, counted, count };
}

describe('FrontTurnFailures＋TurnFailureOutbox', () => {
  it('接上之前失敗的留著、接上時一起送；之後每失敗一次推一次', async () => {
    const upstream = await conversation('t1');
    upstream.outbox.record('RATE_LIMIT');
    upstream.outbox.record('RATE_LIMIT');
    const { subject, counted, count } = front();
    subject.countWith(count);
    subject.up('t1', upstream.socket);
    await expect.poll(() => counted.get('RATE_LIMIT')).toBe(2);

    upstream.outbox.record('TIMEOUT');
    upstream.outbox.record('RATE_LIMIT');
    await expect.poll(() => Object.fromEntries(counted)).toEqual({ RATE_LIMIT: 3, TIMEOUT: 1 });
  });

  it('沒接計數那一支（指標關著）就不開線；接上時才開', async () => {
    const upstream = await conversation('t1');
    const { subject, counted, count } = front();
    subject.up('t1', upstream.socket);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(upstream.state.connects).toBe(0);
    upstream.outbox.record('RATE_LIMIT');
    subject.countWith(count);
    await expect.poll(() => counted.get('RATE_LIMIT')).toBe(1);
  });

  it('行程走了計數不往下掉：下一個行程的接著加', async () => {
    const first = await conversation('t1');
    const second = await conversation('t1');
    const { subject, counted, count } = front();
    subject.countWith(count);
    subject.up('t1', first.socket);
    await expect.poll(() => first.state.connects).toBe(1);
    first.outbox.record('RATE_LIMIT');
    await expect.poll(() => counted.get('RATE_LIMIT')).toBe(1);
    subject.down('t1');
    await first.stop();

    second.outbox.record('RATE_LIMIT');
    subject.up('t1', second.socket);
    await expect.poll(() => counted.get('RATE_LIMIT')).toBe(2);
  });

  it('線斷了（前台那頭收掉）：之後的失敗留著，下一條線接上時送', async () => {
    const upstream = await conversation('t1');
    const first = front();
    first.subject.countWith(first.count);
    first.subject.up('t1', upstream.socket);
    await expect.poll(() => upstream.state.connects).toBe(1);
    first.subject.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    upstream.outbox.record('RATE_LIMIT');

    const second = front();
    second.subject.countWith(second.count);
    second.subject.up('t1', upstream.socket);
    await expect.poll(() => second.counted.get('RATE_LIMIT')).toBe(1);
    expect(first.counted.get('RATE_LIMIT')).toBeUndefined();
  });
});
