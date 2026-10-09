import type {
  ConversationEntry,
  Event,
  ThreadHistoryOutcome,
  ToolEntry,
  UplinkResult,
  WireClient,
} from '@nexus/wire';
import { emptyConversation } from '@nexus/wire';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SubagentControlContext, useSubagentControl } from '@/components/tool/subagent-control';
import { Transcript } from '@/components/transcript';

/**
 * 委派卡上對背景子代理說話與單獨停止（[#869](https://github.com/DemianLi/nexus-agent/issues/869)）。
 * 元件用真的 `useSubagentControl`，client 是假的：驗「畫面對各種狀態與回應怎麼反應」，不驗 wire（那在 `@nexus/wire`
 * 與 harness 的測試）。
 */

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const delegation = (meta?: ToolEntry['meta']): ToolEntry => ({
  kind: 'tool',
  id: 'tool-d',
  callId: 'call-d',
  name: 'subagent',
  input: '{}',
  status: 'done',
  attribution: { kind: 'root' },
  ...(meta === undefined ? {} : { meta }),
});
const BACKGROUND = {
  kind: 'background-subagent',
  runId: 'bg-1',
  subagentType: 'researcher',
} as const;

const ok: UplinkResult = { type: 'success', id: 1, result: { accepted: true } };
const refused = (error: string, message = '被拒'): UplinkResult =>
  ({ type: 'error', id: 1, error, message }) as UplinkResult;

const frame = (method: string, data: unknown): Event =>
  ({ type: 'event', method, params: { namespace: [], timestamp: 0, data } }) as Event;
const said = (role: 'human' | 'ai', id: string, text: string): Event[] => [
  frame('messages', { event: 'message-start', role, id }),
  frame('messages', {
    event: 'content-block-delta',
    index: 0,
    delta: { type: 'text-delta', text },
    id,
  }),
  frame('messages', { event: 'message-finish', reason: 'stop', id }),
];
const historyOf = (events: Event[], hasMore = false): ThreadHistoryOutcome => ({
  kind: 'ok',
  result: { events, firstSeq: 0, throughSeq: 9, hasMore, legacy: false },
});
const EMPTY_HISTORY = historyOf([]);

/** 外面給的畫法的替身：只標出是哪一種、寫了什麼，驗的是這一區放了哪些項目。 */
const renderStub = (entry: ConversationEntry) => (
  <div data-entry={entry.kind}>
    {entry.kind === 'tool' ? entry.name : (entry as { text: string }).text}
  </div>
);
const entryKinds = () =>
  [...document.querySelectorAll('[data-subagent-conversation] [data-entry]')].map((node) =>
    node.getAttribute('data-entry'),
  );

function fakeClient(over: Partial<WireClient> = {}) {
  const send = vi.fn(async (..._args: [string, string, string]): Promise<UplinkResult> => ok);
  const interrupt = vi.fn(async (..._args: [string, string]): Promise<UplinkResult> => ok);
  const history = vi.fn(async (): Promise<ThreadHistoryOutcome> => EMPTY_HISTORY);
  const client = {
    subagentSend: send,
    subagentHistory: history,
    subagentInterrupt: interrupt,
    ...over,
  } as unknown as WireClient;
  return { client, send, interrupt, history };
}

type Status = Readonly<Record<string, 'running' | 'idle'>> | null;

function Harness({
  client,
  status,
  connected = true,
  entry = delegation(BACKGROUND),
}: {
  client: WireClient;
  status: Status;
  connected?: boolean;
  entry?: ToolEntry;
}) {
  const control = useSubagentControl({
    client,
    threadId: 't1',
    status,
    connected,
    renderEntry: renderStub,
  });
  return (
    <SubagentControlContext.Provider value={control}>
      <Transcript state={{ ...emptyConversation(), entries: [entry] }} isFresh={() => false} />
    </SubagentControlContext.Provider>
  );
}

function open() {
  const card = screen.getByTestId('tool-entry');
  fireEvent.click(within(card).getAllByRole('button')[0]!);
}

