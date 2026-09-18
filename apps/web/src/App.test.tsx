import type {
  Event,
  PendingApproval,
  PendingQuestion,
  SlashDescriptor,
  SlashRunOutcome,
  ThreadListResult,
  WireClient,
} from '@nexus/wire';
import { APPROVAL_PENDING_KIND, QUESTION_PENDING_KIND } from '@nexus/wire';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App, inputPlaceholder, RESUMED_THREAD_NOTICE, SWITCHED_THREAD_NOTICE } from '@/App';
import { BLANK_THREAD_LABEL, UNTITLED_THREAD_LABEL } from '@/components/thread-list';
import { REMEMBERED_THREAD_KEY } from '@/lib/remembered-thread';
import { axeViolations } from '@/test/axe';

/**
 * 一份活在記憶體裡的 `Storage`。
 *
 * **不用環境給的那一份**：Node 25 自己帶一個全域 `localStorage`，沒給 `--localstorage-file`
 * 時上面連 `getItem` 都沒有，而它蓋住了 jsdom 的那一份（實測 `getItem is not a function`）。
 * App 在那種環境照樣開得起來——那正是「讀寫失敗只是記不住」那條約定——但測試要的是一份真的
 * 記得住的。
 */
function memoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => void entries.delete(key),
    setItem: (key, value) => void entries.set(key, String(value)),
  };
}

// App 會把 thread id 記進 `localStorage`；每條一份新的，不然下一條測試就成了「接回上一次」。
beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

/**
 * 回饋那四個 method 在這一檔裡一律「收不了」。**評分的畫面驗在 `feedback-ui.test.tsx`**；這裡的測試
 * 不碰它們，碰到就是測試寫錯了，所以回拒絕而不是回成功。
 */
const UNWIRED_FEEDBACK: Pick<
  WireClient,
  'feedbackPut' | 'feedbackDelete' | 'feedbackList' | 'feedbackRecord'
> = {
  feedbackPut: async () => ({ kind: 'rejected', message: '這一檔沒有接回饋' }),
  feedbackDelete: async () => ({ kind: 'rejected', message: '這一檔沒有接回饋' }),
  feedbackList: async () => ({ kind: 'rejected', message: '這一檔沒有接回饋' }),
  feedbackRecord: async () => ({ kind: 'rejected', message: '這一檔沒有接回饋' }),
};

/**
 * 「以前的會話」同一條理由：要清單的測試自己換掉這一格。**歷史回一份空的、不是拒絕**：每一條 thread 開起來都會
 * 拿歷史，拒絕的話畫面上多一行「拿不回來」，跟這一條測試要驗的東西無關。要歷史的測試自己換掉。
 */
const UNWIRED_THREAD_LIST: Pick<WireClient, 'listThreads' | 'threadHistory'> = {
  listThreads: async () => ({ kind: 'rejected', message: '這一條測試沒有接清單' }),
  threadHistory: async () => ({
    kind: 'ok',
    result: { events: [], firstSeq: 0, throughSeq: -1, hasMore: false, legacy: false },
  }),
};

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
  const opened: string[] = [];
  const cancels: string[] = [];
  const client: WireClient = {
    slashList: async () => ({ kind: 'ok', commands: slash.commands ?? [] }),
    slashRun: async (_threadId, line) => {
      slashed.push(line);
      return slash.run?.(line) ?? { kind: 'unknown' };
    },
    openEvents: async (threadId) => {
      opened.push(threadId);
      return (async function* stream() {
        for (const event of events) {
          yield event;
        }
        await new Promise(() => undefined);
      })();
    },
    runStart: async (_threadId, text) => {
      sent.push(text);
      return { type: 'success', id: 1, result: {} };
    },
    inputRespond: async (_threadId, params) => {
      responded.push(params);
      return { type: 'success', id: 2, result: {} };
    },
    runCancel: async (threadId) => {
      cancels.push(threadId);
      return { type: 'success', id: 3, result: { accepted: true } };
    },
    ...UNWIRED_FEEDBACK,
    ...UNWIRED_THREAD_LIST,
  };
  return { client, sent, responded, slashed, opened, cancels };
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

  it('主畫面（對話流＋工具＋子代理歸屬）過 axe', async () => {
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
      frame('lifecycle', [], { event: 'completed', graph_name: 'root' }),
    ]);

    const { container } = render(<App client={client} />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('就緒'));

    expect(await axeViolations(container)).toEqual([]);
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
      runCancel: async () => ({ type: 'success', id: 1, result: { accepted: true } }),
      slashList: async () => ({ kind: 'ok', commands: [] }),
      slashRun: async () => ({ kind: 'unknown' }),
      ...UNWIRED_FEEDBACK,
      ...UNWIRED_THREAD_LIST,
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
    expect(document.querySelectorAll('[data-slot="message-scroller-item"]')).toHaveLength(0);
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

