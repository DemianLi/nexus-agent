import type { Event, WireClient } from '@nexus/wire';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from '@/App';

afterEach(cleanup);

/**
 * 畫面這一層。
 *
 * **折疊的正確性不在這裡驗**——那在 `@nexus/wire`（單元）與 `@nexus/harness`
 * （對著真的 agent 跑過真的線）。這裡只驗「折出來的東西有沒有畫出來」，所以 client
 * 是假的、frame 是手餵的。
 */

let seq = 0;

function frame(method: string, namespace: readonly string[], data: unknown): Event {
  const current = seq++;
  return {
    type: 'event',
    seq: current,
    event_id: `t:${current}`,
    method,
    params: { namespace, timestamp: 0, data },
  } as Event;
}

function textFrames(id: string, namespace: readonly string[], body: string): Event[] {
  return [
    frame('messages', namespace, { event: 'message-start', id: `run-${id}`, run_id: id }),
    ...[...body].map((character) =>
      frame('messages', namespace, {
        event: 'content-block-delta',
        index: 0,
        delta: { type: 'text-delta', text: character },
        run_id: id,
      }),
    ),
    frame('messages', namespace, { event: 'message-finish', reason: 'stop', run_id: id }),
  ];
}

/** 一個可以隨時推 frame 進去的假 client。 */
function fakeClient(events: readonly Event[]) {
  const sent: string[] = [];
  const client: WireClient = {
    openEvents: async () =>
      (async function* stream() {
        for (const event of events) {
          yield event;
        }
        await new Promise(() => undefined);
      })(),
    runStart: async (_threadId, text) => {
      sent.push(text);
      return { type: 'success', id: 1, result: {} };
    },
    inputRespond: async () => ({ type: 'success', id: 2, result: {} }),
  };
  return { client, sent };
}

describe('對話介面', () => {
  it('把折出來的訊息、工具與子代理歸屬畫出來', async () => {
    seq = 0;
    const { client } = fakeClient([
      frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
      ...textFrames('root-1', ['model_request:a'], '兩個都派。'),
      frame('tools', ['tools:x'], {
        event: 'tool-started',
        tool_call_id: 'call_1_0',
        tool_name: 'task',
        input: '{"subagent_type":"writer"}',
      }),
      ...textFrames('sub-1', ['tools:x', 'model_request:b'], 'writer 寫好了。'),
      frame('tools', ['tools:y'], {
        event: 'tool-started',
        tool_call_id: 'call_1_1',
        tool_name: 'take_note',
        input: '{"text":"甲"}',
      }),
      frame('lifecycle', [], { event: 'completed', graph_name: 'root' }),
    ]);

    render(<App client={client} />);

    await waitFor(() => expect(screen.getByText('兩個都派。')).toBeTruthy());
    expect(screen.getByText('writer 寫好了。')).toBeTruthy();
    // 歸屬是折疊器 join 出來的：線上沒有 subagent 的名字。
    expect(screen.getByText('子代理 writer')).toBeTruthy();
    expect(screen.getByText('take_note')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('就緒'));
  });

  it('送出之前先把使用者那句話放上去——線上不會回聲它', async () => {
    seq = 0;
    const { client, sent } = fakeClient([
      frame('lifecycle', [], { event: 'completed', graph_name: 'root' }),
    ]);
    render(<App client={client} />);

    await waitFor(() => expect(screen.getByPlaceholderText('說點什麼…')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('要說的話'), { target: { value: '記一筆。' } });
    fireEvent.click(screen.getByRole('button', { name: '送出' }));

    await waitFor(() => expect(screen.getByText('記一筆。')).toBeTruthy());
    expect(sent).toEqual(['記一筆。']);
  });

  it('連不上就說連不上，不是一片空白', async () => {
    const client: WireClient = {
      openEvents: async () => {
        throw new Error('下行開不起來：502');
      },
      runStart: async () => ({ type: 'success', id: 1, result: {} }),
      inputRespond: async () => ({ type: 'success', id: 1, result: {} }),
    };
    render(<App client={client} />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('連不上 agent'));
  });
});
