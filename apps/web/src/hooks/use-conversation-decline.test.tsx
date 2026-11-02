import type { Event, WireClient } from '@nexus/wire';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useConversation } from '@/hooks/use-conversation';

/**
 * 拒絕與取消一組 MCP 反問（[#1098](https://github.com/DemianLi/nexus-agent/issues/1098)）：送出的回覆形狀與留在本地的紀錄
 * （線上不回聲，送出的那一刻自己寫進去，trace 靠它長那一列）各自驗，兩個動作不能互相換。
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

function setup() {
  const responded: unknown[] = [];
  const events = [
    frame(0, 'lifecycle', [], { event: 'running', graph_name: 'root' }),
    frame(1, 'input.requested', ['tools:a'], {
      interrupt_id: 'q-1',
      payload: {
        kind: 'question',
        questions: [{ id: 'ok', question: '確定嗎？' }],
        origin: { kind: 'mcp-elicitation', server: 's', tool: 't', arguments: {} },
      },
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
      return { type: 'success', id: 1, result: {} };
    },
  } as unknown as WireClient;
  return { client, responded };
}

const answerEntry = (state: ReturnType<typeof useConversation>['state']) =>
  state.entries.find((entry) => entry.kind === 'answer');

describe('declineQuestion／dismissQuestion', () => {
  it('拒絕：送 {declined:true}，本地紀錄是 declined（不是 cancelled）', async () => {
    const { client, responded } = setup();
    const { result } = renderHook(() => useConversation({ client, threadId: 't' }));
    await waitFor(() => expect(result.current.state.pendings).toHaveLength(1));
    await act(async () => result.current.declineQuestion('q-1'));
    expect(responded).toEqual([
      { namespace: ['tools:a'], interrupt_id: 'q-1', response: { declined: true } },
    ]);
    expect(answerEntry(result.current.state)).toMatchObject({ declined: true, answers: [] });
    expect(answerEntry(result.current.state)).not.toHaveProperty('cancelled');
    expect(result.current.state.pendings).toHaveLength(0);
  });

  it('取消：送 {cancelled:true}，本地紀錄是 cancelled（不是 declined）', async () => {
    const { client, responded } = setup();
    const { result } = renderHook(() => useConversation({ client, threadId: 't' }));
    await waitFor(() => expect(result.current.state.pendings).toHaveLength(1));
    await act(async () => result.current.dismissQuestion('q-1'));
    expect(responded[0]).toMatchObject({ response: { cancelled: true } });
    expect(answerEntry(result.current.state)).toMatchObject({ cancelled: true });
    expect(answerEntry(result.current.state)).not.toHaveProperty('declined');
  });

  it('認不得的 id：什麼都不送', async () => {
    const { client, responded } = setup();
    const { result } = renderHook(() => useConversation({ client, threadId: 't' }));
    await waitFor(() => expect(result.current.state.pendings).toHaveLength(1));
    await act(async () => result.current.declineQuestion('nope'));
    expect(responded).toEqual([]);
    expect(result.current.state.pendings).toHaveLength(1);
  });
});