describe('停止（#276）', () => {
  it('一輪在跑時出現停止，按下去送 run.cancel', async () => {
    seq = 0;
    const { client, cancels } = fakeClient([
      frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
    ]);
    render(<App client={client} />);
    fireEvent.click(await screen.findByRole('button', { name: '停止' }));
    await waitFor(() => expect(cancels).toHaveLength(1));
  });

  it('停在核准點時也有停止——按它就是收回那張卡', async () => {
    seq = 0;
    const { client } = fakeClient([
      frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
      approvalFrame([{ name: 'danger', allowed: ['approve', 'reject'] }]),
    ]);
    render(<App client={client} />);
    expect(await screen.findByRole('button', { name: '停止' })).toBeTruthy();
  });

  it('閒著時沒有停止', async () => {
    seq = 0;
    const { client } = fakeClient([
      frame('lifecycle', [], { event: 'completed', graph_name: 'root' }),
    ]);
    render(<App client={client} />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('就緒'));
    expect(screen.queryByRole('button', { name: '停止' })).toBeNull();
  });

  it('收到帶 aborted 的收尾：狀態列說已停止，不是失敗；被打斷的那則標出來', async () => {
    seq = 0;
    const { client } = fakeClient([
      frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
      frame('messages', ['model_request:a'], { event: 'message-start', id: 'run-r', run_id: 'r' }),
      frame('messages', ['model_request:a'], {
        event: 'content-block-delta',
        index: 0,
        delta: { type: 'text-delta', text: '講到一半' },
        run_id: 'r',
      }),
      frame('lifecycle', [], {
        event: 'failed',
        graph_name: 'root',
        error: '這一輪被中止了',
        aborted: true,
      }),
    ]);
    render(<App client={client} />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('已停止'));
    expect(screen.getByRole('status').textContent).not.toContain('失敗');
    expect(screen.getByText('講到一半')).toBeTruthy();
    expect(screen.getByText('（已停止）')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '停止' })).toBeNull();
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
      runCancel: async () => ({ type: 'success', id: 3, result: { accepted: true } }),
      slashList: async () => ({ kind: 'ok', commands: [] }),
      slashRun: async () => ({ kind: 'unknown' }),
      ...UNWIRED_FEEDBACK,
      ...UNWIRED_THREAD_LIST,
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

    // **「兩種都掛著時兩種都講」是這一刀自己判的那一格**，所以它要在真的 frame ＋ 真的
    // 折疊器底下也成立一次——純函式那一組餵的是手工 pending，餵錯了會一起錯。
    const bothPlaceholder = screen.getByLabelText('要說的話').getAttribute('placeholder');
    expect(bothPlaceholder).toContain('核准');
    expect(bothPlaceholder).toContain('問題');

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
  // **不用 `as unknown as`，也不寫死字串。** `isApprovalPending` 的註解就寫著述詞存在
  // 的理由是「比對錯了型別不會擋，因為那是一個字串」——替身自己繞過型別的話，這一組就
  // 守不到欄位加寬或判別式改字。
  const approval: PendingApproval = {
    kind: APPROVAL_PENDING_KIND,
    interruptId: 'i',
    namespace: [],
    actions: [],
    allowedDecisions: ['approve'],
  };
  const question: PendingQuestion = {
    kind: QUESTION_PENDING_KIND,
    interruptId: 'q',
    namespace: [],
    questions: [],
  };

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

  it('**卡死的核准 ＋ 問答，走真的 frame**——那組問題沒有被解鎖那條路吞掉', async () => {
    seq = 0;
    // `allowed: []` ＝ 一顆按鈕都長不出來的核准請求，也就是 `stuck`。
    const { client } = fakeClient([
      approvalFrame([{ name: 'write_file', allowed: [] }], 'stuck-1'),
      questionFrame('q-beside'),
    ]);
    render(<App client={client} />);

    await screen.findByTestId('question-card');
    const input = screen.getByLabelText('要說的話');
    await waitFor(() => {
      expect(input.getAttribute('placeholder')).toContain('問題');
    });
    // 解鎖本身照舊——這一格的重點是兩件事都講，不是把解鎖收回去。
    expect(input.getAttribute('placeholder')).toContain('說點什麼');
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

describe('記住這條 thread', () => {
  /** 存著的那一條。沒有就是 `undefined`。 */
  function stored(): string | undefined {
    const raw = localStorage.getItem(REMEMBERED_THREAD_KEY);
    return raw === null ? undefined : (JSON.parse(raw) as { threadId: string }).threadId;
  }

  function remember(threadId: string): void {
    localStorage.setItem(REMEMBERED_THREAD_KEY, JSON.stringify({ threadId }));
  }

  it('第一次載入：開一條新的、記下來，不說「接著上一次」', async () => {
    seq = 0;
    const { client, opened } = fakeClient([]);
    render(<App client={client} />);

    await waitFor(() => expect(opened).toHaveLength(1));
    await waitFor(() => expect(stored()).toBe(opened[0]));
    expect(screen.queryByText(RESUMED_THREAD_NOTICE)).toBeNull();
  });

  /** jsdom 裡的重新整理：拆掉再掛一次，中間只剩 `localStorage`。 */
  it('重新載入：開的是同一條，而且講一聲是接著上一次', async () => {
    seq = 0;
    const first = fakeClient([]);
    render(<App client={first.client} />);
    await waitFor(() => expect(stored()).toBe(first.opened[0]));
    cleanup();

    const second = fakeClient([]);
    render(<App client={second.client} />);
    await waitFor(() => expect(second.opened).toEqual(first.opened));
    expect(screen.getByText(RESUMED_THREAD_NOTICE)).toBeTruthy();
  });

  it('新對話：換一個 id、記下來，上一條的話與提示都不留在畫面上', async () => {
    seq = 0;
    remember('上一條');
    const { client, opened } = fakeClient([
      frame('lifecycle', [], { event: 'completed', graph_name: 'root' }),
    ]);
    render(<App client={client} />);
    await waitFor(() => expect(screen.getByPlaceholderText('說點什麼…')).toBeTruthy());
    expect(opened).toEqual(['上一條']);
    fireEvent.change(screen.getByLabelText('要說的話'), { target: { value: '記一筆。' } });
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    await waitFor(() => expect(screen.getByText('記一筆。')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: '新對話' }));

    await waitFor(() => expect(opened).toHaveLength(2));
    expect(opened[1]).not.toBe('上一條');
    await waitFor(() => expect(stored()).toBe(opened[1]));
    // **只斷言「開了另一條」不夠**：不重掛的話下行照樣換一條，留下來的是上一條的 transcript。
    expect(screen.queryByText('記一筆。')).toBeNull();
    expect(screen.queryByText(RESUMED_THREAD_NOTICE)).toBeNull();
  });

  /**
   * serve 還開著，重新整理之後接回一條停在核准點的 thread。**核准卡補不回來**：歷史重播得出那幾張工具卡
   * （#306），但中斷的酬載只在當初發出去的那一顆 frame 上。這一條的假 client 連歷史都是空的，送出框也就沒鎖，
   * 送出去被擋回來——畫面上的出口是「新對話」。
   */
  it('接回一條停在核准點的 thread：拒絕照樣說出來，新對話走得出去', async () => {
    seq = 0;
    remember('停著的那條');
    const fake = fakeClient([]);
    const opened = fake.opened;
    const client: WireClient = {
      ...fake.client,
      runStart: async (threadId) =>
        threadId === '停著的那條'
          ? {
              type: 'error',
              id: 1,
              error: 'invalid_argument',
              message: '這條 thread 停在核准點：先用 input.respond 回答它，再說下一句話',
            }
          : { type: 'success', id: 1, result: {} },
    };
    render(<App client={client} />);
    await waitFor(() => expect(screen.getByPlaceholderText('說點什麼…')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('要說的話'), { target: { value: '一句話' } });
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('停在核准點'));

    fireEvent.click(screen.getByRole('button', { name: '新對話' }));

    await waitFor(() => expect(opened).toHaveLength(2));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('就緒'));
  });

  it('跑著的時候「新對話」也按得動——它不看忙不忙', async () => {
    seq = 0;
    const { client } = fakeClient([
      frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
    ]);
    render(<App client={client} />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('執行中'));
    const button = screen.getByRole('button', { name: '新對話' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it('瀏覽器不讓存：照樣開得起來，只是記不住', async () => {
    seq = 0;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('localStorage', {
      ...memoryStorage(),
      getItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
    });
    const { client, opened } = fakeClient([
      frame('lifecycle', [], { event: 'completed', graph_name: 'root' }),
    ]);
    render(<App client={client} />);

    await waitFor(() => expect(screen.getByPlaceholderText('說點什麼…')).toBeTruthy());
    expect(opened).toHaveLength(1);
    expect(screen.queryByText(RESUMED_THREAD_NOTICE)).toBeNull();
  });

  it.each([
    ['不是 JSON', '{壞的'],
    ['缺 threadId', '{}'],
    ['threadId 是空字串', '{"threadId":""}'],
    ['threadId 不是字串', '{"threadId":42}'],
    ['null', 'null'],
  ])('存的東西壞了（%s）：開一條新的，不當成接回來', async (_label, raw) => {
    seq = 0;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    localStorage.setItem(REMEMBERED_THREAD_KEY, raw);
    const { client, opened } = fakeClient([]);
    render(<App client={client} />);

    await waitFor(() => expect(opened).toHaveLength(1));
    expect(screen.queryByText(RESUMED_THREAD_NOTICE)).toBeNull();
    // 壞掉的那一份被這一條蓋掉，下一次載入就接得回來。
    await waitFor(() => expect(stored()).toBe(opened[0]));
  });
});

/**
 * 「以前的會話」（[#302](https://github.com/DemianLi/nexus-agent/issues/302)）。清單怎麼讀、讀得對不對在
 * `@nexus/harness`（`session-list.test.ts` 與產品路徑的 `serve-session-list.test.ts`）；這裡只驗畫出來的
 * 與點下去的。
 */
describe('以前的會話', () => {
  const LISTED: ThreadListResult = {
    unreadable: 1,
    items: [
      {
        threadId: '跑著的那條',
        updatedAt: 3_000,
        running: true,
        blank: false,
        title: '幫我改登入頁',
      },
      { threadId: '目標那條', updatedAt: 2_000, running: false, blank: false },
      { threadId: '空白那條', updatedAt: 1_000, running: false, blank: true },
    ],
  };

  function stored(): string | undefined {
    const raw = localStorage.getItem(REMEMBERED_THREAD_KEY);
    return raw === null ? undefined : (JSON.parse(raw) as { threadId: string }).threadId;
  }

  function listing(fake: ReturnType<typeof fakeClient>, listThreads: WireClient['listThreads']) {
    return { ...fake.client, listThreads };
  }

  /** 桌面（jsdom 沒有 `matchMedia` 就是桌面）側欄預設展開，清單一開始就在。 */
  async function openList(): Promise<HTMLElement> {
    return screen.findByRole('group', { name: '以前的會話' });
  }

  it('側欄看得到才讀、收起來再打開就重讀；別條空白的不列，跑著的有標記，讀不懂的講出份數', async () => {
    seq = 0;
    let reads = 0;
    const fake = fakeClient([]);
    render(
      <App
        client={listing(fake, async () => {
          reads += 1;
          return { kind: 'ok', result: LISTED };
        })}
      />,
    );
    const list = await openList();
    await waitFor(() => expect(within(list).getAllByRole('button')).toHaveLength(2));
    const rows = within(list)
      .getAllByRole('button')
      .map((row) => row.textContent ?? '');
    expect(rows[0]).toContain('幫我改登入頁');
    expect(rows[0]).toContain('執行中');
    expect(rows[1]).toContain(UNTITLED_THREAD_LABEL);
    expect(rows[1]).not.toContain('執行中');
    // **#313 翻過來的那一條**：以前空白那條列在第三列；目前這條是新生的 id，所以別條空白的不列（照 dsh `sessionVisible`）。
    expect(list.textContent).not.toContain(BLANK_THREAD_LABEL);
    expect(list.textContent).toContain('另有 1 份');
    expect(reads).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: '開關側欄' }));
    await waitFor(() => expect(screen.queryByRole('group', { name: '以前的會話' })).toBeNull());
    expect(reads).toBe(1);
    // 收起來只是推到畫面外：整條 inert，Tab 才不會走進去。
    expect(
      screen.getByRole('navigation', { name: '對話', hidden: true }).hasAttribute('inert'),
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '開關側欄' }));
    await openList();
    await waitFor(() => expect(reads).toBe(2));
  });

  it('點一條就切過去：開那一條、記下來、講一聲切過去了，上一條的話不留', async () => {
    seq = 0;
    localStorage.setItem(REMEMBERED_THREAD_KEY, JSON.stringify({ threadId: '上一條' }));
    const fake = fakeClient([frame('lifecycle', [], { event: 'completed', graph_name: 'root' })]);
    render(<App client={listing(fake, async () => ({ kind: 'ok', result: LISTED }))} />);
    await waitFor(() => expect(screen.getByPlaceholderText('說點什麼…')).toBeTruthy());
    expect(screen.getByText(RESUMED_THREAD_NOTICE)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('要說的話'), { target: { value: '記一筆。' } });
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    await waitFor(() => expect(screen.getByText('記一筆。')).toBeTruthy());

    const list = await openList();
    fireEvent.click(await within(list).findByRole('button', { name: /幫我改登入頁/ }));

    await waitFor(() => expect(fake.opened).toEqual(['上一條', '跑著的那條']));
    await waitFor(() => expect(stored()).toBe('跑著的那條'));
    expect(screen.getByText(SWITCHED_THREAD_NOTICE)).toBeTruthy();
    // 從清單點的一定是接回來的：換成確定的那一句，條件句那一句不再出現。
    expect(screen.queryByText(RESUMED_THREAD_NOTICE)).toBeNull();
    expect(screen.queryByText('記一筆。')).toBeNull();
  });

  it('手機（1024 以下）清單在抽屜裡：打開才讀，點一條就切過去並收起抽屜', async () => {
    seq = 0;
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('max-width'),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    let reads = 0;
    const fake = fakeClient([]);
    render(
      <App
        client={listing(fake, async () => {
          reads += 1;
          return { kind: 'ok', result: LISTED };
        })}
      />,
    );
    await waitFor(() => expect(fake.opened).toHaveLength(1));
    expect(screen.queryByRole('group', { name: '以前的會話' })).toBeNull();
    expect(reads).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: '開關側欄' }));
    const drawer = await screen.findByRole('dialog', { name: '側欄' });
    const list = await within(drawer).findByRole('group', { name: '以前的會話' });
    fireEvent.click(await within(list).findByRole('button', { name: /幫我改登入頁/ }));

    await waitFor(() => expect(fake.opened).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '側欄' })).toBeNull());
    expect(reads).toBe(1);
  });

  it('手機抽屜：沒有地標與命名上的 axe 違規；Esc 關掉後焦點回到開關', async () => {
    seq = 0;
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('max-width'),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const fake = fakeClient([]);
    render(<App client={listing(fake, async () => ({ kind: 'ok', result: LISTED }))} />);
    const trigger = screen.getByRole('button', { name: '開關側欄' });
    fireEvent.click(trigger);
    const drawer = await screen.findByRole('dialog', { name: '側欄' });
    await within(drawer).findByRole('button', { name: /幫我改登入頁/ });
    expect(await axeViolations(document.body)).toEqual([]);

    fireEvent.keyDown(drawer, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '側欄' })).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it('目前這條在清單上標出來，按不下去', async () => {
    seq = 0;
    localStorage.setItem(REMEMBERED_THREAD_KEY, JSON.stringify({ threadId: '目標那條' }));
    const fake = fakeClient([]);
    render(<App client={listing(fake, async () => ({ kind: 'ok', result: LISTED }))} />);
    const list = await openList();
    const current = (await within(list).findByRole('button', {
      name: new RegExp(UNTITLED_THREAD_LABEL.replace(/[()（）]/g, '.')),
    })) as HTMLButtonElement;
    expect(current.textContent).toContain('目前這條');
    expect(current.disabled).toBe(true);
  });

  it.each([
    [
      'server 列不了',
      async () => ({
        kind: 'rejected' as const,
        message: '會話日誌只在記憶體裡（serve 沒給 --session-log）',
      }),
      '--session-log',
    ],
    [
      '讀取拋錯',
      async () => {
        throw new Error('列表被載體層擋下：415');
      },
      '415',
    ],
  ])('列不出來（%s）：講原因，不說「還沒有」', async (_label, listThreads, reason) => {
    seq = 0;
    const fake = fakeClient([]);
    render(<App client={listing(fake, listThreads)} />);
    const list = await openList();
    await waitFor(() => expect(list.textContent).toContain('列不出來'));
    expect(list.textContent).toContain(reason);
    expect(list.textContent).not.toContain('還沒有以前的會話');
  });

  it('一條都沒有：講「還沒有」', async () => {
    seq = 0;
    const fake = fakeClient([]);
    render(
      <App
        client={listing(fake, async () => ({ kind: 'ok', result: { items: [], unreadable: 0 } }))}
      />,
    );
    const list = await openList();
    await waitFor(() => expect(list.textContent).toContain('這個專案還沒有以前的會話'));
  });

  it('目前這條是空白、已落盤：照列，標「新會話」、不帶時間', async () => {
    seq = 0;
    localStorage.setItem(REMEMBERED_THREAD_KEY, JSON.stringify({ threadId: '空白那條' }));
    const fake = fakeClient([]);
    render(<App client={listing(fake, async () => ({ kind: 'ok', result: LISTED }))} />);
    const list = await openList();

    await waitFor(() => expect(within(list).getAllByRole('button')).toHaveLength(3));
    const current = within(list).getByRole('button', { name: new RegExp(BLANK_THREAD_LABEL) });
    expect(current.textContent).toBe(`${BLANK_THREAD_LABEL}目前這條`);
  });

  it('磁碟上只剩別條空白的：照講「還沒有」', async () => {
    seq = 0;
    const fake = fakeClient([]);
    const blanks: ThreadListResult = {
      items: [{ threadId: '別條空白', updatedAt: 1_000, running: false, blank: true }],
      unreadable: 0,
    };
    render(<App client={listing(fake, async () => ({ kind: 'ok', result: blanks }))} />);
    const list = await openList();

    await waitFor(() => expect(list.textContent).toContain('這個專案還沒有以前的會話'));
    expect(within(list).queryAllByRole('button')).toHaveLength(0);
  });
});