const input = () => screen.getByLabelText('對背景子代理說話') as HTMLInputElement;
const stopButton = () => screen.getByRole('button', { name: '停止這一輪' }) as HTMLButtonElement;

describe('標頭的小狀態字', () => {
  it.each([
    [{ 'bg-1': 'running' } as const, '跑著'],
    [{ 'bg-1': 'idle' } as const, '閒著'],
    [{} as Status, '已收線'],
  ])('依 subagentStatus 畫出對的字', (status, label) => {
    render(<Harness client={fakeClient().client} status={status} />);
    expect(document.querySelector('[data-subagent-state]')?.textContent).toBe(label);
  });

  it('還沒收到快照就不畫', () => {
    render(<Harness client={fakeClient().client} status={null} />);
    expect(document.querySelector('[data-subagent-state]')).toBeNull();
  });

  it('不是背景派出的委派卡（沒有 meta）既沒有狀態字也沒有輸入框', () => {
    render(<Harness client={fakeClient().client} status={{}} entry={delegation()} />);
    open();
    expect(document.querySelector('[data-subagent-state]')).toBeNull();
    expect(document.querySelector('[data-subagent-panel]')).toBeNull();
  });

  it('不是委派工具的卡，就算帶了背景子代理的 meta 也不畫（同 subagentNames 的認法）', () => {
    const odd = { ...delegation(BACKGROUND), name: 'read_file' };
    render(<Harness client={fakeClient().client} status={{}} entry={odd} />);
    open();
    expect(document.querySelector('[data-subagent-state]')).toBeNull();
    expect(document.querySelector('[data-subagent-panel]')).toBeNull();
  });

  it('沒有提供者（單獨畫 Transcript）就不畫這一區', () => {
    render(
      <Transcript
        state={{ ...emptyConversation(), entries: [delegation(BACKGROUND)] }}
        isFresh={() => false}
      />,
    );
    open();
    expect(document.querySelector('[data-subagent-panel]')).toBeNull();
  });
});

