/** `App` 的畫面測試：輸入框的提及與命令：@子代理、命令在途、沒有 input 的命令。共用的假 client 與 hook 在 `@/test/app-harness`。 */
import type { Event, SlashRunOutcome, UplinkResult, WireClient } from '@nexus/wire';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { stubCmdkLayout } from '@/test/cmdk';
import { attachmentGate, fakeClient, frame, setSeq } from '@/test/app-harness';

// `serverSupportsAttachments` 的真實作回 true（#733）；這裡接到 `attachmentGate`，預設關著，測附件的測試才打開。
vi.mock('@/lib/attachments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/attachments')>()),
  serverSupportsAttachments: () => attachmentGate.on,
}));

describe('@子代理 提及（#328）', () => {
  beforeEach(stubCmdkLayout);

  const KINDS = [
    { name: 'explorer', description: '唯讀地探索程式碼' },
    { name: 'reviewer', description: '審查一段變更' },
  ];
  const supported = async (): Promise<
    ReturnType<WireClient['subagentList']> extends Promise<infer R> ? R : never
  > => ({
    kind: 'ok',
    result: { ok: true, value: { subagents: KINDS } },
  });
  const input = () => screen.getByLabelText<HTMLTextAreaElement>('要說的話');
  const type = (value: string) => fireEvent.change(input(), { target: { value } });
  const chip = () => screen.queryByTestId('agent-mention-chip');

  async function ready(
    subagentList: WireClient['subagentList'] | undefined = supported,
    runStartResult: UplinkResult = { type: 'success', id: 1, result: { run_id: 'run-1' } },
    slashList?: WireClient['slashList'],
  ) {
    setSeq(0);
    const fake = fakeClient([frame('lifecycle', [], { event: 'completed', graph_name: 'root' })], {
      commands: [{ name: 'plan', description: '計劃模式', input: { hint: '[on|off]' } }],
      // 命令收下了（#1941：收下才清草稿，所以這裡要是成功）。
      run: () => ({ kind: 'success', command_id: 'plan' }),
    });
    const runStart = vi.fn(async (..._args: Parameters<WireClient['runStart']>) => runStartResult);
    const listed = vi.fn(subagentList);
    render(
      <App
        client={{
          ...fake.client,
          runStart,
          subagentList: listed,
          ...(slashList === undefined ? {} : { slashList }),
        }}
      />,
    );
    await screen.findByPlaceholderText('說點什麼…');
    return { runStart, listed, slashed: fake.slashed };
  }

  /** 打 `@` 開選單、挑第 `down` 個（從 0 起）、Enter。 */
  async function pick(draft: string, down = 0) {
    type(draft);
    await screen.findByRole('dialog', { name: '@ 選單' });
    for (let i = 0; i < down; i += 1) fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'Enter' });
  }

  it.each([
    [
      'server 還沒實作（not_supported）',
      async () => ({ kind: 'rejected' as const, code: 'not_supported', message: '沒接' }),
      1,
    ],
    [
      '被拒',
      async () => ({ kind: 'rejected' as const, code: 'invalid_argument', message: '不行' }),
      1,
    ],
    [
      // 開頁那一次拋在下行接上之前，接上時再讀一次（#1483）；又拋的話，要等下一次接上。
      '讀的時候拋錯',
      async (): Promise<never> => {
        throw new Error('斷了');
      },
      2,
    ],
    [
      '清單是空的（沒有可點名的對象）',
      async () => ({
        kind: 'ok' as const,
        result: { ok: true as const, value: { subagents: [] } },
      }),
      1,
    ],
  ])('server 不支援就整個不出現：%s', async (_case, list, reads) => {
    const { listed } = await ready(list);
    await waitFor(() => expect(listed).toHaveBeenCalledTimes(reads));
    type('@');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByRole('dialog', { name: '@ 選單' })).toBeNull();
    expect(chip()).toBeNull();
  });

  it('清單讀自 server：選單列出它給的種類與說明', async () => {
    await ready();
    type('@');
    const menu = await screen.findByRole('dialog', { name: '@ 選單' });
    expect(
      within(menu)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['explorer唯讀地探索程式碼', 'reviewer審查一段變更']);
  });

  it('支援時走完整流程：選了出現標記，送出帶 mention，文字不含提及，標記清掉', async () => {
    const { runStart } = await ready();
    await pick('請看 @rev');
    expect(chip()?.textContent).toBe('@reviewer');
    expect(input().value).toBe('請看 ');
    type('請看 這個檔案');
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    const [, text, options] = runStart.mock.calls[0]!;
    // 提及走 `mention` 欄位，不轉成文字塞進 input。
    expect(text).toBe('請看 這個檔案');
    expect(options).toEqual({
      mention: { kind: 'subagent', name: 'reviewer' },
      requestId: expect.any(String),
      clientTimeZone: expect.any(String),
    });
    expect(chip()).toBeNull();
  });

  it('沒選就沒有 mention 欄位：只帶請求編號與時區（#1335、#1630）', async () => {
    const { runStart } = await ready();
    type('一句話');
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    expect(Object.keys(runStart.mock.calls[0]![2] as object)).toEqual([
      'requestId',
      'clientTimeZone',
    ]);
  });

  it('取代前一個：送出的是最後選的那個', async () => {
    const { runStart } = await ready();
    await pick('@');
    await pick('@', 1);
    expect(chip()?.textContent).toBe('@reviewer');
    type('甲');
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    expect(runStart.mock.calls[0]![2]).toEqual({
      mention: { kind: 'subagent', name: 'reviewer' },
      requestId: expect.any(String),
      clientTimeZone: expect.any(String),
    });
  });

  it('server 對 mention 回 not_supported：說的是子代理不是附件，草稿與標記都留著', async () => {
    await ready(supported, {
      type: 'error',
      id: 1,
      error: 'not_supported',
      message: '伺服器自己的訊息',
    });
    await pick('@');
    type('乙');
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    expect(await screen.findByText('這個伺服器不收點名子代理：取消標記再送。')).toBeTruthy();
    expect(chip()?.textContent).toBe('@explorer');
    expect(input().value).toBe('乙');
  });

  it('名字不在清單上（invalid_argument）：用 server 的訊息，草稿與標記留著', async () => {
    await ready(supported, {
      type: 'error',
      id: 1,
      error: 'invalid_argument',
      message: '沒有叫 explorer 的子代理',
    });
    await pick('@');
    type('丙');
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    expect(await screen.findByText('沒有叫 explorer 的子代理')).toBeTruthy();
    expect(chip()?.textContent).toBe('@explorer');
  });

  it('送出沒收下時，這段時間已經選了別的，就不蓋掉', async () => {
    setSeq(0);
    const fake = fakeClient([frame('lifecycle', [], { event: 'completed', graph_name: 'root' })]);
    let settle: (result: UplinkResult) => void = () => {};
    const runStart = vi.fn(
      () =>
        new Promise<UplinkResult>((resolve) => {
          settle = resolve;
        }),
    );
    render(<App client={{ ...fake.client, runStart, subagentList: supported }} />);
    await screen.findByPlaceholderText('說點什麼…');
    await pick('@', 1);
    type('甲');
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    expect(chip()).toBeNull();
    await pick('@');
    expect(chip()?.textContent).toBe('@explorer');
    settle({ type: 'error', id: 1, error: 'invalid_argument', message: '這條 thread 收不了' });
    expect(await screen.findByText('這條 thread 收不了')).toBeTruthy();
    expect(chip()?.textContent).toBe('@explorer');
  });

  it('沒送出去後換了點名的對象是新的一句：換新編號；什麼都沒改就沿用（#1335）', async () => {
    const { runStart } = await ready(supported, {
      type: 'error',
      id: 1,
      error: 'invalid_argument',
      message: '點名的這句沒收下（#1335）',
    });
    const ids = () => runStart.mock.calls.map(([, , options]) => options?.requestId);
    await pick('@');
    type('乙');
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(chip()?.textContent).toBe('@explorer'));

    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(2));
    expect(ids()[1]).toBe(ids()[0]);

    await waitFor(() => expect(chip()?.textContent).toBe('@explorer'));
    await pick('@', 1);
    expect(chip()?.textContent).toBe('@reviewer');
    type('乙');
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(3));
    expect(ids()[2]).not.toBe(ids()[1]);
  });

  it('以 / 開頭的命令不帶也不用掉標記', async () => {
    const { runStart, slashed } = await ready();
    await pick('@');
    type('/plan');
    fireEvent.keyDown(input(), { key: 'Escape' });
    fireEvent.keyDown(input(), { key: 'Enter' });
    // 真的走了 `slash.run`：清單沒到就被退回的話，這一格不該照樣綠。
    await waitFor(() => expect(slashed).toEqual(['/plan']));
    expect(runStart).not.toHaveBeenCalled();
    expect(chip()).not.toBeNull();
  });

  it('命令清單在途時送「/plan」：等到清單認成命令，標記照樣留著（#1929）', async () => {
    let arrive: (() => void) | undefined;
    const slashList: WireClient['slashList'] = () =>
      new Promise((resolve) => {
        arrive = () =>
          resolve({
            kind: 'ok',
            commands: [{ name: 'plan', description: '計劃模式', input: { hint: '[on|off]' } }],
          });
      });
    const { runStart, slashed } = await ready(supported, undefined, slashList);
    await pick('@');
    type('/plan');
    fireEvent.keyDown(input(), { key: 'Escape' });
    fireEvent.keyDown(input(), { key: 'Enter' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(slashed).toEqual([]);

    arrive!();
    await waitFor(() => expect(slashed).toEqual(['/plan']));
    expect(runStart).not.toHaveBeenCalled();
    await waitFor(() => expect(chip()).not.toBeNull());
    // 命令收下了：不是「沒送出去」，草稿不放回來。
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(input().value).toBe('');
  });

  it('等清單認的期間 @ 標記改不了：拿不掉、選單挑不了；放行後帶的是畫面上那一個（#1929）', async () => {
    let arrive: (() => void) | undefined;
    const slashList: WireClient['slashList'] = () =>
      new Promise((resolve) => {
        arrive = () =>
          resolve({
            kind: 'ok',
            commands: [{ name: 'plan', description: '計劃模式', input: { hint: '[on|off]' } }],
          });
      });
    const { runStart } = await ready(supported, undefined, slashList);
    await pick('@');
    type('/deploy 今天');
    fireEvent.keyDown(input(), { key: 'Escape' });
    fireEvent.keyDown(input(), { key: 'Enter' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runStart).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '取消委派給 explorer' }));
    expect(chip()?.textContent).toBe('@explorer');
    // 草稿改不動，`@` 選單開不起來；就算開著，挑了也不換。
    type('@rev');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByRole('dialog', { name: '@ 選單' })).toBeNull();
    expect(chip()?.textContent).toBe('@explorer');

    arrive!();
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    expect(runStart.mock.calls[0]![1]).toBe('/deploy 今天');
    expect(runStart.mock.calls[0]![2]?.mention).toEqual({ kind: 'subagent', name: 'explorer' });
  });

  it('等清單認的期間前一句被拒：標記不放回鎖住的輸入框，送出的那一行跟畫面一樣不帶（#1929，dsh `draftInitializationBlocked`）', async () => {
    setSeq(0);
    const fake = fakeClient([frame('lifecycle', [], { event: 'completed', graph_name: 'root' })]);
    let settle: (result: UplinkResult) => void = () => {};
    const runStart = vi.fn(
      (..._args: Parameters<WireClient['runStart']>) =>
        new Promise<UplinkResult>((resolve) => {
          settle = resolve;
        }),
    );
    let arrive: (() => void) | undefined;
    const slashList: WireClient['slashList'] = () =>
      new Promise((resolve) => {
        arrive = () =>
          resolve({
            kind: 'ok',
            commands: [{ name: 'plan', description: '計劃模式', input: { hint: '[on|off]' } }],
          });
      });
    render(<App client={{ ...fake.client, runStart, subagentList: supported, slashList }} />);
    await screen.findByPlaceholderText('說點什麼…');
    await pick('@');
    type('先一句');
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    expect(chip()).toBeNull();

    type('/plna 這句');
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(input().readOnly).toBe(true));
    settle({ type: 'error', id: 1, error: 'invalid_argument', message: '第一句收不了' });
    expect(await screen.findByText('第一句收不了')).toBeTruthy();
    expect(chip()).toBeNull();
    expect(input().value).toBe('/plna 這句');

    arrive!();
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(2));
    expect(runStart.mock.calls[1]![1]).toBe('/plna 這句');
    expect(runStart.mock.calls[1]![2]?.mention).toBeUndefined();
    expect(chip()).toBeNull();
  });

  it('命令在途時前一句被拒：標記不放回鎖住的輸入框（#1941，同 #1929 的 `draftInitializationBlocked`）', async () => {
    setSeq(0);
    const holds: ((outcome: SlashRunOutcome) => void)[] = [];
    const fake = fakeClient([frame('lifecycle', [], { event: 'completed', graph_name: 'root' })], {
      commands: [{ name: 'plan', description: '計劃模式', input: { hint: '[on|off]' } }],
      run: () => new Promise<SlashRunOutcome>((resolve) => holds.push(resolve)),
    });
    let settle: (result: UplinkResult) => void = () => {};
    const runStart = vi.fn(
      (..._args: Parameters<WireClient['runStart']>) =>
        new Promise<UplinkResult>((resolve) => {
          settle = resolve;
        }),
    );
    render(<App client={{ ...fake.client, runStart, subagentList: supported }} />);
    await screen.findByPlaceholderText('說點什麼…');
    await pick('@');
    type('先一句（#1941）');
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    expect(chip()).toBeNull();

    type('/plan');
    fireEvent.keyDown(input(), { key: 'Escape' });
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(holds).toHaveLength(1));
    expect(input().readOnly).toBe(true);
    settle({ type: 'error', id: 1, error: 'invalid_argument', message: '第一句收不了（#1941）' });
    expect(await screen.findByText('第一句收不了（#1941）')).toBeTruthy();
    expect(chip()).toBeNull();
    expect(input().value).toBe('/plan');

    holds[0]!({ kind: 'success', command_id: 'plan' });
    await waitFor(() => expect(input().readOnly).toBe(false));
    expect(chip()).toBeNull();
  });

  it('等清單認的期間 @ 選單收起：游標移回 @ 那一段也不開（#1929，dsh 進 adjudicating 時 `popup.dismiss()`）', async () => {
    let arrive: (() => void) | undefined;
    const slashList: WireClient['slashList'] = () =>
      new Promise((resolve) => {
        arrive = () =>
          resolve({
            kind: 'ok',
            commands: [{ name: 'plan', description: '計劃模式', input: { hint: '[on|off]' } }],
          });
      });
    const { runStart } = await ready(supported, undefined, slashList);
    type('/deploy @ex');
    await screen.findByRole('dialog', { name: '@ 選單' });
    fireEvent.keyDown(input(), { key: 'Escape' });
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(input().readOnly).toBe(true));

    // 換成另一段（`@e`）：沒鎖的話收起的記錄作廢、選單重開。
    act(() => input().setSelectionRange(10, 10));
    fireEvent.select(input());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByRole('dialog', { name: '@ 選單' })).toBeNull();

    arrive!();
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    expect(runStart.mock.calls[0]![1]).toBe('/deploy @ex');
  });

  it('開頭不是命令的 /名字 是一句話：帶標記、也用掉它（#1929）', async () => {
    const { runStart } = await ready();
    await pick('@');
    type('/deploy 今天');
    fireEvent.keyDown(input(), { key: 'Escape' });
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    expect(runStart.mock.calls[0]![1]).toBe('/deploy 今天');
    expect(runStart.mock.calls[0]![2]?.mention).toEqual({ kind: 'subagent', name: 'explorer' });
    await waitFor(() => expect(chip()).toBeNull());
  });

  it('帶附件時兩樣都在 run.start 裡', async () => {
    attachmentGate.on = true;
    URL.createObjectURL = vi.fn(() => 'blob:preview');
    URL.revokeObjectURL = vi.fn();
    const { runStart } = await ready();
    await pick('@', 1);
    fireEvent.change(screen.getByTestId('attachment-input'), {
      target: { files: [new File(['PNG'], 'a.png', { type: 'image/png' })] },
    });
    type('看這張');
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    const options = runStart.mock.calls[0]![2];
    expect(options?.mention).toEqual({ kind: 'subagent', name: 'reviewer' });
    expect(options?.attachments).toHaveLength(1);
  });
});