/**
 * 「新對話」重用空白會話（[#313](https://github.com/DemianLi/nexus-agent/issues/313)），照 dsh `connectWorkspace`。
 * 清單讀不出來的退路由「記住這條 thread」那組驗：那裡的假 client 一律回 rejected，「新對話」照樣換一條新的。
 */
describe('新對話重用空白會話', () => {
  const LISTED: ThreadListResult = {
    unreadable: 0,
    items: [
      {
        threadId: '講過話的那條',
        updatedAt: 3_000,
        running: false,
        blank: false,
        title: '改登入頁',
      },
      { threadId: '空白那條', updatedAt: 2_000, running: false, blank: true },
      { threadId: '更舊的空白', updatedAt: 1_000, running: false, blank: true },
    ],
  };

  function stored(): string | undefined {
    const raw = localStorage.getItem(REMEMBERED_THREAD_KEY);
    return raw === null ? undefined : (JSON.parse(raw) as { threadId: string }).threadId;
  }

  /** 一個讀清單可以卡住的假 client：`hold` 為真時，讀清單等到 `release` 才回。 */
  function gated(fake: ReturnType<typeof fakeClient>, result: ThreadListResult) {
    const state: { reads: number; hold: boolean; release: () => void } = {
      reads: 0,
      hold: false,
      release: () => undefined,
    };
    const client: WireClient = {
      ...fake.client,
      listThreads: async () => {
        state.reads += 1;
        if (!state.hold) return { kind: 'ok', result };
        await new Promise<void>((resolve) => {
          state.release = resolve;
        });
        return { kind: 'ok', result };
      },
    };
    return { client, state };
  }

  async function sayOnce(): Promise<void> {
    await waitFor(() => expect(screen.getByPlaceholderText('說點什麼…')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('要說的話'), { target: { value: '記一筆。' } });
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    await waitFor(() => expect(screen.getByText('記一筆。')).toBeTruthy());
  }

  /** 讓排著的 promise 與 effect 跑完。 */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  it('講過話之後：切到清單上第一條空白的，不開新 id，也不講「切到以前的一條」', async () => {
    seq = 0;
    localStorage.setItem(REMEMBERED_THREAD_KEY, JSON.stringify({ threadId: '上一條' }));
    const fake = fakeClient([frame('lifecycle', [], { event: 'completed', graph_name: 'root' })]);
    render(<App client={gated(fake, LISTED).client} />);
    await sayOnce();

    fireEvent.click(screen.getByRole('button', { name: '新對話' }));

    await waitFor(() => expect(fake.opened).toEqual(['上一條', '空白那條']));
    await waitFor(() => expect(stored()).toBe('空白那條'));
    expect(screen.queryByText(SWITCHED_THREAD_NOTICE)).toBeNull();
    expect(screen.queryByText(RESUMED_THREAD_NOTICE)).toBeNull();
    expect(screen.queryByText('記一筆。')).toBeNull();
  });

  it('清單上沒有空白的：開一條新的', async () => {
    seq = 0;
    localStorage.setItem(REMEMBERED_THREAD_KEY, JSON.stringify({ threadId: '上一條' }));
    const fake = fakeClient([frame('lifecycle', [], { event: 'completed', graph_name: 'root' })]);
    const spoken: ThreadListResult = { unreadable: 0, items: LISTED.items.slice(0, 1) };
    render(<App client={gated(fake, spoken).client} />);
    await sayOnce();

    fireEvent.click(screen.getByRole('button', { name: '新對話' }));

    await waitFor(() => expect(fake.opened).toHaveLength(2));
    expect(fake.opened[1]).not.toBe('上一條');
    expect(fake.opened[1]).not.toBe('講過話的那條');
  });

  it('目前這條還沒講過話：留在原地，連清單都不讀', async () => {
    seq = 0;
    const fake = fakeClient([]);
    const { client, state } = gated(fake, LISTED);
    render(<App client={client} />);
    await waitFor(() => expect(screen.getByPlaceholderText('說點什麼…')).toBeTruthy());
    // 側欄的清單掛上來讀的那一次；下面驗的是「新對話」自己不讀。
    await waitFor(() => expect(state.reads).toBe(1));

    fireEvent.click(screen.getByRole('button', { name: '新對話' }));
    await settle();

    expect(state.reads).toBe(1);
    expect(fake.opened).toHaveLength(1);
  });

  it('連不上的 thread：畫面是空的也不算空白，新對話走得出去', async () => {
    seq = 0;
    const fake = fakeClient([]);
    const tried: string[] = [];
    const client: WireClient = {
      ...fake.client,
      openEvents: async (threadId) => {
        tried.push(threadId);
        throw new Error('下行開不起來：502');
      },
    };
    render(<App client={client} />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('連不上 agent'));

    fireEvent.click(screen.getByRole('button', { name: '新對話' }));

    await waitFor(() => expect(tried).toHaveLength(2));
    expect(tried[1]).not.toBe(tried[0]);
  });

  it('讀清單期間連按兩下：只讀一次、只換一次', async () => {
    seq = 0;
    localStorage.setItem(REMEMBERED_THREAD_KEY, JSON.stringify({ threadId: '上一條' }));
    const fake = fakeClient([frame('lifecycle', [], { event: 'completed', graph_name: 'root' })]);
    const { client, state } = gated(fake, LISTED);
    render(<App client={client} />);
    await sayOnce();
    // 側欄的清單掛上來讀的那一次。
    await waitFor(() => expect(state.reads).toBe(1));
    state.hold = true;

    fireEvent.click(screen.getByRole('button', { name: '新對話' }));
    fireEvent.click(screen.getByRole('button', { name: '新對話' }));
    await waitFor(() => expect(state.reads).toBe(2));
    state.hold = false;
    state.release();

    await waitFor(() => expect(fake.opened).toEqual(['上一條', '空白那條']));
    await settle();
    // 第三次是切過去之後側欄跟著重掛、重讀清單；「新對話」只讀了一次。
    expect(state.reads).toBe(3);
    expect(fake.opened).toEqual(['上一條', '空白那條']);
  });

  it('讀清單期間從清單點了別條：點的那條贏，晚到的清單不把人拉走', async () => {
    seq = 0;
    localStorage.setItem(REMEMBERED_THREAD_KEY, JSON.stringify({ threadId: '上一條' }));
    const fake = fakeClient([frame('lifecycle', [], { event: 'completed', graph_name: 'root' })]);
    const { client, state } = gated(fake, LISTED);
    render(<App client={client} />);
    await sayOnce();
    const list = await screen.findByRole('group', { name: '以前的會話' });
    const pick = await within(list).findByRole('button', { name: /改登入頁/ });
    state.hold = true;

    fireEvent.click(screen.getByRole('button', { name: '新對話' }));
    await waitFor(() => expect(state.reads).toBe(2));
    fireEvent.click(pick);
    await waitFor(() => expect(fake.opened).toEqual(['上一條', '講過話的那條']));
    state.release();
    await settle();

    expect(fake.opened).toEqual(['上一條', '講過話的那條']);
    expect(stored()).toBe('講過話的那條');
  });
});
