import type { Event, SlashDescriptor, SlashRunOutcome, WireClient } from '@nexus/wire';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App, inputPlaceholder } from '@/App';

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
function fakeClient(
  events: readonly Event[],
  slash: {
    readonly commands?: readonly SlashDescriptor[];
    readonly run?: (line: string) => SlashRunOutcome;
  } = {},
) {
  const sent: string[] = [];
  const responded: unknown[] = [];
  const slashed: string[] = [];
  const client: WireClient = {
    slashList: async () => ({ kind: 'ok', commands: slash.commands ?? [] }),
    slashRun: async (_threadId, line) => {
      slashed.push(line);
      return slash.run?.(line) ?? { kind: 'unknown' };
    },
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
  return { client, sent, responded, slashed };
}

/** 一顆核准請求。逐筆詞彙照基座的形狀給——`reviewConfigs` 與 `actionRequests` 平行。 */
function approvalFrame(
  actions: readonly { name: string; allowed: readonly string[] }[],
  interruptId = 'int-1',
): Event {
  return frame('input.requested', ['tools:a'], {
    interrupt_id: interruptId,
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
      slashList: async () => ({ kind: 'ok', commands: [] }),
      slashRun: async () => ({ kind: 'unknown' }),
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

  it('**同一輪兩顆中斷：兩張卡，各按各的，決定落在自己那顆上**', async () => {
    // 逐次呼叫的閘門會發**兩顆**中斷（[#232](https://github.com/DemianLi/nexus-agent/issues/232)）。
    // 這條原本釘的是中間態（折疊器兩顆都留著、畫面只渲染第一張），現在翻成驗收句。
    //
    // **承重的是最後那兩句 `interrupt_id`。** 只驗「有兩張卡」的話，兩張卡都把決定送給
    // `pendings[0]` 也會綠——而那正是這一刀最可能長出來的 bug：人按的是 beta 那張，
    // 答掉的是 alpha。所以要按**第二張**，並看它送出去的鑰匙是不是 `int-2`。
    seq = 0;
    const { client, responded } = fakeClient([
      approvalFrame([{ name: 'alpha', allowed: ['approve', 'reject'] }], 'int-1'),
      approvalFrame([{ name: 'beta', allowed: ['approve', 'reject'] }], 'int-2'),
    ]);
    render(<App client={client} />);

    await waitFor(() => expect(screen.getAllByTestId('approval-card')).toHaveLength(2));
    const [alphaCard, betaCard] = screen.getAllByTestId('approval-card');
    if (alphaCard === undefined || betaCard === undefined) throw new Error('沒有兩張卡');
    // 順序照中斷發出的順序——反過來的話下面按的就是另一顆。
    expect(within(alphaCard).getByText('alpha')).toBeTruthy();
    expect(within(betaCard).getByText('beta')).toBeTruthy();
    // 狀態列是第二道證據，講得出兩個名字。
    expect(screen.getByRole('status').textContent).toContain('等待核准：alpha、beta');

    // **按第二張那顆按鈕**，不是第一張。
    fireEvent.click(within(betaCard).getByRole('button', { name: '全部核准' }));

    await waitFor(() => expect(responded.length).toBe(1));
    expect(responded[0]).toEqual({
      namespace: ['tools:a'],
      interrupt_id: 'int-2',
      response: { decisions: [{ type: 'approve' }] },
    });
    // 答掉的那張收走，另一張留著等人——**只收一張**，兩張一起消失是另一種壞法。
    await waitFor(() => expect(screen.getAllByTestId('approval-card')).toHaveLength(1));
    expect(within(screen.getByTestId('approval-card')).getByText('alpha')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('等待核准：alpha');

    // 再按剩下那張，鑰匙是 `int-1`。
    fireEvent.click(
      within(screen.getByTestId('approval-card')).getByRole('button', { name: '全部核准' }),
    );
    await waitFor(() => expect(responded.length).toBe(2));
    expect(responded[1]).toMatchObject({ interrupt_id: 'int-1' });
  });

  it('**兩張卡裡只要有一張沒有出路，送出框就解鎖**', async () => {
    // 多張卡之後「卡死」沒有自然的翻譯，`some` 與 `every` 行為不同，所以明著釘一條。
    // 取 `some` 的理由跟單張時同一句：那張沒有出路的卡**永遠清不掉**，這條 thread 就
    // 已經清不乾淨了，旁邊那張按得動也救不回來。
    //
    // **解鎖不等於送得出去**：送出去仍會撞上伺服器那句「停在核准點」（下面那條在釘它）。
    // 出路是「講得出原因」，不是「真的能說話」。
    seq = 0;
    const { client } = fakeClient([
      approvalFrame([{ name: 'alpha', allowed: ['approve', 'reject'] }], 'int-1'),
      approvalFrame([{ name: 'beta', allowed: [] }], 'int-2'),
    ]);
    render(<App client={client} />);

    await waitFor(() => expect(screen.getAllByTestId('approval-card')).toHaveLength(2));
    expect(screen.getByText(/這裡按不了/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('要說的話'), { target: { value: '換條路' } });
    expect(screen.getByRole('button', { name: '送出' }).hasAttribute('disabled')).toBe(false);
  });
});

describe('斜線命令', () => {
  const planCommand: SlashDescriptor = {
    name: 'plan',
    description: '進出計劃模式。',
    input: { hint: '[off]' },
  };

  it('清單畫出來，但打 `/` 不跳選單——這一版只有扁平清單', async () => {
    seq = 0;
    const { client } = fakeClient([], { commands: [planCommand] });
    render(<App client={client} />);

    await waitFor(() => expect(screen.getByText('/plan [off]')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('要說的話'), { target: { value: '/' } });
    // 沒有候選清單、沒有補全——那一套（dsh 的 `CommandDirectory`）是另一張卡。
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('第一個字是 `/` 就走 slash.run，而且不進 transcript', async () => {
    seq = 0;
    const { client, sent, slashed } = fakeClient([], {
      commands: [planCommand],
      run: () => ({ kind: 'success', command_id: 'cmd-1', text: '計劃模式打開了。' }),
    });
    render(<App client={client} />);

    await waitFor(() => expect(screen.getByPlaceholderText('說點什麼…')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('要說的話'), { target: { value: '/plan' } });
    fireEvent.click(screen.getByRole('button', { name: '送出' }));

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('計劃模式打開了'));
    // **一句都沒送給模型**，而且畫面上沒有「使用者說了 /plan」這一筆——
    // 命令是人對工具說的話，不是對模型說的話。
    expect(sent).toEqual([]);
    expect(slashed).toEqual(['/plan']);
    expect(screen.queryAllByRole('listitem')).toEqual([]);
  });

  it('認不得的一行說「不認得」，不是靜靜送給模型', async () => {
    seq = 0;
    const { client, sent } = fakeClient([], { run: () => ({ kind: 'unknown' }) });
    render(<App client={client} />);

    await waitFor(() => expect(screen.getByPlaceholderText('說點什麼…')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('要說的話'), { target: { value: '/nope' } });
    fireEvent.click(screen.getByRole('button', { name: '送出' }));

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('不認得這個命令'));
    expect(sent).toEqual([]);
  });

  it('命令自己失敗與這條線拒絕發派，說出來的話不一樣', async () => {
    seq = 0;
    const { client } = fakeClient([], {
      run: (line) =>
        line === '/plan off'
          ? { kind: 'error', command_id: 'cmd-2', text: '本來就不在計劃模式。' }
          : { kind: 'rejected', message: '這條 thread 正在跑：等這一輪跑完再打斜線命令' },
    });
    render(<App client={client} />);

    await waitFor(() => expect(screen.getByPlaceholderText('說點什麼…')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('要說的話'), { target: { value: '/plan off' } });
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('本來就不在計劃模式'),
    );

    fireEvent.change(screen.getByLabelText('要說的話'), { target: { value: '/plan' } });
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    // 「沒送出去」與「送出去了但命令說不行」是兩件事，混起來的那一刻人就不知道要等
    // 還是要改。
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('這個動作沒送出去'),
    );
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
      slashList: async () => ({ kind: 'ok', commands: [] }),
      slashRun: async () => ({ kind: 'unknown' }),
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

/** 一顆問答請求的 frame。 */
function questionFrame(interruptId = 'q-1'): Event {
  return frame('input.requested', ['tools:a'], {
    interrupt_id: interruptId,
    payload: {
      kind: 'question',
      questions: [
        { id: 'name', question: '訪客姓名？', header: '姓名' },
        { id: 'day', question: '哪一天？', options: [{ label: '週一' }, { label: '週二' }] },
      ],
    },
  });
}

describe('問答卡', () => {
  it('問答中斷畫成問答卡，不是核准卡——按鈕與送出形狀都不一樣', async () => {
    seq = 0;
    const { client } = fakeClient([questionFrame()]);
    render(<App client={client} />);

    await screen.findByTestId('question-card');
    // **同時斷言核准卡沒出現。** 少了這半句，「兩種卡都畫出來」也會綠，而那正是判別式
    // 寫錯時最可能的樣子。
    expect(screen.queryByTestId('approval-card')).toBeNull();
    expect(screen.getByText('訪客姓名？')).toBeTruthy();
    expect(screen.getByText('哪一天？')).toBeTruthy();
  });

  it('**送出去的是 `{answers}` 與那顆 id**——空的 `selected` 是跳過，不是空字串', async () => {
    seq = 0;
    const { client, responded } = fakeClient([questionFrame('q-7')]);
    render(<App client={client} />);
    const card = await screen.findByTestId('question-card');

    // 第一題自由作答、第二題明著跳過。
    fireEvent.change(within(card).getByLabelText('訪客姓名？ 的自由作答'), {
      target: { value: '阿明' },
    });
    fireEvent.click(within(card).getAllByRole('button', { name: '跳過這題' })[1]!);
    fireEvent.click(within(card).getByRole('button', { name: '送出答案' }));

    await waitFor(() => {
      expect(responded).toHaveLength(1);
    });
    expect(responded[0]).toEqual({
      namespace: ['tools:a'],
      interrupt_id: 'q-7',
      response: {
        answers: [
          { id: 'name', selected: [], custom: '阿明' },
          { id: 'day', selected: [] },
        ],
      },
    });
  });

  it('每一題都要有交代才送得出去——「還沒填」與「就是不想答」要分得開', async () => {
    seq = 0;
    const { client } = fakeClient([questionFrame()]);
    render(<App client={client} />);
    const card = await screen.findByTestId('question-card');

    const submit = within(card).getByRole('button', { name: '送出答案' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(card).getByLabelText('訪客姓名？ 的自由作答'), {
      target: { value: '阿明' },
    });
    // 只答了一題還不夠——另一題既沒答也沒跳過。
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(card).getAllByRole('button', { name: '跳過這題' })[1]!);
    expect((submit as HTMLButtonElement).disabled).toBe(false);
  });

  it('**放棄整組送的是 `{cancelled:true}`**，不是一份每題都空的答案', async () => {
    seq = 0;
    const { client, responded } = fakeClient([questionFrame('q-9')]);
    render(<App client={client} />);
    const card = await screen.findByTestId('question-card');

    fireEvent.click(within(card).getByRole('button', { name: '放棄整組問題' }));
    await waitFor(() => {
      expect(responded).toHaveLength(1);
    });
    // 這兩者在模型那頭是不同的事：放棄讓工具回錯誤，全跳過仍是一份答案。
    expect(responded[0]).toEqual({
      namespace: ['tools:a'],
      interrupt_id: 'q-9',
      response: { cancelled: true },
    });
  });

  it('兩種中斷同時掛著時各畫各的，答掉問答那顆不會動到核准那張', async () => {
    seq = 0;
    const { client, responded } = fakeClient([
      approvalFrame([{ name: 'write_file', allowed: ['approve', 'reject'] }], 'int-1'),
      questionFrame('q-1'),
    ]);
    render(<App client={client} />);

    const question = await screen.findByTestId('question-card');
    expect(screen.getByTestId('approval-card')).toBeTruthy();

    // 按下去之後那顆的字會變成「這題已跳過」，所以每次都重新抓剩下的第一顆——
    // 抓一次存起來按兩下，第二下會落在一個已經不是「跳過」的按鈕上。
    fireEvent.click(within(question).getAllByRole('button', { name: '跳過這題' })[0]!);
    fireEvent.click(within(question).getAllByRole('button', { name: '跳過這題' })[0]!);
    fireEvent.click(within(question).getByRole('button', { name: '送出答案' }));

    await waitFor(() => {
      expect(responded).toHaveLength(1);
    });
    expect(responded[0]).toMatchObject({ interrupt_id: 'q-1' });
    // 問答那張收掉了，核准那張還在——這是「逐顆認領」在畫面上的樣子。
    await waitFor(() => {
      expect(screen.queryByTestId('question-card')).toBeNull();
    });
    const approval = screen.getByTestId('approval-card');

    // **另一個方向也要按一次。** 上面證的是「問答卡送問答形狀」，這一句證的是核准卡沒有
    // 因為旁邊多了一種卡就送錯地方——誤放行的兩個方向要各釘一條，只釘一邊的話，把兩張卡
    // 的送出接反了仍有一半會綠。
    fireEvent.click(within(approval).getByRole('button', { name: '全部核准' }));
    await waitFor(() => {
      expect(responded).toHaveLength(2);
    });
    expect(responded[1]).toEqual({
      namespace: ['tools:a'],
      interrupt_id: 'int-1',
      response: { decisions: [{ type: 'approve' }] },
    });
  });
});

/**
 * 送出框那句灰字講的跟掛著的東西對不對得上。
 *
 * **判準不是「有沒有出現『核准』兩個字」。** 卡上的驗收句寫成那樣，防的是把問答叫成核准；
 * 但兩顆真的都掛著時只講其中一種，是往另一個方向說謊。所以這一組逐格比對「掛著什麼」
 * 與「講了什麼」，兩個方向的誤放行各釘一條。
 */
describe('送出框說的話', () => {
  const approval = {
    kind: 'approval',
    interruptId: 'i',
    namespace: [],
    actions: [],
    allowedDecisions: ['approve'],
  } as unknown as Parameters<typeof inputPlaceholder>[0]['pendings'][number];
  const question = {
    kind: 'question',
    interruptId: 'q',
    namespace: [],
    questions: [],
  } as unknown as Parameters<typeof inputPlaceholder>[0]['pendings'][number];

  it('**問答掛著時不講「核准」**——這是卡上那句驗收句', () => {
    const text = inputPlaceholder({
      status: 'awaiting-input',
      connected: true,
      pendings: [question],
      stuck: false,
    });
    expect(text).not.toContain('核准');
    // 光是「不含核准」的話，「說點什麼…」也會綠——那等於把問答整個藏起來。
    expect(text).toContain('問題');
  });

  it('核准掛著時照舊講核准，也不順口提問題', () => {
    const text = inputPlaceholder({
      status: 'awaiting-input',
      connected: true,
      pendings: [approval],
      stuck: false,
    });
    expect(text).toContain('核准');
    expect(text).not.toContain('問題');
  });

  it('**兩種都掛著時兩種都講**——只講一種就是往另一個方向說謊', () => {
    const text = inputPlaceholder({
      status: 'awaiting-input',
      connected: true,
      pendings: [approval, question],
      stuck: false,
    });
    expect(text).toContain('核准');
    expect(text).toContain('問題');
  });

  it('**卡死的核准旁邊還掛著問答時，不把那組問題吞掉**', () => {
    // `stuck` 是核准卡專屬的解鎖（送出框放開讓人講得出原因）。照舊的寫法整條分支會直接
    // 掉到「說點什麼…」——而問答卡永遠按得動，那組問題還答得掉。
    const text = inputPlaceholder({
      status: 'awaiting-input',
      connected: true,
      pendings: [approval, question],
      stuck: true,
    });
    expect(text).toContain('問題');
    expect(text).toContain('說點什麼');
  });

  it('卡死的核准自己一張時照舊只邀請說話', () => {
    expect(
      inputPlaceholder({
        status: 'awaiting-input',
        connected: true,
        pendings: [approval],
        stuck: true,
      }),
    ).toBe('說點什麼…');
  });

  it('沒在等人的時候照舊分連上了沒有', () => {
    expect(inputPlaceholder({ status: 'idle', connected: true, pendings: [], stuck: false })).toBe(
      '說點什麼…',
    );
    expect(inputPlaceholder({ status: 'idle', connected: false, pendings: [], stuck: false })).toBe(
      '連線中…',
    );
  });

  it('**接到真的線上也是這樣**——上面那幾條是純函式，這一條證它真的接在 input 上', async () => {
    seq = 0;
    const { client } = fakeClient([questionFrame('q-only')]);
    render(<App client={client} />);

    await screen.findByTestId('question-card');
    const input = screen.getByLabelText('要說的話');
    await waitFor(() => {
      expect(input.getAttribute('placeholder')).toContain('問題');
    });
    expect(input.getAttribute('placeholder')).not.toContain('核准');
  });
});

/**
 * 問答收尾之後 transcript 上留下的那一行。
 *
 * **兩條是一對。** 只釘放棄那條的話，一個把每一則都寫成「放棄了這組問題」的實作也會綠；
 * 只釘答完那條的話，就回到 [#239](https://github.com/DemianLi/nexus-agent/issues/239) 量到的
 * 原狀——「已回答：」後面一片空白。誤放行的兩個方向要各釘一條。
 */
describe('問答的收尾在 transcript 上長什麼樣', () => {
  it('**放棄整組不是「已回答：」加空白**——它根本不是一種回答', async () => {
    seq = 0;
    const { client } = fakeClient([questionFrame('q-c')]);
    render(<App client={client} />);
    const card = await screen.findByTestId('question-card');

    fireEvent.click(within(card).getByRole('button', { name: '放棄整組問題' }));

    const entry = await screen.findByTestId('answer-entry');
    expect(entry.textContent).toContain('放棄');
    // **這一句才是驗收句。** 上面那句在「已回答：放棄」這種寫法底下也會綠。
    expect(entry.textContent).not.toContain('已回答');
  });

  it('**答完的照舊逐題攤開**，而且「跳過」與「沒答」分得出來', async () => {
    seq = 0;
    const { client } = fakeClient([questionFrame('q-a')]);
    render(<App client={client} />);
    const card = await screen.findByTestId('question-card');

    // 第一題跳過、第二題選一個——兩種編碼各出現一次。
    fireEvent.click(within(card).getAllByRole('button', { name: '跳過這題' })[0]!);
    // `multi_select` 沒給就是單選，所以是 radio 不是 checkbox。
    fireEvent.click(within(card).getByRole('radio', { name: '週二' }));
    fireEvent.click(within(card).getByRole('button', { name: '送出答案' }));

    const entry = await screen.findByTestId('answer-entry');
    expect(entry.textContent).toContain('已回答');
    expect(entry.textContent).toContain('name＝（跳過）');
    expect(entry.textContent).toContain('day＝週二');
    expect(entry.textContent).not.toContain('放棄');
  });
});
