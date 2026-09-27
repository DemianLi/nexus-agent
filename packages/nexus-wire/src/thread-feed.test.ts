import { describe, expect, it } from 'vitest';

import { createWireClient } from './client.js';
import { THREAD_FEED_PATH, isThreadFeedFrame } from './protocol.js';
import type { Event, ThreadFeedFrame } from './protocol.js';
import { decodeSseData, encodeSseData } from './sse.js';

/**
 * 全部 thread 共用的那條下行的 client 那一半（#632）。server 那一半在 `@nexus/harness` 的 `thread-feed.test.ts`。
 */

const REQUEST = {
  type: 'event',
  seq: 3,
  event_id: 't:3',
  method: 'input.requested',
  params: { namespace: [], timestamp: 0, data: { interrupt_id: 'i1', payload: {} } },
} as Event;

const KNOWN: readonly ThreadFeedFrame[] = [
  { type: 'status', threadId: 't', running: true },
  { type: 'input-requested', threadId: 't', event: REQUEST },
  { type: 'input-withdrawn', threadId: 't', interruptId: 'i1' },
];

function sse(frames: readonly unknown[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(new TextEncoder().encode(encodeSseData('x', frame)));
      }
      controller.close();
    },
  });
}

async function collect<T>(stream: AsyncGenerator<T, void, undefined>): Promise<T[]> {
  const got: T[] = [];
  for await (const value of stream) got.push(value);
  return got;
}

describe('全域下行的 frame', () => {
  it('編進 SSE 再解回來是同一顆', async () => {
    expect(await collect(decodeSseData(sse(KNOWN)))).toEqual(KNOWN);
  });

  it('認得三種；不認得的種類、缺欄位、方法不對的都不認', () => {
    for (const frame of KNOWN) expect(isThreadFeedFrame(frame)).toBe(true);
    for (const frame of [
      null,
      'status',
      { type: 'added', threadId: 't' },
      { type: 'status', running: true },
      { type: 'status', threadId: 't', running: 'yes' },
      { type: 'input-requested', threadId: 't', event: { ...REQUEST, method: 'lifecycle' } },
      { type: 'input-requested', threadId: 't' },
      { type: 'input-withdrawn', threadId: 't' },
    ]) {
      expect(isThreadFeedFrame(frame)).toBe(false);
    }
  });

  it('client：GET 帶 content-type、只交出認得的，之後才加的種類跳過', async () => {
    const seen: { url: string; method?: string; contentType: string | null }[] = [];
    const client = createWireClient({
      baseUrl: 'http://agent.test/',
      fetch: async (input, init) => {
        seen.push({
          url: String(input),
          ...(init?.method === undefined ? {} : { method: init.method }),
          contentType: new Headers(init?.headers).get('content-type'),
        });
        return new Response(
          sse([KNOWN[0], { type: 'activity', threadId: 't', updatedAt: 1 }, ...KNOWN.slice(1)]),
          { headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
        );
      },
    });
    expect(await collect(await client.openThreadFeed())).toEqual(KNOWN);
    expect(seen).toEqual([
      {
        url: `http://agent.test${THREAD_FEED_PATH}`,
        method: 'GET',
        contentType: 'application/json',
      },
    ]);
  });

  it('client：不是 SSE 就拋，帶著原因', async () => {
    const client = createWireClient({
      baseUrl: 'http://agent.test',
      fetch: async () => new Response('unauthorized', { status: 401 }),
    });
    await expect(client.openThreadFeed()).rejects.toThrow('全域下行開不起來：401 unauthorized');
    const refused = createWireClient({
      baseUrl: 'http://agent.test',
      fetch: async () => Response.json({ type: 'error', error: 'unknown_error' }),
    });
    await expect(refused.openThreadFeed()).rejects.toThrow('全域下行被拒');
  });
});
