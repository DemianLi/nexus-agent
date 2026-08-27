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
  const responded: unknown[] = [];
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
    inputRespond: async (_threadId, params) => {
      responded.push(params);
      return { type: 'success', id: 2, result: {} };
    },
  };
  return { client, sent, responded };
}

/** 一顆核准請求。逐筆詞彙照基座的形狀給——`reviewConfigs` 與 `actionRequests` 平行。 */
function approvalFrame(actions: readonly { name: string; allowed: readonly string[] }[]): Event {
  return frame('input.requested', ['tools:a'], {
    interrupt_id: 'int-1',
    payload: {
      actionRequests: actions.map((action) => ({ name: action.name, args: { n: action.name } })),
      reviewConfigs: actions.map((action) => ({
        actionName: action.name,
        allowedDecisions: [...action.allowed],
      })),
    },
  });
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

describe('核准請求', () => {
  it('畫出來、按下去，而且一個決定送滿整批', async () => {
    seq = 0;
    const { client, responded } = fakeClient([
      frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
      approvalFrame([
        { name: 'alpha', allowed: ['approve', 'reject'] },
        { name: 'beta', allowed: ['approve', 'reject'] },
      ]),
      // 中斷那一輪照樣發 completed——它不能把卡片收掉。
      frame('lifecycle', [], { event: 'completed', graph_name: 'root' }),
    ]);
    render(<App client={client} />);

    await waitFor(() => expect(screen.getByTestId('approval-card')).toBeTruthy());
    expect(screen.getByText('alpha')).toBeTruthy();
    expect(screen.getByText('beta')).toBeTruthy();
    // 等核准時送不出下一句話：基座那時會把中斷靜靜丟掉。
    expect(screen.getByRole('button', { name: '送出' }).hasAttribute('disabled')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '全部核准' }));

    await waitFor(() => expect(responded.length).toBe(1));
    // **兩筆決定，不是一筆**：基座逐 index 配對，長度不符會殺掉整場 run。
    expect(responded[0]).toEqual({
      namespace: ['tools:a'],
      interrupt_id: 'int-1',
      response: { decisions: [{ type: 'approve' }, { type: 'approve' }] },
    });
    // 按完卡片就收掉，而且畫面上留下人按了什麼——線上不會回聲這件事。
    await waitFor(() => expect(screen.queryByTestId('approval-card')).toBeNull());
    expect(screen.getByTestId('decision-entry').textContent).toContain('已核准');
  });

  it('一顆按鈕都長不出來時不把對話鎖死', async () => {
    seq = 0;
    // 交集是空的（基座一定會發 reviewConfigs，所以這是防呆）——那時卡片沒有出路，
    // 再把送出框鎖起來就是整條對話卡死。
    const { client } = fakeClient([approvalFrame([{ name: 'alpha', allowed: [] }])]);
    render(<App client={client} />);

    await waitFor(() => expect(screen.getByTestId('approval-card')).toBeTruthy());
    expect(screen.getByText(/這裡按不了/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('要說的話'), { target: { value: '換條路' } });
    expect(screen.getByRole('button', { name: '送出' }).hasAttribute('disabled')).toBe(false);
  });

  it('按鈕只長出交集裡的那些', async () => {
    seq = 0;
    const { client } = fakeClient([
      approvalFrame([
        { name: 'alpha', allowed: ['approve', 'reject'] },
        { name: 'beta', allowed: ['approve'] },
      ]),
    ]);
    render(<App client={client} />);

    await waitFor(() => expect(screen.getByTestId('approval-card')).toBeTruthy());
    expect(screen.getByRole('button', { name: '全部核准' })).toBeTruthy();
    // 多出來的那顆「全部拒絕」按下去是整場 run 死——基座對 beta 不接受 reject。
    expect(screen.queryByRole('button', { name: '全部拒絕' })).toBeNull();
  });
});

describe('上行被拒絕的時候', () => {
  it('說出來，而不是靜靜吞掉——那是 200 ＋ error 封包', async () => {
    seq = 0;
    const client: WireClient = {
      openEvents: async () =>
        (async function* stream() {
          yield frame('lifecycle', [], { event: 'completed', graph_name: 'root' });
          await new Promise(() => undefined);
        })(),
      runStart: async () => ({
        type: 'error',
        id: 1,
        error: 'invalid_argument',
        message: '這條 thread 停在核准點：先用 input.respond 回答它，再說下一句話',
      }),
      inputRespond: async () => ({ type: 'success', id: 2, result: {} }),
    };
    render(<App client={client} />);

    await waitFor(() => expect(screen.getByPlaceholderText('說點什麼…')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('要說的話'), { target: { value: '一句話' } });
    fireEvent.click(screen.getByRole('button', { name: '送出' }));

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('這個動作沒送出去'),
    );
    expect(screen.getByRole('status').textContent).toContain('停在核准點');
  });
});
