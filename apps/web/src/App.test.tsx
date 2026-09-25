import type {
  Event,
  SlashDescriptor,
  SlashRunOutcome,
  ThreadListResult,
  UplinkResult,
  WireClient,
} from '@nexus/wire';
import { CONTEXT_MEASURE, MODEL_USAGE, TITLE, TODOS } from '@nexus/wire';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  App,
  inputPlaceholder,
  RESUMED_THREAD_NOTICE,
  STOP_QUESTIONS_LABEL,
  SWITCHED_THREAD_NOTICE,
} from '@/App';
import { NO_DECISION_REASON } from '@/components/approval-card';
import { BLANK_THREAD_LABEL, UNTITLED_THREAD_LABEL } from '@/components/thread-list';
import { STOPPED_QUESTION_TEXT, WITHDRAWN_TOOL_REASON } from '@/lib/question-view';
import { REMEMBERED_THREAD_KEY } from '@/lib/remembered-thread';
import { axeViolations } from '@/test/axe';
import { stubCmdkLayout } from '@/test/cmdk';
import { fakeDownlink } from '@/test/downlink';

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
 * 送出佇列的改與刪同一條理由：這一檔的測試不碰它，碰到就是測試寫錯了，所以回拒絕。
 */
const UNWIRED_QUEUE: Pick<WireClient, 'queueUpdate'> = {
  queueUpdate: async () => ({
    type: 'error',
    id: 0,
    error: 'not_supported',
    message: '這一檔沒有接送出佇列',
  }),
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
  const downlink = fakeDownlink();
  const client: WireClient = {
    slashList: async () => ({ kind: 'ok', commands: slash.commands ?? [] }),
    slashRun: async (_threadId, line) => {
      slashed.push(line);
      return slash.run?.(line) ?? { kind: 'unknown' };
    },
    openEvents: async (threadId) => {
      opened.push(threadId);
      return downlink.open(threadId, events);
    },
    // 收下就照伺服器的順序推「排著」與「領走」，人的話由後者畫（#645）。
    runStart: async (threadId, text) => {
      sent.push(text);
      return { type: 'success', id: 1, result: { run_id: downlink.accept(threadId, text) } };
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
    ...UNWIRED_QUEUE,
    ...UNWIRED_THREAD_LIST,
  };
  return { client, sent, responded, slashed, opened, cancels, downlink };
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

  /**
   * 人的話**等開跑才畫**（#645）：伺服器收下就進送出佇列，領走開跑那一顆 `inbox` 帶 `claimed`，泡泡由它畫——跑著時
   * 送的那句才不會插進正在跑的那一輪中間。送出當下什麼都不畫。
   */
  it('人的話等開跑才畫：送出當下不畫，伺服器領走那一顆到了才畫', async () => {
    seq = 0;
    const fake = fakeClient([frame('lifecycle', [], { event: 'completed', graph_name: 'root' })]);
    let accepted: (() => void) | undefined;
    const client: WireClient = {
      ...fake.client,
      runStart: async (threadId, text) => {
        fake.sent.push(text);
        accepted = () => void fake.downlink.accept(threadId, text);
        return { type: 'success', id: 1, result: { run_id: 'held' } };
      },
    };
    render(<App client={client} />);

    await waitFor(() => expect(screen.getByPlaceholderText('說點什麼…')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('要說的話'), { target: { value: '記一筆。' } });
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    await waitFor(() => expect(fake.sent).toEqual(['記一筆。']));
    expect(screen.queryByText('記一筆。')).toBeNull();

    accepted?.();
    await waitFor(() => expect(screen.getByText('記一筆。')).toBeTruthy());
    // 閒著時收下與領走緊接著到：佇列一次都不畫（Q5）。
    expect(screen.queryByTestId('queue-dock')).toBeNull();
  });

  it('跑著時純文字送得出去、排進佇列；開跑那一刻才出現在對話裡。斜線命令照舊送不出去', async () => {
    seq = 0;
    stubCmdkLayout();
    const fake = fakeClient([frame('lifecycle', [], { event: 'running', graph_name: 'root' })], {
      commands: [{ name: 'plan', description: '計劃模式' }],
    });
    const client: WireClient = {
      ...fake.client,
      runStart: async (threadId, text) => {
        fake.sent.push(text);
        return {
          type: 'success',
          id: 1,
          result: { run_id: fake.downlink.accept(threadId, text, false) },
        };
      },
    };
    render(<App client={client} />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('執行中'));
    const input = screen.getByLabelText('要說的話');
    const sendButton = () => screen.getByRole('button', { name: '送出' }) as HTMLButtonElement;

    fireEvent.change(input, { target: { value: '/plan' } });
    expect(sendButton().disabled).toBe(true);
    fireEvent.change(input, { target: { value: '/feedback' } });
    expect(sendButton().disabled).toBe(false);

    fireEvent.change(input, { target: { value: '下一句' } });
    expect(sendButton().disabled).toBe(false);
    fireEvent.click(sendButton());

    const dock = await screen.findByTestId('queue-dock');
    expect(within(dock).getByText('下一句')).toBeTruthy();
    expect(screen.getAllByText('下一句')).toHaveLength(1);

    fake.downlink.push(fake.opened[0]!, [
      fake.downlink.inboxFrame({ items: [], claimed: { id: 'run-1', text: '下一句' } }),
    ]);
    await waitFor(() => expect(screen.queryByTestId('queue-dock')).toBeNull());
    expect(screen.getAllByText('下一句')).toHaveLength(1);
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
      ...UNWIRED_QUEUE,
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
    // 等核准時送不出下一句話：基座那時會把中斷靜靜丟掉。面板換掉了輸入框（#408），送出鍵不在可及的畫面上，
    // 藏起來的那一顆也照舊是停用的。
    expect(screen.queryByRole('button', { name: '送出' })).toBeNull();
    expect(
      screen.getByRole('button', { name: '送出', hidden: true }).hasAttribute('disabled'),
    ).toBe(true);

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

  it('一顆按鈕都長不出來時也不把輸入框放開：出口是面板上的「停止這一輪」（#409 重寫 `stuck`）', async () => {
    seq = 0;
    // 交集是空的（基座一定會發 reviewConfigs，所以這是防呆）。以前這時把送出框放開（`stuck`），但送出去會撞上
    // 伺服器「停在核准點」，本來就是假出口；現在面板自己帶「停止這一輪」（下一條在釘它）。
    const { client } = fakeClient([approvalFrame([{ name: 'alpha', allowed: [] }])]);
    render(<App client={client} />);

    await waitFor(() => expect(screen.getByTestId('approval-card')).toBeTruthy());
    expect(screen.getByText(NO_DECISION_REASON)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('要說的話'), { target: { value: '換條路' } });
    expect(
      screen.getByRole('button', { name: '送出', hidden: true }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('沒有出路的核准：原因、摺疊的原始中斷與「停止這一輪」，沒有允許與不允許（#376 第 12 條）', async () => {
    seq = 0;
    const { client, cancels } = fakeClient([
      frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
      approvalFrame([{ name: 'alpha', allowed: [] }]),
    ]);
    render(<App client={client} />);

    const panel = await screen.findByTestId('approval-card');
    expect(within(panel).queryByRole('button', { name: '全部核准' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: '全部拒絕' })).toBeNull();
    // 原始中斷先摺著。
    expect(within(panel).queryByText('alpha')).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: '原始中斷內容' }));
    expect(await within(panel).findByText('alpha')).toBeTruthy();

    fireEvent.click(within(panel).getByRole('button', { name: '停止這一輪' }));
    await waitFor(() => expect(cancels).toHaveLength(1));
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

  it('**同一輪兩顆中斷：一次一個面板、先來先處理，決定落在自己那顆上**', async () => {
    // 逐次呼叫的閘門會發**兩顆**中斷（[#232](https://github.com/DemianLi/nexus-agent/issues/232)）。
    // #408 起面板換掉輸入框、同時只一個、先來先處理（#376 第 4 條），名稱帶跨面板進度。
    //
    // **承重的是兩句 `interrupt_id`。** 兩個面板都把決定送給 `pendings[0]` 的話，第二次會送出 `int-1`——
    // 而那正是換手最可能長出來的 bug：畫面換到 beta，答掉的還是 alpha。
    seq = 0;
    const { client, responded } = fakeClient([
      approvalFrame([{ name: 'alpha', allowed: ['approve', 'reject'] }], 'int-1'),
      approvalFrame([{ name: 'beta', allowed: ['approve', 'reject'] }], 'int-2'),
    ]);
    render(<App client={client} />);

    // 先來的那顆先畫；只有一個面板。
    const first = await screen.findByRole('region', { name: '等待核准：alpha（1／2）' });
    expect(screen.getAllByTestId('approval-card')).toHaveLength(1);
    expect(within(first).queryByText('beta')).toBeNull();
    // 狀態列唸的就是面板名稱。
    expect(screen.getByRole('status').textContent).toBe('等待核准：alpha（1／2）');

    fireEvent.click(within(first).getByRole('button', { name: '全部核准' }));
    await waitFor(() => expect(responded.length).toBe(1));
    expect(responded[0]).toEqual({
      namespace: ['tools:a'],
      interrupt_id: 'int-1',
      response: { decisions: [{ type: 'approve' }] },
    });

    // 答掉的收走，下一個接上——只剩一個，不帶進度。
    const second = await screen.findByRole('region', { name: '等待核准：beta' });
    expect(screen.getByRole('status').textContent).toBe('等待核准：beta');
    fireEvent.click(within(second).getByRole('button', { name: '全部核准' }));
    await waitFor(() => expect(responded.length).toBe(2));
    expect(responded[1]).toMatchObject({ interrupt_id: 'int-2' });
  });

  it('兩張裡有一張沒有出路時也不解鎖：按得動的先處理，輪到它時面板上有「停止這一輪」', async () => {
    // 以前取 `some` 解鎖送出框（`stuck`）；那是假出口（送出去撞上「停在核准點」），#409 拿掉了。
    seq = 0;
    const { client, responded } = fakeClient([
      approvalFrame([{ name: 'alpha', allowed: ['approve', 'reject'] }], 'int-1'),
      approvalFrame([{ name: 'beta', allowed: [] }], 'int-2'),
    ]);
    render(<App client={client} />);

    const first = await screen.findByRole('region', { name: '等待核准：alpha（1／2）' });
    fireEvent.change(screen.getByLabelText('要說的話'), { target: { value: '換條路' } });
    expect(
      screen.getByRole('button', { name: '送出', hidden: true }).hasAttribute('disabled'),
    ).toBe(true);

    fireEvent.click(within(first).getByRole('button', { name: '全部核准' }));
    await waitFor(() => expect(responded).toHaveLength(1));
    const second = await screen.findByRole('region', { name: '等待核准：beta' });
    expect(within(second).getByRole('button', { name: '停止這一輪' })).toBeTruthy();
  });
});

describe('斜線命令', () => {
  const planCommand: SlashDescriptor = {
    name: 'plan',
    description: '進出計劃模式。',
    input: { hint: '[off]' },
  };

  beforeEach(stubCmdkLayout);

  it('打 `/` 跳命令選單（#407）；輸入框底下不再有扁平清單', async () => {
    seq = 0;
    const { client } = fakeClient([], { commands: [planCommand] });
    render(<App client={client} />);

    await waitFor(() => expect(screen.getByPlaceholderText('說點什麼…')).toBeTruthy());
    expect(screen.queryByText('/plan [off]')).toBeNull();
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.change(screen.getByLabelText('要說的話'), { target: { value: '/' } });
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByRole('option').textContent).toContain('/plan [off]');
  });

  it('從選單選 `/feedback`：開回饋框、不走 slash.run（它帶參數，但光打名字另有動作）', async () => {
    seq = 0;
    const { client, slashed } = fakeClient([], {
      commands: [{ name: 'feedback', description: '記下回饋', input: { hint: '<內容>' } }],
    });
    render(<App client={client} />);

    await waitFor(() => expect(screen.getByPlaceholderText('說點什麼…')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('要說的話'), { target: { value: '/fe' } });
    await screen.findByRole('listbox');
    fireEvent.keyDown(screen.getByLabelText('要說的話'), { key: 'Enter' });
    await screen.findByRole('dialog');
    expect(slashed).toEqual([]);
  });

  it('一輪在跑時從選單選不帶參數的命令：不執行，那一行留在草稿裡', async () => {
    seq = 0;
    const { client, slashed } = fakeClient(
      [frame('lifecycle', [], { event: 'running', graph_name: 'root' })],
      { commands: [{ name: 'todo', description: '列出待辦' }] },
    );
    render(<App client={client} />);

    await waitFor(() => expect(screen.getByRole('button', { name: '停止' })).toBeTruthy());
    const input = screen.getByLabelText<HTMLTextAreaElement>('要說的話');
    fireEvent.change(input, { target: { value: '/to' } });
    await screen.findByRole('listbox');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('/todo');
    expect(slashed).toEqual([]);
    expect(screen.getByRole('button', { name: '送出' }).hasAttribute('disabled')).toBe(true);
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

  it('停在核准點時沒有停止——想結束就按不允許（#376 第 10、11 條）', async () => {
    // 翻面的絆索：#265 Q7「停在核准點按停止收回」在畫面上沒有入口了，demian 知情後選的。
    seq = 0;
    const { client } = fakeClient([
      frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
      approvalFrame([{ name: 'danger', allowed: ['approve', 'reject'] }]),
    ]);
    render(<App client={client} />);
    const panel = await screen.findByTestId('approval-card');
    expect(screen.queryByRole('button', { name: '停止' })).toBeNull();
    expect(screen.queryByRole('button', { name: '停止這一輪' })).toBeNull();
    expect(within(panel).getByRole('button', { name: '全部拒絕' })).toBeTruthy();
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
  /**
   * 一句話伺服器沒收下（#645 Q4）：跳 toast、草稿放回去。**不寫頂端的紅字**：那一行講的是這條線的狀態，一句話
   * 沒送出去是這一句的事，而且放回去的草稿就在眼前。
   */
  it.each([
    [
      '回錯誤封包（200 ＋ error）',
      async (): Promise<UplinkResult> => ({
        type: 'error',
        id: 1,
        error: 'invalid_argument',
        message: '這條 thread 收不了',
      }),
      '這條 thread 收不了',
    ],
    [
      '這一趟就斷了',
      async (): Promise<UplinkResult> => {
        throw new Error('fetch failed');
      },
      'fetch failed',
    ],
  ])('送出沒收下：跳 toast、草稿放回去，頂端不寫紅字（%s）', async (_case, runStart, message) => {
    seq = 0;
    const fake = fakeClient([frame('lifecycle', [], { event: 'completed', graph_name: 'root' })]);
    render(<App client={{ ...fake.client, runStart }} />);

    await waitFor(() => expect(screen.getByPlaceholderText('說點什麼…')).toBeTruthy());
    const input = screen.getByLabelText('要說的話') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '一句話' } });
    fireEvent.click(screen.getByRole('button', { name: '送出' }));

    // sonner 的 toast 是全域的、跨測試留著：斷言這一條才有的說明，不斷言共用的標題。
    expect(await screen.findByText(message)).toBeTruthy();
    await waitFor(() => expect(input.value).toBe('一句話'));
    expect(screen.getByRole('status').textContent).not.toContain('沒送出去');
    expect(screen.queryByTestId('queue-dock')).toBeNull();
  });

  it('草稿放回去時不蓋掉已經開始打的下一句', async () => {
    seq = 0;
    const fake = fakeClient([frame('lifecycle', [], { event: 'completed', graph_name: 'root' })]);
    let reject: (result: UplinkResult) => void = () => undefined;
    const runStart = () =>
      new Promise<UplinkResult>((resolve) => {
        reject = resolve;
      });
    render(<App client={{ ...fake.client, runStart }} />);

    await waitFor(() => expect(screen.getByPlaceholderText('說點什麼…')).toBeTruthy());
    const input = screen.getByLabelText('要說的話') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '第一句' } });
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    fireEvent.change(input, { target: { value: '第二句' } });
    reject({ type: 'error', id: 1, error: 'invalid_argument', message: '第一句收不了' });

    expect(await screen.findByText('第一句收不了')).toBeTruthy();
    expect(input.value).toBe('第二句');
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

/** 這兩題的提問面板（#409）：換手層的 region，名稱與狀態列同一句。 */
const questionPanel = () => screen.findByRole('region', { name: '有 2 個問題要你回答' });

/** 當前這一題的自由作答列。其他題的 fieldset 是 `hidden`，`getByRole` 不會抓到。 */
const freeAnswer = (panel: HTMLElement) =>
  within(panel).getByRole('textbox', { name: '輸入你的答案' });

describe('提問面板', () => {
  it('問答中斷畫成提問面板，不是核准面板；一題一頁', async () => {
    seq = 0;
    const { client } = fakeClient([questionFrame()]);
    render(<App client={client} />);

    const panel = await questionPanel();
    // **同時斷言核准面板沒出現。** 少了這半句，「兩種都畫出來」也會綠，而那正是判別式寫錯時最可能的樣子。
    expect(screen.queryByTestId('approval-card')).toBeNull();
    expect(within(panel).getByText('訪客姓名？')).toBeTruthy();
    // 第二題在下一頁：fieldset 還在（答案要留著），但藏起來了。
    expect(within(panel).queryByRole('group', { name: /哪一天？/ })).toBeNull();
  });

  it('**送出去的是 `{answers}` 與那顆 id**——空的 `selected` 是跳過，不是空字串', async () => {
    seq = 0;
    const { client, responded } = fakeClient([questionFrame('q-7')]);
    render(<App client={client} />);
    const panel = await questionPanel();

    // 第一題自由作答、第二題明著跳過（最後一題按跳過就送出）。
    fireEvent.change(freeAnswer(panel), { target: { value: '阿明' } });
    fireEvent.click(within(panel).getByRole('button', { name: '下一題' }));
    await waitFor(() => expect(within(panel).getByText('哪一天？')).toBeTruthy());
    fireEvent.click(within(panel).getByRole('button', { name: '跳過' }));

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

  it('每一題都要有交代才走得下去——「還沒填」與「就是不想答」要分得開', async () => {
    seq = 0;
    const { client, responded } = fakeClient([questionFrame()]);
    render(<App client={client} />);
    const panel = await questionPanel();

    // 什麼都沒填就按下一題：留在這一題，秀出中文的原因（primitive 預設是英文，§4.3）。
    fireEvent.click(within(panel).getByRole('button', { name: '下一題' }));
    expect(await within(panel).findByRole('alert')).toBeTruthy();
    expect(within(panel).getByRole('alert').textContent).toContain('還沒回答這一題');
    expect(within(panel).getByText('訪客姓名？')).toBeTruthy();
    expect(responded).toHaveLength(0);

    // 按跳過就是一個交代：走到下一題，錯誤收掉。
    fireEvent.click(within(panel).getByRole('button', { name: '跳過' }));
    await waitFor(() => expect(within(panel).getByText('哪一天？')).toBeTruthy());
    expect(within(panel).queryByRole('alert')).toBeNull();
  });

  it('❌＝停止這一輪（§4.3 寫明的例外）：送 run.cancel，不送任何答案——沒有「放棄整組」', async () => {
    seq = 0;
    const { client, responded, cancels } = fakeClient([questionFrame('q-9')]);
    render(<App client={client} />);
    const panel = await questionPanel();

    expect(within(panel).queryByRole('button', { name: '放棄整組問題' })).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: STOP_QUESTIONS_LABEL }));
    await waitFor(() => expect(cancels).toHaveLength(1));
    // 放棄（`{cancelled:true}`）是 dsh 的做法、讓這一輪繼續；這裡是停下來等人直接打字，所以一份回覆都不送。
    expect(responded).toHaveLength(0);
  });

  it('兩種中斷同時掛著時先來先處理，答掉核准那顆才輪到提問，各送各的形狀', async () => {
    seq = 0;
    const { client, responded } = fakeClient([
      approvalFrame([{ name: 'write_file', allowed: ['approve', 'reject'] }], 'int-1'),
      questionFrame('q-1'),
    ]);
    render(<App client={client} />);

    // #408：同時只一個面板、先來先處理——核准先發，所以先畫核准；提問排在後面，進度數兩種一起。
    const approval = await screen.findByRole('region', { name: '等待核准：write_file（1／2）' });
    expect(screen.queryByRole('form')).toBeNull();

    // **核准那顆送核准的形狀**：旁邊多了一種中斷不能讓它送錯地方。
    fireEvent.click(within(approval).getByRole('button', { name: '全部核准' }));
    await waitFor(() => {
      expect(responded).toHaveLength(1);
    });
    expect(responded[0]).toEqual({
      namespace: ['tools:a'],
      interrupt_id: 'int-1',
      response: { decisions: [{ type: 'approve' }] },
    });

    // 核准那顆收掉，提問接上。**另一個方向也要按一次**：誤放行的兩個方向要各釘一條，只釘一邊的話，
    // 把兩種面板的送出接反了仍有一半會綠。
    const question = await questionPanel();
    expect(screen.queryByTestId('approval-card')).toBeNull();
    fireEvent.click(within(question).getByRole('button', { name: '跳過' }));
    await waitFor(() => expect(within(question).getByText('哪一天？')).toBeTruthy());
    fireEvent.click(within(question).getByRole('button', { name: '跳過' }));
    await waitFor(() => {
      expect(responded).toHaveLength(2);
    });
    expect(responded[1]).toMatchObject({ interrupt_id: 'q-1', response: { answers: [{}, {}] } });
  });
});

/** 停在提問時按了停止：這一輪的 frame 照 pump 收回時發的順序（`ThreadPump.#withdraw`）。 */
function stoppedQuestionFrames(): Event[] {
  const input = JSON.stringify({
    questions: [
      { id: 'day', question: '哪一天？', options: [{ label: '週一', description: '早上' }] },
    ],
  });
  return [
    frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
    frame('tools', ['tools:a'], {
      event: 'tool-started',
      tool_call_id: 'ask-1',
      tool_name: 'ask_user_question',
      input,
    }),
    frame('tools', ['tools:a'], { event: 'tool-suspended', tool_call_id: 'ask-1' }),
    questionFrame('q-s'),
    frame('tools', ['tools:a'], {
      event: 'tool-finished',
      tool_call_id: 'ask-1',
      failed: true,
      message: `Error: ${WITHDRAWN_TOOL_REASON}`,
    }),
    frame('lifecycle', [], { event: 'completed', graph_name: 'root', aborted: true }),
  ];
}

/** 停在提問時按了停止之後（§4.3、#376 第 9 條）。 */
describe('停在提問時停止之後', () => {
  it('那張提問工具卡直接展開、列出題目與選項，標「已停止，請直接打字回覆」，不畫紅字', async () => {
    seq = 0;
    const { client } = fakeClient(stoppedQuestionFrames());
    render(<App client={client} />);

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('已停止'));
    const card = screen.getByTestId('tool-entry');
    expect(card.getAttribute('data-state')).toBe('open');
    expect(within(card).getAllByText(STOPPED_QUESTION_TEXT).length).toBeGreaterThan(0);
    expect(within(card).getByText('哪一天？')).toBeTruthy();
    expect(within(card).getByText('週一：早上')).toBeTruthy();
    // 那句紅字是給模型看的英文；停止不是失敗（#276）。
    expect(within(card).queryByText(`Error: ${WITHDRAWN_TOOL_REASON}`)).toBeNull();
    expect(within(card).queryByText('失敗')).toBeNull();
  });

  it('輸入框回來了，提示字跟工具卡同一句', async () => {
    seq = 0;
    const { client } = fakeClient(stoppedQuestionFrames());
    render(<App client={client} />);

    await waitFor(() =>
      expect(screen.getByLabelText('要說的話').getAttribute('placeholder')).toBe(
        STOPPED_QUESTION_TEXT,
      ),
    );
    expect(screen.queryByRole('region', { name: /問題要你回答/ })).toBeNull();
  });
});

/**
 * 送出框那句灰字。
 *
 * **等人回答時它看不見**（面板換掉輸入框，#408／#409），所以以前「掛著核准講核准、掛著問答講問題、兩種都講」
 * 那一組比對拿掉了——那是卡片疊在輸入框上方時的補丁（#239）。剩下連線與「停在提問上被停止」兩格。
 */
describe('送出框說的話', () => {
  it('停在提問上被停止時請人直接打字回覆；其他時候分連上了沒有', () => {
    expect(inputPlaceholder({ connected: true, stoppedOnQuestion: true })).toBe(
      STOPPED_QUESTION_TEXT,
    );
    expect(inputPlaceholder({ connected: true, stoppedOnQuestion: false })).toBe('說點什麼…');
    // 連不上時先講連不上：那時打了字也送不出去。
    expect(inputPlaceholder({ connected: false, stoppedOnQuestion: true })).toBe('連線中…');
  });
});

/**
 * 答完之後（§4.3）：答案列在那張提問工具卡上，transcript 不另插一行。
 */
describe('答完的問題列在提問工具卡上', () => {
  it('**逐題「問題 → 回答」**，而且「跳過」與選了什麼分得出來；沒有另一行紀錄', async () => {
    seq = 0;
    const input = JSON.stringify({
      questions: [
        { id: 'name', question: '訪客姓名？', header: '姓名' },
        { id: 'day', question: '哪一天？', options: [{ label: '週一' }, { label: '週二' }] },
      ],
    });
    const { client } = fakeClient([
      frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
      frame('tools', ['tools:a'], {
        event: 'tool-started',
        tool_call_id: 'ask-1',
        tool_name: 'ask_user_question',
        input,
      }),
      frame('tools', ['tools:a'], { event: 'tool-suspended', tool_call_id: 'ask-1' }),
      questionFrame('q-a'),
    ]);
    render(<App client={client} />);
    const panel = await questionPanel();

    // 第一題跳過、第二題選一個——兩種編碼各出現一次。
    fireEvent.click(within(panel).getByRole('button', { name: '跳過' }));
    // `multi_select` 沒給就是單選，所以是 radio 不是 checkbox。
    fireEvent.click(await within(panel).findByRole('radio', { name: '週二' }));
    fireEvent.click(within(panel).getByRole('button', { name: '送出答案' }));

    await waitFor(() => expect(screen.queryByRole('region', { name: /問題要你回答/ })).toBeNull());
    const card = screen.getByTestId('tool-entry');
    fireEvent.click(within(card).getByRole('button', { name: /提問/ }));
    const rows = within(card).getAllByTestId('question-row');
    expect(rows.map((row) => row.textContent)).toEqual([
      '姓名訪客姓名？→ 回答：（跳過）',
      '哪一天？→ 回答：週二',
    ]);
    expect(screen.queryByTestId('answer-entry')).toBeNull();
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
   * （#306），但中斷的酬載只在當初發出去的那一顆 frame 上。這一條的假 client 連歷史都是空的，送出框也就沒鎖。
   * #637 之前伺服器把這時送的話擋回來；現在照收、排著等那一輪收尾（#645），所以它出現在送出佇列裡，刪得掉。
   */
  it('接回一條停在核准點的 thread：送出去的話排進佇列，看得到也刪得掉', async () => {
    seq = 0;
    remember('停著的那條');
    const fake = fakeClient([]);
    const client: WireClient = {
      ...fake.client,
      // 那一輪還沒收尾：收下、不領走。
      runStart: async (threadId, text) => ({
        type: 'success',
        id: 1,
        result: { run_id: fake.downlink.accept(threadId, text, false) },
      }),
      queueUpdate: async (threadId, params) => fake.downlink.update(threadId, params),
    };
    render(<App client={client} />);
    await waitFor(() => expect(screen.getByPlaceholderText('說點什麼…')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('要說的話'), { target: { value: '一句話' } });
    fireEvent.click(screen.getByRole('button', { name: '送出' }));

    const dock = await screen.findByTestId('queue-dock');
    expect(within(dock).getByText('一句話')).toBeTruthy();
    // 還沒開跑：對話裡沒有這一句。
    expect(
      screen.queryByText('一句話', { selector: '[data-slot="message-scroller-item"] *' }),
    ).toBeNull();

    fireEvent.click(within(dock).getByRole('button', { name: '刪除：一句話' }));
    await waitFor(() => expect(screen.queryByTestId('queue-dock')).toBeNull());
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
        message:
          '這台 server 的會話日誌只在記憶體裡（沒接落盤：清單上 session-persistence 那一列關掉了），以前的 thread 列不出來',
      }),
      'session-persistence',
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
    // 沒有列就沒有東西可搜。
    expect(within(list).queryByRole('searchbox')).toBeNull();
  });

  /** 分組、搜尋、狀態點（inventory 列 6）：分界與比對規則在 `lib/thread-groups.test.ts`，這裡驗畫出來的。 */
  describe('分組、搜尋、狀態點', () => {
    const DAY = 86_400_000;
    function recent(): ThreadListResult {
      const now = Date.now();
      return {
        unreadable: 0,
        items: [
          { threadId: 't1', updatedAt: now, running: true, blank: false, title: '幫我改登入頁' },
          {
            threadId: 't2',
            updatedAt: now - 3 * DAY,
            running: false,
            blank: false,
            title: '讀規格',
          },
          {
            threadId: 't3',
            updatedAt: now - 40 * DAY,
            running: false,
            blank: false,
            title: '登入流程的測試',
          },
        ],
      };
    }

    async function rendered(): Promise<HTMLElement> {
      seq = 0;
      const fake = fakeClient([]);
      render(<App client={listing(fake, async () => ({ kind: 'ok', result: recent() }))} />);
      const list = await openList();
      await waitFor(() => expect(within(list).getAllByRole('button')).toHaveLength(3));
      return list;
    }

    const rowNames = (list: HTMLElement) =>
      within(list)
        .getAllByRole('button')
        .map((row) => row.textContent ?? '');

    it('按今天、過去 7 天、更早分組，每組有名字；沒有列的「昨天」不出現', async () => {
      const list = await rendered();
      expect(within(list).getByRole('group', { name: '今天' }).textContent).toContain(
        '幫我改登入頁',
      );
      expect(within(list).getByRole('group', { name: '過去 7 天' }).textContent).toContain(
        '讀規格',
      );
      expect(within(list).getByRole('group', { name: '更早' }).textContent).toContain(
        '登入流程的測試',
      );
      expect(within(list).queryByRole('group', { name: '昨天' })).toBeNull();
    });

    it('跑著的那一列有一顆點，報讀器唸「執行中」', async () => {
      const list = await rendered();
      const running = within(list).getByRole('button', { name: /幫我改登入頁/ });
      expect(within(running).getByTestId('thread-running').textContent).toBe('執行中');
      expect(within(list).getAllByTestId('thread-running')).toHaveLength(1);
    });

    it('搜標題只留對得上的列，分組照樣在；Esc 清掉', async () => {
      const list = await rendered();
      const search = within(list).getByRole('searchbox', { name: '搜尋以前的會話' });
      fireEvent.change(search, { target: { value: '登入' } });
      expect(rowNames(list)).toHaveLength(2);
      expect(within(list).queryByRole('group', { name: '過去 7 天' })).toBeNull();
      expect(within(list).getByRole('group', { name: '更早' })).toBeTruthy();

      fireEvent.keyDown(search, { key: 'Escape' });
      expect((search as HTMLInputElement).value).toBe('');
      expect(rowNames(list)).toHaveLength(3);
    });

    it('搜不到時講一聲，不說「還沒有」', async () => {
      const list = await rendered();
      fireEvent.change(within(list).getByRole('searchbox'), { target: { value: '部署' } });
      expect(within(list).queryAllByRole('button')).toHaveLength(0);
      expect(within(list).getByRole('status').textContent).toBe('沒有標題含「部署」的會話。');
      expect(list.textContent).not.toContain('還沒有以前的會話');
    });

    it('過 axe', async () => {
      await rendered();
      expect(await axeViolations(document.body)).toEqual([]);
    });
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

describe('待辦清單面板（#575）', () => {
  it('停下來等核准時清單照樣在：畫在換手區外面、上面', async () => {
    seq = 0;
    const { client } = fakeClient([
      frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
      frame('custom', [], {
        name: TODOS,
        payload: {
          todos: [
            { content: '讀規格', status: 'completed' },
            { content: '改設定檔', status: 'in_progress' },
          ],
        },
      }),
      approvalFrame([{ name: 'write_file', allowed: ['approve', 'reject'] }]),
    ]);
    render(<App client={client} />);

    const approval = await screen.findByTestId('approval-card');
    const panel = screen.getByTestId('todo-panel');
    expect(within(panel).getByRole('button').getAttribute('aria-label')).toBe(
      '待辦清單：1/2 完成 · 改設定檔',
    );
    // 換手區（`PendingSwap` 的 zone）搬焦點時只看自己裡面；清單在它外面、排在它前面。
    const zone = approval.closest('.motion-swap')?.parentElement;
    expect(zone).toBeTruthy();
    expect(zone?.contains(panel)).toBe(false);
    expect(
      panel.compareDocumentPosition(zone as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe('用量表（#528）', () => {
  const pressureFrames = () => [
    frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
    frame('custom', [], { name: MODEL_USAGE, payload: { inputTokens: 4321 } }),
    frame('custom', [], {
      name: CONTEXT_MEASURE,
      payload: {
        approxTokens: 5,
        messageCount: 3,
        thresholds: [
          { type: 'tokens', value: 10 },
          { type: 'messages', value: 4 },
        ],
      },
    }),
  ];

  it('畫在輸入框底列「Enter 送出」旁邊，數字來自線上', async () => {
    seq = 0;
    const { client } = fakeClient(pressureFrames());
    render(<App client={client} />);

    const meter = await screen.findByTestId('context-meter');
    expect(meter.getAttribute('aria-label')).toBe('對話用量：約 75%，點開看明細');
    expect(meter.previousElementSibling?.textContent).toBe('Enter 送出');
    fireEvent.click(meter);
    expect(screen.getByTestId('context-meter-input').textContent).toBe('4,321 token');
  });

  it('點開明細之後底下換成核准面板：明細跟著關，不浮在面板上', async () => {
    seq = 0;
    const { client } = fakeClient([]);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const frames = pressureFrames();
    const approval = approvalFrame([{ name: 'write_file', allowed: ['approve', 'reject'] }]);
    client.openEvents = async () =>
      (async function* stream() {
        yield* frames;
        await gate;
        yield approval;
        await new Promise(() => undefined);
      })();
    render(<App client={client} />);

    fireEvent.click(await screen.findByTestId('context-meter'));
    expect(screen.getByRole('dialog', { name: '對話用量明細' })).toBeTruthy();
    release();
    await screen.findByTestId('approval-card');
    expect(screen.queryByRole('dialog', { name: '對話用量明細' })).toBeNull();
  });
});

describe('會話標題（#655）', () => {
  const LISTED: ThreadListResult = {
    unreadable: 0,
    items: [
      { threadId: '空白那條', updatedAt: 2_000, running: false, blank: true },
      { threadId: '別條', updatedAt: 1_000, running: false, blank: false, title: '別條的標題' },
    ],
  };

  afterEach(() => {
    document.title = 'nexus-agent';
  });

  const heading = () => screen.getByRole('heading', { level: 1 });

  it('空白會話寫「新會話」；第一句開跑推來標題後，標頭、分頁標題、側欄目前這一列一起換，後到的標題取代先到的', async () => {
    seq = 0;
    localStorage.setItem(REMEMBERED_THREAD_KEY, JSON.stringify({ threadId: '空白那條' }));
    const fake = fakeClient([]);
    render(
      <App
        client={{ ...fake.client, listThreads: async () => ({ kind: 'ok', result: LISTED }) }}
      />,
    );

    await waitFor(() => expect(heading().textContent).toBe(BLANK_THREAD_LABEL));
    expect(document.title).toBe('nexus-agent');
    const list = await screen.findByRole('group', { name: '以前的會話' });
    await waitFor(() =>
      expect(
        within(list).getByRole('button', { name: new RegExp(BLANK_THREAD_LABEL) }),
      ).toBeTruthy(),
    );

    fireEvent.change(screen.getByLabelText('要說的話'), { target: { value: '幫我修登入' } });
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    await waitFor(() => expect(screen.getByText('幫我修登入')).toBeTruthy());
    fake.downlink.push(fake.opened[0]!, [fake.downlink.titleFrame('幫我修登入')]);

    await waitFor(() => expect(heading().textContent).toBe('幫我修登入'));
    expect(heading().getAttribute('title')).toBe('幫我修登入');
    expect(document.title).toBe('幫我修登入 — nexus-agent');
    const current = within(list).getByRole('button', { name: /幫我修登入/ });
    expect(current.textContent).toContain('目前這條');
    expect(list.textContent).not.toContain(BLANK_THREAD_LABEL);

    // #650：模型產生的標題可能在這一輪收完、閒著的時候才推來，照樣換；搜尋吃得到新標題。
    fake.downlink.push(fake.opened[0]!, [
      fake.downlink.lifecycleFrame('running'),
      fake.downlink.lifecycleFrame('completed'),
    ]);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('就緒'));
    fake.downlink.push(fake.opened[0]!, [fake.downlink.titleFrame('修好登入頁的錯誤')]);
    await waitFor(() => expect(heading().textContent).toBe('修好登入頁的錯誤'));
    expect(document.title).toBe('修好登入頁的錯誤 — nexus-agent');
    fireEvent.change(within(list).getByRole('searchbox', { name: '搜尋以前的會話' }), {
      target: { value: '錯誤' },
    });
    await waitFor(() => expect(within(list).getAllByRole('button')).toHaveLength(1));
    expect(within(list).getByRole('button').textContent).toContain('修好登入頁的錯誤');
  });

  it('接回一條有標題的：從歷史就讀得到', async () => {
    seq = 0;
    const { client } = fakeClient([
      frame('custom', [], { name: TITLE, payload: { title: '舊的那條' } }),
      ...textFrames('root-1', ['model_request:a'], '好。'),
      frame('lifecycle', [], { event: 'completed', graph_name: 'root' }),
    ]);
    render(<App client={client} />);
    await waitFor(() => expect(heading().textContent).toBe('舊的那條'));
    expect(document.title).toBe('舊的那條 — nexus-agent');
  });

  it('有輪次但沒有標題（目標排的）：跟列表講同一句', async () => {
    seq = 0;
    const { client } = fakeClient([
      ...textFrames('root-1', ['model_request:a'], '目標排的一輪。'),
      frame('lifecycle', [], { event: 'completed', graph_name: 'root' }),
    ]);
    render(<App client={client} />);
    await waitFor(() => expect(heading().textContent).toBe(UNTITLED_THREAD_LABEL));
    expect(document.title).toBe('nexus-agent');
  });

  it('卸掉時分頁標題還原成產品名', async () => {
    seq = 0;
    const { client } = fakeClient([
      frame('custom', [], { name: TITLE, payload: { title: '要走的那條' } }),
    ]);
    const { unmount } = render(<App client={client} />);
    await waitFor(() => expect(document.title).toBe('要走的那條 — nexus-agent'));
    unmount();
    expect(document.title).toBe('nexus-agent');
  });
});