describe('對它說話', () => {
  it('送出走 subagentSend（編號是委派卡 meta 的），清空輸入框並留一則「你：…」', async () => {
    const { client, send } = fakeClient();
    render(<Harness client={client} status={{ 'bg-1': 'running' }} />);
    open();
    fireEvent.change(input(), { target: { value: '  先看 A  ' } });
    fireEvent.click(screen.getByRole('button', { name: '送出給背景子代理' }));
    await waitFor(() => expect(document.querySelector('[data-subagent-echo]')).not.toBeNull());
    expect(send).toHaveBeenCalledExactlyOnceWith('t1', 'bg-1', '先看 A');
    expect(input().value).toBe('');
    const echo = document.querySelector('[data-subagent-echo]') as HTMLElement;
    expect(echo.textContent).toContain('你：');
    expect(echo.textContent).toContain('先看 A');
    expect(echo.textContent).toContain('已送出');
  });

  it('送出中輸入框停用、鈕寫「送出中…」，不能連按', async () => {
    let release: (value: UplinkResult) => void = () => undefined;
    const { client } = fakeClient({
      subagentSend: vi.fn(() => new Promise<UplinkResult>((resolve) => (release = resolve))),
    });
    render(<Harness client={client} status={{ 'bg-1': 'running' }} />);
    open();
    fireEvent.change(input(), { target: { value: '嗨' } });
    fireEvent.submit(input().closest('form')!);
    fireEvent.submit(input().closest('form')!);
    expect(input().disabled).toBe(true);
    expect(screen.getByRole('button', { name: '送出給背景子代理' }).textContent).toContain(
      '送出中…',
    );
    expect(client.subagentSend).toHaveBeenCalledTimes(1);
    await act(async () => release(ok));
    expect(input().disabled).toBe(false);
  });

  it.each([
    ['subagent_at_capacity', '背景子代理同時執行的數量已滿，等其他子代理結束後再送。'],
    ['subagent_closed', '正在關閉'],
    ['invalid_argument', '不能是空白'],
    ['unknown_error', '叫醒失敗：被拒。可以再送一次。'],
  ])('被拒（%s）：卡內一行紅字，輸入的話還在', async (code, snippet) => {
    const { client } = fakeClient({ subagentSend: vi.fn(async () => refused(code)) });
    render(<Harness client={client} status={{ 'bg-1': 'running' }} />);
    open();
    fireEvent.change(input(), { target: { value: '嗨' } });
    fireEvent.submit(input().closest('form')!);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(snippet);
    expect(input().value).toBe('嗨');
    expect(document.querySelector('[data-subagent-echo]')).toBeNull();
    fireEvent.change(input(), { target: { value: '嗨嗨' } });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('叫不醒（subagent_not_found）：講一句，接著照收線畫——輸入框停用、標頭寫已收線，話不再能送（#1271）', async () => {
    const { client } = fakeClient({
      subagentSend: vi.fn(async () => refused('subagent_not_found', '日誌不在')),
    });
    render(<Harness client={client} status={{ 'bg-1': 'idle' }} />);
    open();
    fireEvent.change(input(), { target: { value: '還記得嗎' } });
    fireEvent.submit(input().closest('form')!);
    expect((await screen.findByRole('alert')).textContent).toBe(
      '這個子代理無法再叫醒，只能查看它的對話。',
    );
    expect(input().disabled).toBe(true);
    expect(input().placeholder).toContain('結束');
    expect(document.querySelector('[data-subagent-state]')?.textContent).toBe('已收線');
    expect(stopButton().disabled).toBe(true);
    // 收合再展開也還是收線（記在提供者那一層）。
    open();
    open();
    expect(input().disabled).toBe(true);
    expect(client.subagentSend).toHaveBeenCalledTimes(1);
  });

  it('叫不醒只影響那一個：同一條對話裡的別的子代理照常', async () => {
    const other = {
      ...delegation({ ...BACKGROUND, runId: 'bg-2' }),
      id: 'tool-e',
      callId: 'call-e',
    };
    const { client } = fakeClient({
      subagentSend: vi.fn(async (_t: string, runId: string) =>
        runId === 'bg-1' ? refused('subagent_not_found') : ok,
      ),
    });
    function Two() {
      const control = useSubagentControl({
        client,
        threadId: 't1',
        status: { 'bg-1': 'idle', 'bg-2': 'idle' },
        connected: true,
        renderEntry: renderStub,
      });
      return (
        <SubagentControlContext.Provider value={control}>
          <Transcript
            state={{ ...emptyConversation(), entries: [delegation(BACKGROUND), other] }}
            isFresh={() => false}
          />
        </SubagentControlContext.Provider>
      );
    }
    render(<Two />);
    fireEvent.click(within(screen.getAllByTestId('tool-entry')[0]!).getAllByRole('button')[0]!);
    fireEvent.change(input(), { target: { value: '嗨' } });
    fireEvent.submit(input().closest('form')!);
    await screen.findByRole('alert');
    const labels = [...document.querySelectorAll('[data-subagent-state]')].map(
      (n) => n.textContent,
    );
    expect(labels).toEqual(['已收線', '閒著']);
  });

  it('連線出問題（拋錯）也講一句，不吞掉', async () => {
    const { client } = fakeClient({
      subagentSend: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    render(<Harness client={client} status={{ 'bg-1': 'running' }} />);
    open();
    fireEvent.change(input(), { target: { value: '嗨' } });
    fireEvent.submit(input().closest('form')!);
    expect((await screen.findByRole('alert')).textContent).toContain('再試一次');
  });

  it('空白不能送', () => {
    const { client, send } = fakeClient();
    render(<Harness client={client} status={{ 'bg-1': 'running' }} />);
    open();
    fireEvent.change(input(), { target: { value: '   ' } });
    expect(
      (screen.getByRole('button', { name: '送出給背景子代理' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.submit(input().closest('form')!);
    expect(send).not.toHaveBeenCalled();
  });

  it('收合再展開，回聲還在（放在提供者那一層，不跟著卡片卸載）', async () => {
    render(<Harness client={fakeClient().client} status={{ 'bg-1': 'running' }} />);
    open();
    fireEvent.change(input(), { target: { value: '嗨' } });
    fireEvent.submit(input().closest('form')!);
    await waitFor(() => expect(document.querySelector('[data-subagent-echo]')).not.toBeNull());
    open();
    open();
    expect(document.querySelectorAll('[data-subagent-echo]')).toHaveLength(1);
  });
});

describe('叫醒閒著的（#1271）', () => {
  const sendButton = () =>
    screen.getByRole('button', { name: '送出給背景子代理' }) as HTMLButtonElement;

  it('受理之後送出鈕維持「送出中…」、輸入框停用，快照翻成跑著才恢復', async () => {
    const { client } = fakeClient();
    const view = render(<Harness client={client} status={{ 'bg-1': 'idle' }} />);
    open();
    fireEvent.change(input(), { target: { value: '還記得暗號嗎' } });
    fireEvent.submit(input().closest('form')!);
    await waitFor(() => expect(document.querySelector('[data-subagent-echo]')).not.toBeNull());
    expect(input().value).toBe('');
    expect(sendButton().textContent).toContain('送出中…');
    expect(input().disabled).toBe(true);
    view.rerender(<Harness client={client} status={{ 'bg-1': 'running' }} />);
    await waitFor(() => expect(sendButton().textContent).not.toContain('送出中'));
    expect(input().disabled).toBe(false);
  });

  it('翻成收線也算結束，不一直鎖著', async () => {
    const { client } = fakeClient();
    const view = render(<Harness client={client} status={{ 'bg-1': 'idle' }} />);
    open();
    fireEvent.change(input(), { target: { value: '嗨' } });
    fireEvent.submit(input().closest('form')!);
    // 先等受理（回聲出現），才分得出是「等叫醒」而不是「還在送」。
    await waitFor(() => expect(document.querySelector('[data-subagent-echo]')).not.toBeNull());
    expect(sendButton().textContent).toContain('送出中…');
    view.rerender(<Harness client={client} status={{}} />);
    await waitFor(() => expect(sendButton().textContent).not.toContain('送出中'));
  });

  it('一直沒翻成跑著：十秒後放手，不報錯', async () => {
    vi.useFakeTimers();
    const { client } = fakeClient();
    render(<Harness client={client} status={{ 'bg-1': 'idle' }} />);
    open();
    fireEvent.change(input(), { target: { value: '嗨' } });
    fireEvent.submit(input().closest('form')!);
    await act(async () => undefined);
    expect(sendButton().textContent).toContain('送出中…');
    await act(async () => void vi.advanceTimersByTime(9_900));
    expect(sendButton().textContent).toContain('送出中…');
    await act(async () => void vi.advanceTimersByTime(200));
    expect(sendButton().textContent).not.toContain('送出中');
    expect(input().disabled).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('對跑著的送話不等：受理就恢復（它本來就在跑，下一步就收得到）', async () => {
    const { client } = fakeClient();
    render(<Harness client={client} status={{ 'bg-1': 'running' }} />);
    open();
    fireEvent.change(input(), { target: { value: '嗨' } });
    fireEvent.submit(input().closest('form')!);
    await waitFor(() => expect(document.querySelector('[data-subagent-echo]')).not.toBeNull());
    expect(sendButton().textContent).not.toContain('送出中');
  });

  it('叫醒被拒：不進入等待，話留著', async () => {
    const { client } = fakeClient({
      subagentSend: vi.fn(async () => refused('subagent_at_capacity')),
    });
    render(<Harness client={client} status={{ 'bg-1': 'idle' }} />);
    open();
    fireEvent.change(input(), { target: { value: '嗨' } });
    fireEvent.submit(input().closest('form')!);
    await screen.findByRole('alert');
    expect(sendButton().textContent).not.toContain('送出中');
    expect(input().value).toBe('嗨');
    expect(input().disabled).toBe(false);
  });
});

describe('各種狀態下的輸入框', () => {
  it('跑著：可打字、佔位字說下一步送進去；停止可按', () => {
    render(<Harness client={fakeClient().client} status={{ 'bg-1': 'running' }} />);
    open();
    expect(input().disabled).toBe(false);
    expect(input().placeholder).toContain('下一步');
    expect(stopButton().disabled).toBe(false);
  });

  it('還沒收到快照：當跑著，不閃一下停用', () => {
    render(<Harness client={fakeClient().client} status={null} />);
    open();
    expect(input().disabled).toBe(false);
    expect(stopButton().disabled).toBe(false);
  });

  it('閒著：可打字、佔位字說會喚醒它；停止不可按', () => {
    render(<Harness client={fakeClient().client} status={{ 'bg-1': 'idle' }} />);
    open();
    expect(input().disabled).toBe(false);
    expect(input().placeholder).toContain('喚醒');
    expect(stopButton().disabled).toBe(true);
  });

  it('已收線：輸入框停用、佔位字說已結束；停止不可按', () => {
    render(<Harness client={fakeClient().client} status={{}} />);
    open();
    expect(input().disabled).toBe(true);
    expect(input().placeholder).toContain('結束');
    expect(stopButton().disabled).toBe(true);
  });

  it('連線斷了：輸入框停用、佔位字說連線中；跑著的話停止仍可按', () => {
    render(
      <Harness client={fakeClient().client} status={{ 'bg-1': 'running' }} connected={false} />,
    );
    open();
    expect(input().disabled).toBe(true);
    expect(input().placeholder).toBe('連線中…');
    expect(stopButton().disabled).toBe(false);
  });
});

describe('單獨停止', () => {
  it('按下走 subagentInterrupt、鈕變「停止中…」，狀態翻成閒著就恢復', async () => {
    const { client, interrupt } = fakeClient();
    const view = render(<Harness client={client} status={{ 'bg-1': 'running' }} />);
    open();
    fireEvent.click(stopButton());
    expect(interrupt).toHaveBeenCalledExactlyOnceWith('t1', 'bg-1');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '停止這一輪' }).textContent).toContain('停止中…'),
    );
    expect(stopButton().disabled).toBe(true);
    view.rerender(<Harness client={client} status={{ 'bg-1': 'idle' }} />);
    await waitFor(() => expect(stopButton().textContent).toContain('停止這一輪'));
    expect(stopButton().textContent).not.toContain('停止中');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('狀態一直沒翻：十秒後放手（停止是冪等的），不報錯', async () => {
    vi.useFakeTimers();
    const { client } = fakeClient();
    render(<Harness client={client} status={{ 'bg-1': 'running' }} />);
    open();
    fireEvent.click(stopButton());
    await act(async () => undefined);
    expect(stopButton().textContent).toContain('停止中…');
    await act(async () => void vi.advanceTimersByTime(9_900));
    expect(stopButton().textContent).toContain('停止中…');
    await act(async () => void vi.advanceTimersByTime(200));
    expect(stopButton().textContent).toBe('停止這一輪');
    expect(stopButton().disabled).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('停止沒送出去（被拒）：鈕恢復，卡內講一句', async () => {
    const { client } = fakeClient({
      subagentInterrupt: vi.fn(async () => refused('internal_error', '壞了')),
    });
    render(<Harness client={client} status={{ 'bg-1': 'running' }} />);
    open();
    fireEvent.click(stopButton());
    expect((await screen.findByRole('alert')).textContent).toContain('壞了');
    expect(stopButton().textContent).toBe('停止這一輪');
  });
});

describe('子代理自己的對話（#861）', () => {
  const GUIDANCE = '\n\nYour parent agent id is "root". 收尾前回報。';
  const conversation = () =>
    historyOf([
      frame('lifecycle', { event: 'running', graph_name: 'root' }),
      ...said('human', 'h1', `查三個檔案${GUIDANCE}`),
      frame('tools', { event: 'tool-started', tool_call_id: 'c1', tool_name: 'look', input: '{}' }),
      frame('tools', { event: 'tool-finished', tool_call_id: 'c1', message: '看過了' }),
      ...said('ai', 'a1', '查完了'),
      ...said('human', 'h2', '先看 A'),
      frame('lifecycle', { event: 'completed', graph_name: 'root' }),
    ]);

  it('只顯示最近一頁（前面還有更早的）時，第一則人話不一定是任務：不標「派出的任務」，並說還有更早的', async () => {
    const { client } = fakeClient({
      subagentHistory: vi.fn(async () =>
        historyOf(
          [
            frame('lifecycle', { event: 'running', graph_name: 'root' }),
            ...said('human', 'h9', '先看 A'),
            ...said('ai', 'a9', '看過了'),
            frame('lifecycle', { event: 'completed', graph_name: 'root' }),
          ],
          true,
        ),
      ),
    });
    render(<Harness client={client} status={{ 'bg-1': 'idle' }} />);
    open();
    await waitFor(() => expect(entryKinds()).toEqual(['human', 'ai']));
    const section = document.querySelector('[data-subagent-conversation]') as HTMLElement;
    expect(within(section).queryByText('派出的任務')).toBeNull();
    expect(within(section).getByText(/更早的沒有載入/)).toBeTruthy();
  });

  it('展開讀一次：帶 thread、編號與頁大小；畫出人話、工具卡、回覆；第一則標「派出的任務」且去掉回報指示', async () => {
    const { client } = fakeClient({ subagentHistory: vi.fn(async () => conversation()) });
    render(<Harness client={client} status={{ 'bg-1': 'idle' }} />);
    expect(document.querySelector('[data-subagent-conversation]')).toBeNull();
    open();
    await waitFor(() => expect(entryKinds()).toEqual(['human', 'tool', 'ai', 'human']));
    expect(client.subagentHistory).toHaveBeenCalledExactlyOnceWith('t1', 'bg-1', {
      maxMessages: 40,
    });
    const section = document.querySelector('[data-subagent-conversation]') as HTMLElement;
    expect(within(section).getByText('派出的任務')).toBeTruthy();
    expect(within(section).getByText('查三個檔案')).toBeTruthy();
    expect(section.textContent).not.toContain('Your parent agent id');
  });

  it('讀回來之後捲到最底，看到最新的', async () => {
    // jsdom 沒有排版：scrollHeight 恆為 0、scrollTop 寫了不留。換成記得住的，才量得到有沒有捲。
    const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    const top = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    const written: number[] = [];
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      // 只動這一區：對話列表自己的捲動邏輯看到非零高度會去呼叫 jsdom 沒有的 scrollTo。
      get(this: HTMLElement) {
        return this.closest('[data-subagent-conversation]') === null ? 0 : 500;
      },
    });
    Object.defineProperty(Element.prototype, 'scrollTop', {
      configurable: true,
      get: () => 0,
      set: (value: number) => void written.push(value),
    });
    try {
      const { client } = fakeClient({ subagentHistory: vi.fn(async () => conversation()) });
      render(<Harness client={client} status={{ 'bg-1': 'idle' }} />);
      open();
      await waitFor(() => expect(entryKinds()).toHaveLength(4));
      expect(written).toContain(500);
    } finally {
      if (height === undefined)
        delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
      else Object.defineProperty(HTMLElement.prototype, 'scrollHeight', height);
      if (top === undefined) delete (Element.prototype as { scrollTop?: number }).scrollTop;
      else Object.defineProperty(Element.prototype, 'scrollTop', top);
    }
  });

  it('更早的還沒載入時講一句', async () => {
    const { client } = fakeClient({
      subagentHistory: vi.fn(async () => historyOf(said('human', 'h1', '任務'), true)),
    });
    render(<Harness client={client} status={{ 'bg-1': 'idle' }} />);
    open();
    expect((await screen.findByText(/只顯示最近 40 則/)).textContent).toContain('更早的沒有載入');
  });

  it('讀的時候寫「讀取中…」，讀回來就沒了', async () => {
    let resolve: (value: ThreadHistoryOutcome) => void = () => undefined;
    const { client } = fakeClient({
      subagentHistory: vi.fn(() => new Promise<ThreadHistoryOutcome>((r) => (resolve = r))),
    });
    render(<Harness client={client} status={{ 'bg-1': 'idle' }} />);
    open();
    expect(screen.getByText('讀取中…')).toBeTruthy();
    await act(async () => resolve(conversation()));
    expect(screen.queryByText('讀取中…')).toBeNull();
  });

  it('讀不回來：講一句與原因，輸入框照常能用；重新讀取成功後那句消失', async () => {
    const subagentHistory = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'rejected', message: '沒有那份日誌' })
      .mockResolvedValue(conversation());
    render(<Harness client={fakeClient({ subagentHistory }).client} status={{ 'bg-1': 'idle' }} />);
    open();
    const error = await screen.findByText(/子代理的對話讀不回來：沒有那份日誌/);
    expect(error).toBeTruthy();
    expect(input().disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '重新讀取子代理的對話' }));
    await waitFor(() => expect(entryKinds()).toHaveLength(4));
    expect(document.querySelector('[data-subagent-history-error]')).toBeNull();
  });

  it('重讀失敗時保留上一次讀到的，不把畫面清空', async () => {
    const subagentHistory = vi
      .fn()
      .mockResolvedValueOnce(conversation())
      .mockResolvedValue({ kind: 'rejected', message: '暫時讀不到' });
    render(<Harness client={fakeClient({ subagentHistory }).client} status={{ 'bg-1': 'idle' }} />);
    open();
    await waitFor(() => expect(entryKinds()).toHaveLength(4));
    fireEvent.click(screen.getByRole('button', { name: '重新讀取子代理的對話' }));
    await screen.findByText(/暫時讀不到/);
    expect(entryKinds()).toHaveLength(4);
  });

  it('已收線而讀不到：講「讀不到了」，不用紅字報錯', async () => {
    const subagentHistory = vi.fn(async () => ({
      kind: 'rejected',
      message: 'subagent_not_found',
    }));
    render(<Harness client={fakeClient({ subagentHistory } as never).client} status={{}} />);
    open();
    const line = await screen.findByText('這個子代理的對話讀不到了。');
    expect(line.className).not.toContain('destructive');
    expect(document.body.textContent).not.toContain('subagent_not_found');
  });

  it('拋錯（連線出問題）也當讀不回來，不吞掉', async () => {
    const subagentHistory = vi.fn(async () => {
      throw new Error('boom');
    });
    render(
      <Harness
        client={fakeClient({ subagentHistory } as never).client}
        status={{ 'bg-1': 'idle' }}
      />,
    );
    open();
    expect(await screen.findByText(/子代理的對話讀不回來：連線出了問題/)).toBeTruthy();
  });

  it('跑著翻成閒著（或收線）時再讀一次；沒翻就不重讀', async () => {
    const { client } = fakeClient();
    const view = render(<Harness client={client} status={{ 'bg-1': 'running' }} />);
    open();
    await waitFor(() => expect(client.subagentHistory).toHaveBeenCalledTimes(1));
    view.rerender(<Harness client={client} status={{ 'bg-1': 'running' }} />);
    await act(async () => undefined);
    expect(client.subagentHistory).toHaveBeenCalledTimes(1);
    view.rerender(<Harness client={client} status={{ 'bg-1': 'idle' }} />);
    await waitFor(() => expect(client.subagentHistory).toHaveBeenCalledTimes(2));
    view.rerender(<Harness client={client} status={{ 'bg-1': 'idle' }} />);
    await act(async () => undefined);
    expect(client.subagentHistory).toHaveBeenCalledTimes(2);
  });

  it('送出成功之後再讀一次；送不出去就不重讀', async () => {
    const refused = vi.fn(async () => ({
      type: 'error',
      id: 1,
      error: 'subagent_closed',
      message: 'x',
    }));
    const { client } = fakeClient({ subagentSend: refused } as never);
    render(<Harness client={client} status={{ 'bg-1': 'idle' }} />);
    open();
    await waitFor(() => expect(client.subagentHistory).toHaveBeenCalledTimes(1));
    fireEvent.change(input(), { target: { value: '嗨' } });
    fireEvent.submit(input().closest('form')!);
    await screen.findByRole('alert');
    expect(client.subagentHistory).toHaveBeenCalledTimes(1);

    const good = fakeClient();
    cleanup();
    render(<Harness client={good.client} status={{ 'bg-1': 'idle' }} />);
    open();
    await waitFor(() => expect(good.client.subagentHistory).toHaveBeenCalledTimes(1));
    fireEvent.change(input(), { target: { value: '嗨' } });
    fireEvent.submit(input().closest('form')!);
    await waitFor(() => expect(good.client.subagentHistory).toHaveBeenCalledTimes(2));
  });

  it('本地回聲：歷史已經有的不再畫（重複），還沒寫進日誌的留著', async () => {
    const subagentHistory = vi.fn(async () => conversation());
    const { client } = fakeClient({ subagentHistory });
    // 跑著：送出受理就恢復（閒著的話要等它跑起來，連送兩句會被擋，#1271）。
    render(<Harness client={client} status={{ 'bg-1': 'running' }} />);
    open();
    await waitFor(() => expect(entryKinds()).toHaveLength(4));
    // 「先看 A」歷史裡已有；「再看 B」還沒。
    for (const line of ['先看 A', '再看 B']) {
      fireEvent.change(input(), { target: { value: line } });
      fireEvent.submit(input().closest('form')!);
      await waitFor(() => expect(input().value).toBe(''));
    }
    const echoes = () =>
      [...document.querySelectorAll('[data-subagent-echo]')].map((n) => n.textContent);
    await waitFor(() => expect(echoes()).toHaveLength(1));
    expect(echoes()[0]).toContain('再看 B');
  });

  it('子代理跑完之後，到那一刻為止送出的回聲收掉：歷史只讀最近一頁、人話掉出頁外也不會留下重複的泡泡', async () => {
    const outOfWindow = historyOf(
      [
        frame('lifecycle', { event: 'running', graph_name: 'root' }),
        ...said('human', 'h9', '很後面的一句'),
        ...said('ai', 'a9', '好'),
        frame('lifecycle', { event: 'completed', graph_name: 'root' }),
      ],
      true,
    );
    const { client } = fakeClient({ subagentHistory: vi.fn(async () => outOfWindow) });
    const view = render(<Harness client={client} status={{ 'bg-1': 'running' }} />);
    open();
    fireEvent.change(input(), { target: { value: '很早的一句' } });
    fireEvent.click(screen.getByRole('button', { name: '送出給背景子代理' }));
    await waitFor(() => expect(document.querySelector('[data-subagent-echo]')).not.toBeNull());
    // 還在跑：領走之前，回聲要留著。
    // 跑完：它已經在日誌裡，只是這一頁沒涵蓋到。
    view.rerender(<Harness client={client} status={{ 'bg-1': 'idle' }} />);
    await waitFor(() => expect(document.querySelector('[data-subagent-echo]')).toBeNull());
    // 之後再送的還是會留著，直到下一次跑完。
    fireEvent.change(input(), { target: { value: '新的一句' } });
    fireEvent.click(screen.getByRole('button', { name: '送出給背景子代理' }));
    await waitFor(() => expect(document.querySelector('[data-subagent-echo]')).not.toBeNull());
    expect(document.querySelector('[data-subagent-echo]')?.textContent).toContain('新的一句');
  });

  it('後到的舊回應不覆蓋新的', async () => {
    const resolvers: ((value: ThreadHistoryOutcome) => void)[] = [];
    const { client } = fakeClient({
      subagentHistory: vi.fn(() => new Promise<ThreadHistoryOutcome>((r) => resolvers.push(r))),
    });
    render(<Harness client={client} status={{ 'bg-1': 'idle' }} />);
    open();
    await waitFor(() => expect(resolvers).toHaveLength(1));
    // 讀取中重新讀取的鈕是停用的；用送出觸發第二次讀取。
    fireEvent.change(input(), { target: { value: '嗨' } });
    fireEvent.submit(input().closest('form')!);
    await waitFor(() => expect(resolvers).toHaveLength(2));
    await act(async () => resolvers[1]!(historyOf(said('human', 'h1', '新的'))));
    await act(async () => resolvers[0]!(historyOf(said('human', 'h1', '舊的'))));
    expect(document.querySelector('[data-subagent-conversation]')?.textContent).toContain('新的');
    expect(document.querySelector('[data-subagent-conversation]')?.textContent).not.toContain(
      '舊的',
    );
  });
});
