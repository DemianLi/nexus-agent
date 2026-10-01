import type { ToolEntry, UplinkResult, WireClient } from '@nexus/wire';
import { emptyConversation } from '@nexus/wire';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SubagentControlContext, useSubagentControl } from '@/components/subagent-control';
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

function fakeClient(over: Partial<WireClient> = {}) {
  const send = vi.fn(async (..._args: [string, string, string]): Promise<UplinkResult> => ok);
  const interrupt = vi.fn(async (..._args: [string, string]): Promise<UplinkResult> => ok);
  const client = {
    subagentSend: send,
    subagentInterrupt: interrupt,
    ...over,
  } as unknown as WireClient;
  return { client, send, interrupt };
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
  const control = useSubagentControl({ client, threadId: 't1', status, connected });
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
    ['subagent_not_found', '找不到這個子代理'],
    ['subagent_at_capacity', '已滿'],
    ['subagent_closed', '正在關閉'],
    ['invalid_argument', '不能是空白'],
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
