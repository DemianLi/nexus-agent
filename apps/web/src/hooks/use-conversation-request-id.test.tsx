import type { Event, WireClient } from '@nexus/wire';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useConversation } from '@/hooks/use-conversation';

/**
 * `send` 的請求編號（[#1335](https://github.com/DemianLi/nexus-agent/issues/1335)）：呼叫端給了就原樣帶，沒給也現產一個，
 * **每一次 `run.start` 都帶**——沒帶的那一次，回條斷了重送就會排兩次。
 */

afterEach(cleanup);

function setup() {
  const started: { text: string; options: unknown }[] = [];
  const events: Event[] = [
    {
      type: 'event',
      seq: 0,
      event_id: 't:0',
      method: 'lifecycle',
      params: { namespace: [], timestamp: 0, data: { event: 'completed', graph_name: 'root' } },
    } as Event,
  ];
  const client = {
    openEvents: async () =>
      (async function* stream() {
        yield* events;
        await new Promise<void>(() => {});
      })(),
    threadHistory: async () => ({
      kind: 'ok',
      result: { events: [], firstSeq: 0, throughSeq: 0, hasMore: false, legacy: false },
    }),
    slashList: async () => ({ kind: 'ok', commands: [] }),
    runStart: async (_threadId: string, text: string, options?: unknown) => {
      started.push({ text, options });
      return { type: 'success', id: 1, result: { run_id: `run-${started.length}` } };
    },
  } as unknown as WireClient;
  return { client, started };
}

describe('send 的請求編號（#1335）', () => {
  it('呼叫端給了編號：原樣帶進 run.start', async () => {
    const { client, started } = setup();
    const { result } = renderHook(() => useConversation({ client, threadId: 't' }));
    await waitFor(() => expect(result.current.connected).toBe(true));
    await act(async () => {
      await result.current.send('一句話', undefined, undefined, undefined, 'req-1');
    });
    expect(started).toEqual([{ text: '一句話', options: { requestId: 'req-1' } }]);
  });

  it('沒給編號：這一次現產一個，兩次送出各不相同', async () => {
    const { client, started } = setup();
    const { result } = renderHook(() => useConversation({ client, threadId: 't' }));
    await waitFor(() => expect(result.current.connected).toBe(true));
    await act(async () => {
      await result.current.send('第一句');
      await result.current.send('第二句');
    });
    const [first, second] = started.map(
      ({ options }) => (options as { requestId?: string }).requestId,
    );
    expect(first).toEqual(expect.any(String));
    expect(second).toEqual(expect.any(String));
    expect(second).not.toBe(first);
  });

  it('插話也帶編號，mode 照舊', async () => {
    const { client, started } = setup();
    const { result } = renderHook(() => useConversation({ client, threadId: 't' }));
    await waitFor(() => expect(result.current.connected).toBe(true));
    await act(async () => {
      await result.current.send('插一句', 'steer', undefined, undefined, 'req-2');
    });
    expect(started[0]!.options).toEqual({ requestId: 'req-2', mode: 'steer' });
  });
});
