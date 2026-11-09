import type { Event, WireClient } from '@nexus/wire';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useConversation } from '@/hooks/use-conversation';

/**
 * 交回宿主頁工具的結果（[#2374](https://github.com/DemianLi/nexus-agent/issues/2374)）：送出的形狀與本地收掉那一支。轉交給宿主頁、
 * 每顆一次那一層在 `embed/nexus-chat-element.test.tsx`。
 */

afterEach(cleanup);

const frame = (seq: number, method: string, namespace: readonly string[], data: unknown): Event =>
  ({
    type: 'event',
    seq,
    event_id: `t:${seq}`,
    method,
    params: { namespace, timestamp: 0, data },
  }) as Event;

function setup(reply: { readonly type: 'success' } | { readonly type: 'error' }) {
  const responded: unknown[] = [];
  const events = [
    frame(0, 'lifecycle', [], { event: 'running', graph_name: 'root' }),
    frame(1, 'input.requested', ['tools:a'], {
      interrupt_id: 'h-1',
      payload: { kind: 'host_tool', name: 'focus_device', args: { id: 'P-101' } },
    }),
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
    inputRespond: async (_threadId: string, params: unknown) => {
      responded.push(params);
      return reply.type === 'success'
        ? { type: 'success', id: 1, result: {} }
        : { type: 'error', id: 1, error: 'no_such_interrupt', message: '那顆中斷已經不在了' };
    },
  } as unknown as WireClient;
  return { client, responded };
}

describe('respondHostCall', () => {
  it('送 input.respond、本地收掉那一支，回 server 收下了', async () => {
    const { client, responded } = setup({ type: 'success' });
    const { result } = renderHook(() => useConversation({ client, threadId: 't' }));
    await waitFor(() => expect(result.current.state.hostCalls).toHaveLength(1));
    const call = result.current.state.hostCalls[0];
    if (call === undefined) throw new Error('沒有待決的宿主頁工具');
    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await result.current.respondHostCall(call, { ok: true, result: 'done' });
    });
    expect(accepted).toBe(true);
    expect(responded).toEqual([
      { namespace: ['tools:a'], interrupt_id: 'h-1', response: { ok: true, result: 'done' } },
    ]);
    expect(result.current.state.hostCalls).toEqual([]);
  });

  it('server 不收：回 false，狀態列不寫', async () => {
    const { client } = setup({ type: 'error' });
    const { result } = renderHook(() => useConversation({ client, threadId: 't' }));
    await waitFor(() => expect(result.current.state.hostCalls).toHaveLength(1));
    const call = result.current.state.hostCalls[0];
    if (call === undefined) throw new Error('沒有待決的宿主頁工具');
    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await result.current.respondHostCall(call, { ok: false, error: 'x' });
    });
    expect(accepted).toBe(false);
    expect(result.current.commandError).toBeUndefined();
  });
});