describe('命令在途（#1941，dsh 送出狀態機的 submitting）', () => {
  beforeEach(() => {
    stubCmdkLayout();
    attachmentGate.on = false;
  });

  const input = () => screen.getByLabelText('要說的話') as HTMLTextAreaElement;
  const chips = () => screen.queryAllByTestId('draft-attachment');
  const png = (name: string) => new File(['PNG'], name, { type: 'image/png' });

  /** 認得 `/plan`（有 input，在途照 #1941；沒有 input 的 bare 命令見 #1971 那組）的假 client，`slash.run` 由測試兌現。 */
  async function held() {
    setSeq(0);
    const settle: ((outcome: SlashRunOutcome | Error) => void)[] = [];
    const fake = fakeClient([frame('lifecycle', [], { event: 'completed', graph_name: 'root' })], {
      commands: [{ name: 'plan', description: '計劃模式', input: { hint: '[on|off]' } }],
      run: () =>
        new Promise<SlashRunOutcome>((resolve, reject) => {
          settle.push((outcome) => (outcome instanceof Error ? reject(outcome) : resolve(outcome)));
        }),
    });
    const runStart = vi.fn(fake.client.runStart);
    render(<App client={{ ...fake.client, runStart }} />);
    await screen.findByPlaceholderText('說點什麼…');
    const enter = (text: string) => {
      fireEvent.change(input(), { target: { value: text } });
      fireEvent.keyDown(input(), { key: 'Escape' });
      fireEvent.keyDown(input(), { key: 'Enter' });
    };
    return { slashed: fake.slashed, runStart, settle, enter };
  }

  it('在途時再按 Enter 不送：slash.run 與 run.start 的次數都不變，輸入框鎖著、草稿還在', async () => {
    const { slashed, runStart, enter } = await held();
    enter('/plan');
    await waitFor(() => expect(slashed).toEqual(['/plan']));
    expect(input().value).toBe('/plan');
    expect(input().readOnly).toBe(true);

    // 唯讀擋不住程式送來的 change：直接再按 Enter，同一個 tick 連按兩下也一樣。
    act(() => {
      fireEvent.keyDown(input(), { key: 'Enter' });
      fireEvent.keyDown(input(), { key: 'Enter' });
    });
    const sendButton = screen.getByRole('button', { name: '送出' }) as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);
    fireEvent.click(sendButton);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(slashed).toEqual(['/plan']);
    expect(runStart).not.toHaveBeenCalled();
  });

  it('同一個 tick 連按兩下 Enter：只認一次、只送一次', async () => {
    const { slashed, settle } = await held();
    fireEvent.change(input(), { target: { value: '/plan' } });
    fireEvent.keyDown(input(), { key: 'Escape' });
    act(() => {
      fireEvent.keyDown(input(), { key: 'Enter' });
      fireEvent.keyDown(input(), { key: 'Enter' });
    });
    await waitFor(() => expect(settle).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(slashed).toEqual(['/plan']);
  });

  it('收下才清：回來之前草稿還在，成功之後清掉，輸入框放開', async () => {
    const { settle, enter } = await held();
    enter('/plan');
    await waitFor(() => expect(settle).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(input().value).toBe('/plan');

    settle[0]!({ kind: 'success', command_id: 'plan', text: '計劃模式打開了（#1941）。' });
    await waitFor(() => expect(input().value).toBe(''));
    expect(input().readOnly).toBe(false);
    expect(await screen.findByText('計劃模式打開了（#1941）。')).toBeTruthy();
  });

  it.each([
    [
      '被拒',
      { kind: 'rejected', message: '這條線不收（#1941 被拒）' } as SlashRunOutcome,
      '這條線不收（#1941 被拒）',
    ],
    [
      '命令回錯誤',
      { kind: 'error', text: '計劃模式開不了（#1941）' } as SlashRunOutcome,
      '計劃模式開不了（#1941）',
    ],
    ['拋錯', new Error('網路斷了（#1941）'), '網路斷了（#1941）'],
  ] as const)(
    '沒收下（%s）：草稿原樣、狀態列講原因、不跳「沒送出去」，放開之後能再送',
    async (_label, outcome, reason) => {
      const { slashed, settle, enter } = await held();
      enter('/plan');
      await waitFor(() => expect(settle).toHaveLength(1));
      settle[0]!(outcome);
      // 狀態列那一格（被拒的前面帶「這個動作沒送出去：」）。
      expect(await screen.findByText(reason, { exact: false })).toBeTruthy();
      await waitFor(() => expect(input().readOnly).toBe(false));
      expect(input().value).toBe('/plan');
      // 不另跳 toast（sonner 的 toast 跨測試留著，所以只看帶這個原因的那張）。
      const toasts = [...document.querySelectorAll('[data-sonner-toast]')];
      expect(toasts.filter((toast) => toast.textContent?.includes(reason))).toEqual([]);

      fireEvent.keyDown(input(), { key: 'Enter' });
      await waitFor(() => expect(slashed).toEqual(['/plan', '/plan']));
    },
  );

  it('在途時拖檔、加檔都不收：附件數不變', async () => {
    attachmentGate.on = true;
    URL.createObjectURL = vi.fn(() => 'blob:preview');
    URL.revokeObjectURL = vi.fn();
    const { settle, enter } = await held();
    enter('/plan');
    await waitFor(() => expect(settle).toHaveLength(1));

    fireEvent.dragEnter(window, { dataTransfer: { types: ['Files'] } });
    expect(screen.queryByTestId('drop-overlay')).toBeNull();
    fireEvent.drop(window, { dataTransfer: { types: ['Files'], files: [png('d.png')] } });
    expect(screen.getByRole('button', { name: '加入附件' }).hasAttribute('disabled')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(chips()).toHaveLength(0);
  });
});

describe('沒有 input 的命令（#1971，dsh `matchEnter`）', () => {
  beforeEach(() => {
    stubCmdkLayout();
    attachmentGate.on = false;
  });

  const input = () => screen.getByLabelText('要說的話') as HTMLTextAreaElement;

  /** 認得 bare 的 `/compact` 與有 input 的 `/plan`；`slash.run` 由測試兌現。 */
  async function held(events: readonly Event[] = []) {
    setSeq(0);
    const settle: ((outcome: SlashRunOutcome | Error) => void)[] = [];
    const fake = fakeClient(
      [frame('lifecycle', [], { event: 'completed', graph_name: 'root' }), ...events],
      {
        commands: [
          { name: 'compact', description: '壓縮' },
          { name: 'plan', description: '計劃模式', input: { hint: '[on|off]' } },
        ],
        run: () =>
          new Promise<SlashRunOutcome>((resolve, reject) => {
            settle.push((outcome) =>
              outcome instanceof Error ? reject(outcome) : resolve(outcome),
            );
          }),
      },
    );
    const runStart = vi.fn(fake.client.runStart);
    render(<App client={{ ...fake.client, runStart }} />);
    await screen.findByPlaceholderText('說點什麼…');
    const enter = (text: string, ctrlKey = false) => {
      fireEvent.change(input(), { target: { value: text } });
      fireEvent.keyDown(input(), { key: 'Escape' });
      fireEvent.keyDown(input(), { key: 'Enter', ctrlKey });
    };
    return { slashed: fake.slashed, runStart, settle, enter };
  }

  it('A：bare 命令按 Enter 當場拿掉、輸入框不鎖；回來之前就能打下一句', async () => {
    const { slashed, settle, enter } = await held();
    enter('/compact');
    await waitFor(() => expect(slashed).toEqual(['/compact']));
    expect(settle).toHaveLength(1);
    // 還沒回來：草稿已經空了、輸入框沒鎖、打了字送出鈕就能按。
    expect(input().value).toBe('');
    expect(input().readOnly).toBe(false);
    fireEvent.change(input(), { target: { value: '下一句' } });
    expect((screen.getByRole('button', { name: '送出' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it.each([
    [
      '被拒',
      { kind: 'rejected', message: '這條線不收（#1971 被拒）' } as SlashRunOutcome,
      '這條線不收（#1971 被拒）',
    ],
    [
      '命令回錯誤',
      { kind: 'error', text: '壓縮不了（#1971）' } as SlashRunOutcome,
      '壓縮不了（#1971）',
    ],
    ['拋錯', new Error('網路斷了（#1971）'), '網路斷了（#1971）'],
  ] as const)(
    'A：bare 命令沒收下（%s）：狀態列講原因，草稿不放回去',
    async (_label, outcome, reason) => {
      const { settle, enter } = await held();
      enter('/compact');
      await waitFor(() => expect(settle).toHaveLength(1));
      fireEvent.change(input(), { target: { value: '在途時打的下一句' } });
      settle[0]!(outcome);
      expect(await screen.findByText(reason, { exact: false })).toBeTruthy();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(input().value).toBe('在途時打的下一句');
    },
  );

  it('B：有 input 的命令照 #1941：在途鎖著、草稿留著，收下才清', async () => {
    const { slashed, settle, enter } = await held();
    enter('/plan off');
    await waitFor(() => expect(slashed).toEqual(['/plan off']));
    expect(input().value).toBe('/plan off');
    expect(input().readOnly).toBe(true);
    settle[0]!({ kind: 'success', command_id: 'plan' });
    await waitFor(() => expect(input().value).toBe(''));
    expect(input().readOnly).toBe(false);
  });

  it('C：從選單執行 bare 命令：當場執行、輸入框不鎖', async () => {
    const { slashed, settle } = await held();
    fireEvent.change(input(), { target: { value: '/com' } });
    await screen.findByRole('listbox');
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(slashed).toEqual(['/compact']));
    expect(settle).toHaveLength(1);
    expect(input().value).toBe('');
    expect(input().readOnly).toBe(false);
  });

  it('D：沒有 input 卻帶字的那一行是一句話：走 run.start，不走 slash.run', async () => {
    const { slashed, runStart, enter } = await held();
    enter('/compact 留下最近三輪');
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    expect(runStart.mock.calls[0]![1]).toBe('/compact 留下最近三輪');
    expect(slashed).toEqual([]);
  });

  it('D：跑著時 Cmd/Ctrl+Enter 照一般句子插話（#710），不被當命令擋掉', async () => {
    const { slashed, runStart, enter } = await held([
      frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
    ]);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('執行中'));
    enter('/compact 留下最近三輪', true);
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    expect(runStart.mock.calls[0]![1]).toBe('/compact 留下最近三輪');
    expect(runStart.mock.calls[0]![2]).toMatchObject({ mode: 'steer' });
    expect(slashed).toEqual([]);
  });
});
