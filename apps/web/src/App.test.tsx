import type {
  Event,
  SlashDescriptor,
  SessionReferenceCandidate,
  SlashRunOutcome,
  ThreadFeedFrame,
  ThreadListResult,
  ThreadListOutcome,
  RunStartMode,
  UplinkResult,
  WireClient,
  WireGoal,
} from '@nexus/wire';
import {
  CONTEXT_MEASURE,
  formatSessionReferenceMention,
  GOAL,
  MODEL_USAGE,
  PLAN_MODE,
  SESSION_STATS,
  SUBAGENT_STATUS,
  TITLE,
  TODOS,
  TOKEN_USAGE,
} from '@nexus/wire';
import {
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  App,
  inputPlaceholder,
  RESUMED_THREAD_NOTICE,
  STOP_QUESTIONS_LABEL,
  SWITCHED_THREAD_NOTICE,
} from '@/App';
import { NO_DECISION_REASON } from '@/components/approval-card';
import { BLANK_THREAD_LABEL, UNTITLED_THREAD_LABEL } from '@/components/sidebar/thread-list';
import { ABORTED_BEFORE_DISPATCH_CODE, STOPPED_QUESTION_TEXT } from '@/lib/question-view';
import { REMEMBERED_THREAD_KEY } from '@/lib/remembered-thread';
import { PARKED_STEER_TEXT, PENDING_STEER_TEXT } from '@/lib/steer-view';
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

/** 列檔（`@` 引用，#651）這一檔沒有接：`@` 的選單查一次就收起來。要它的測試自己換掉這一格。 */
const UNWIRED_FILE_REFERENCES: Pick<WireClient, 'fileReferences'> = {
  fileReferences: async () => ({ kind: 'rejected', message: '這一檔沒有接列檔' }),
};

/** 全部會話共用的那條下行（#632）：預設開不起來也不失敗，側欄就跟沒有這條線一樣。要它的測試自己換掉這一格。 */
const SILENT_THREAD_FEED: Pick<WireClient, 'openThreadFeed'> = {
  openThreadFeed: () => new Promise<never>(() => undefined),
};

/** 按內容搜尋（#631）這一檔沒有接：開不起來也不失敗。 */
const UNWIRED_THREAD_SEARCH: Pick<WireClient, 'searchThreads'> = {
  searchThreads: () => new Promise<never>(() => undefined),
};

/** 列會話候選（`@` 引用別的會話，#713）這一檔沒有接。 */
const UNWIRED_SESSION_REFERENCES: Pick<WireClient, 'sessionReferences'> = {
  sessionReferences: async () => ({ kind: 'rejected', message: '這一檔沒有接列會話' }),
};

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

/** 對單一背景子代理傳話、單獨停（#865）同一條理由：這一檔的測試不碰它。 */
const UNWIRED_SUBAGENT: Pick<
  WireClient,
  'subagentSend' | 'subagentInterrupt' | 'subagentHistory' | 'trajectoryTurn'
> = {
  subagentSend: async () => ({
    type: 'error',
    id: 0,
    error: 'not_supported',
    message: '這一檔沒有接背景子代理',
  }),
  subagentInterrupt: async () => ({
    type: 'error',
    id: 0,
    error: 'not_supported',
    message: '這一檔沒有接背景子代理',
  }),
  subagentHistory: async () => ({ kind: 'rejected', message: '這一檔沒有接背景子代理' }),
  trajectoryTurn: async () => ({
    kind: 'rejected',
    code: 'not_supported',
    message: '這一檔沒有接軌跡細節',
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
    ...UNWIRED_FILE_REFERENCES,
    ...SILENT_THREAD_FEED,
    ...UNWIRED_THREAD_SEARCH,
    ...UNWIRED_SESSION_REFERENCES,
    ...UNWIRED_SUBAGENT,
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
  it('伺服器不收附件時沒有加入鈕，貼上檔案照瀏覽器本來的行為（#733）', async () => {
    seq = 0;
    const { client } = fakeClient([
      frame('lifecycle', [], { event: 'completed', graph_name: 'root' }),
    ]);
    render(<App client={client} />);

    const prompt = await screen.findByLabelText('要說的話');
    expect(screen.queryByRole('button', { name: '加入附件' })).toBeNull();
    const proceeded = fireEvent.paste(prompt, {
      clipboardData: {
        files: [new File(['x'], 'a.png', { type: 'image/png' })],
        types: ['Files'],
        getData: () => '',
      },
    });
    expect(proceeded).toBe(true);
    expect(screen.queryByTestId('draft-attachment')).toBeNull();
  });

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

  describe('插話（#710）', () => {
    /** 記下每一句帶的送出模式；插話走 `next-step`，排隊的那句留在隊裡（這一輪還沒收尾）。 */
    function steeringClient(events: readonly Event[]) {
      const fake = fakeClient(events);
      const modes: (RunStartMode | undefined)[] = [];
      /** 每一次 `queue.update` 送了什麼；`hold` 設了就卡著不回，直到 `release()`。 */
      const updates: string[] = [];
      let hold: Promise<void> | undefined;
      const client: WireClient = {
        ...fake.client,
        queueUpdate: async (threadId, params) => {
          updates.push(`${params.item_id}:${params.action.kind}`);
          await hold;
          return fake.downlink.update(threadId, params);
        },
        runStart: async (threadId, text, options) => {
          modes.push(options?.mode);
          const run_id =
            options?.mode === 'steer'
              ? fake.downlink.acceptSteer(threadId, text)
              : fake.downlink.accept(threadId, text, false);
          return { type: 'success', id: 1, result: { run_id } };
        },
      };
      return {
        fake,
        client,
        modes,
        updates,
        holdUpdates() {
          let release!: () => void;
          hold = new Promise<void>((resolve) => (release = resolve));
          return release;
        },
      };
    }

    it('跑著時 Cmd/Ctrl+Enter 送插話：這一輪不停，排著的畫在對話尾端，被領走時同一格換成人的話', async () => {
      seq = 0;
      const { fake, client, modes } = steeringClient([
        frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
      ]);
      render(<App client={client} />);
      await waitFor(() => expect(screen.getByRole('status').textContent).toContain('執行中'));
      expect(screen.getByTestId('send-hint').textContent).toMatch(
        /^Enter 排隊・(⌘|Ctrl\+)Enter 插話$/,
      );
      const input = screen.getByLabelText('要說的話');

      fireEvent.change(input, { target: { value: '改用 X' } });
      fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
      await waitFor(() => expect(modes).toEqual(['steer']));
      expect((input as HTMLTextAreaElement).value).toBe('');

      const pending = await screen.findByText('改用 X');
      expect(pending.closest('[data-pending-steer]')).not.toBeNull();
      expect(screen.getByText(PENDING_STEER_TEXT)).toBeTruthy();
      // 不進送出佇列：它不等這一輪收掉。
      expect(screen.queryByTestId('queue-dock')).toBeNull();
      const slot = pending.closest('[data-slot="message-scroller-item"]');
      expect(slot).not.toBeNull();
      // 這一格是看著它出現的：進場一次。
      expect(slot!.classList.contains('motion-rise-in')).toBe(true);

      fake.downlink.claimSteers(fake.opened[0]!);
      await waitFor(() => expect(screen.queryByText(PENDING_STEER_TEXT)).toBeNull());
      const claimed = screen.getByText('改用 X');
      expect(screen.getAllByText('改用 X')).toHaveLength(1);
      expect(claimed.closest('[data-pending-steer]')).toBeNull();
      // 同一格換內容：不跳位、不重播進場（class 沒被拿掉再加回去）。
      expect(claimed.closest('[data-slot="message-scroller-item"]')).toBe(slot);
      expect(slot!.classList.contains('motion-rise-in')).toBe(true);
      expect(screen.getByRole('status').textContent).toContain('執行中');

      // 只按 Enter 照舊排隊。
      fireEvent.change(input, { target: { value: '下一句' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(modes).toEqual(['steer', undefined]));
      const dock = await screen.findByTestId('queue-dock');
      expect(within(dock).getByText('下一句')).toBeTruthy();
    });

    it('這一輪停了、插話還沒被領走：泡泡留著，底下改說下一輪才送進模型', async () => {
      seq = 0;
      const { fake, client } = steeringClient([
        frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
      ]);
      render(<App client={client} />);
      await waitFor(() => expect(screen.getByRole('status').textContent).toContain('執行中'));
      const input = screen.getByLabelText('要說的話');
      fireEvent.change(input, { target: { value: '改用 X' } });
      fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
      await screen.findByText(PENDING_STEER_TEXT);

      fake.downlink.push(fake.opened[0]!, [fake.downlink.lifecycleFrame('completed')]);
      await waitFor(() => expect(screen.queryByText(PENDING_STEER_TEXT)).toBeNull());
      expect(screen.getByText(PARKED_STEER_TEXT)).toBeTruthy();
      expect(screen.getByText('改用 X').closest('[data-pending-steer]')).not.toBeNull();
    });

    /** 跑著、排著兩句（Enter 排隊），等佇列停靠列出現。 */
    async function runningWithQueue(lines: readonly string[]) {
      seq = 0;
      const made = steeringClient([
        frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
      ]);
      render(<App client={made.client} />);
      await waitFor(() => expect(screen.getByRole('status').textContent).toContain('執行中'));
      const input = screen.getByLabelText('要說的話');
      for (const line of lines) {
        fireEvent.change(input, { target: { value: line } });
        fireEvent.keyDown(input, { key: 'Enter' });
        await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(''));
      }
      // 新進來的一件要撐過 200ms 才畫（`QUEUE_SETTLE_MS`）：兩件以上等表頭寫到全部，全套件負載重時第二件會晚到。
      const dock = await screen.findByTestId('queue-dock');
      if (lines.length > 1) {
        await waitFor(() => expect(dock.textContent).toContain(`${lines.length} 則排著的訊息`));
      }
      return { ...made, input };
    }

    it('佇列列上的插話鈕：那一則離開佇列，改畫在對話尾端，這一輪不停（第二步）', async () => {
      const { fake } = await runningWithQueue(['先讀設定']);
      const dock = await screen.findByTestId('queue-dock');
      fireEvent.click(within(dock).getByRole('button', { name: '插話：先讀設定' }));
      const pending = await screen.findByText(PENDING_STEER_TEXT);
      expect(pending.closest('[data-pending-steer]')?.textContent).toContain('先讀設定');
      await waitFor(() => expect(screen.queryByTestId('queue-dock')).toBeNull());
      expect(screen.getByRole('status').textContent).toContain('執行中');

      fake.downlink.claimSteers(fake.opened[0]!);
      await waitFor(() => expect(screen.queryByText(PENDING_STEER_TEXT)).toBeNull());
      expect(screen.getAllByText('先讀設定')).toHaveLength(1);
    });

    it('草稿空白時 Cmd/Ctrl+Enter 把排著的全部改成插話，照排的先後', async () => {
      const { input } = await runningWithQueue(['第一句', '第二句']);
      expect((input as HTMLTextAreaElement).placeholder).toBe(
        'Cmd/Ctrl+Enter 把排著的全部改成插話',
      );
      fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
      await waitFor(() => expect(screen.queryByTestId('queue-dock')).toBeNull());
      const bubbles = [...document.querySelectorAll('[data-pending-steer]')].map((e) =>
        e.textContent?.replace(PENDING_STEER_TEXT, ''),
      );
      expect(bubbles).toEqual(['第一句', '第二句']);
      expect((input as HTMLTextAreaElement).placeholder).toBe('說點什麼…');
    });

    it('窄螢幕（640 以下）提示字不講快捷鍵，手勢照樣生效', async () => {
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: /\(min-width:\s*(\d+)px\)/.test(query)
          ? 375 >= Number(/(\d+)px/.exec(query)![1])
          : false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }));
      try {
        const { input } = await runningWithQueue(['第一句', '第二句']);
        // 手機沒有實體鍵盤：跟底列「⌘Enter 插話」在 640 以下不畫是同一個決定（#710 第一步）。
        expect((input as HTMLTextAreaElement).placeholder).toBe('說點什麼…');
        // 有實體鍵盤的窄視窗照樣能用手勢，只是不提示。
        fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
        await waitFor(() => expect(screen.queryByTestId('queue-dock')).toBeNull());
        expect(document.querySelectorAll('[data-pending-steer]')).toHaveLength(2);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('上一趟「全部改成插話」還沒送完，再按一次不重複送', async () => {
      const { input, updates, holdUpdates } = await runningWithQueue(['第一句', '第二句']);
      const release = holdUpdates();
      fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
      fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
      await waitFor(() => expect(updates).toHaveLength(1));
      release();
      await waitFor(() => expect(updates).toHaveLength(2));
      await waitFor(() => expect(screen.queryByTestId('queue-dock')).toBeNull());
      // 第二件之後不再有第二趟：兩件各一次。
      expect(updates.map((u) => u.split(':')[1])).toEqual(['steer', 'steer']);
      expect(new Set(updates).size).toBe(2);
    });

    it('草稿有字時 Cmd/Ctrl+Enter 是送出插話，排著的不動', async () => {
      const { input, modes } = await runningWithQueue(['第一句']);
      fireEvent.change(input, { target: { value: '改用 X' } });
      fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
      await waitFor(() => expect(modes).toEqual([undefined, 'steer']));
      expect(within(screen.getByTestId('queue-dock')).getByText('第一句')).toBeTruthy();
    });

    it('這一輪不收插話了：靜靜停，排著的照舊，說一句', async () => {
      const { fake, input } = await runningWithQueue(['第一句', '第二句']);
      fake.downlink.closeSteer(fake.opened[0]!);
      fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
      // sonner 的 toast 是全域的、跨測試留著：斷言這一條才有的那句。
      expect(await screen.findByText('這一輪已經不收插話了，那一則照舊排著')).toBeTruthy();
      // 兩件以上預設收合：表頭還寫著兩則。
      expect(screen.getByTestId('queue-dock').textContent).toContain('2 則排著的訊息');
      expect(document.querySelector('[data-pending-steer]')).toBeNull();
    });

    it('這一輪停了：鈕按不下去，空白 Cmd/Ctrl+Enter 什麼都不做，提示字照舊', async () => {
      const { fake, input } = await runningWithQueue(['第一句']);
      fake.downlink.push(fake.opened[0]!, [fake.downlink.lifecycleFrame('completed')]);
      await waitFor(() => expect(screen.getByRole('status').textContent).not.toContain('執行中'));
      const button = within(screen.getByTestId('queue-dock')).getByRole('button', {
        name: '插話：第一句',
      }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect((input as HTMLTextAreaElement).placeholder).toBe('說點什麼…');
      fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
      await Promise.resolve();
      expect(document.querySelector('[data-pending-steer]')).toBeNull();
      expect(screen.getByTestId('queue-dock')).toBeTruthy();
    });

    it('送出鈕同 Enter：跑著時也是排隊', async () => {
      seq = 0;
      const { client, modes } = steeringClient([
        frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
      ]);
      render(<App client={client} />);
      await waitFor(() => expect(screen.getByRole('status').textContent).toContain('執行中'));
      fireEvent.change(screen.getByLabelText('要說的話'), { target: { value: '下一句' } });
      fireEvent.click(screen.getByRole('button', { name: '送出' }));
      await waitFor(() => expect(modes).toEqual([undefined]));
    });

    it('沒在跑時 Cmd/Ctrl+Enter 照舊送出、不帶插話；提示照舊', async () => {
      const { client, modes } = steeringClient([]);
      render(<App client={client} />);
      await waitFor(() => expect(screen.getByPlaceholderText('說點什麼…')).toBeTruthy());
      expect(screen.getByTestId('send-hint').textContent).toBe('Enter 送出');
      fireEvent.change(screen.getByLabelText('要說的話'), { target: { value: '你好' } });
      fireEvent.keyDown(screen.getByLabelText('要說的話'), { key: 'Enter', metaKey: true });
      await waitFor(() => expect(modes).toEqual([undefined]));
    });
  });

  it('連不上就說連不上，不是一片空白', async () => {
    const client: WireClient = {
      ...UNWIRED_FILE_REFERENCES,
      ...SILENT_THREAD_FEED,
      ...UNWIRED_THREAD_SEARCH,
      ...UNWIRED_SESSION_REFERENCES,
      ...UNWIRED_SUBAGENT,
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

describe('斜線命令回應讓位給伺服器自己排的輪（#947）', () => {
  const goalCommand: SlashDescriptor = {
    name: 'goal',
    description: '設目標。',
    input: { hint: '[目標]' },
  };
  const goalReply = '目標建好了　狀態：進行中';

  beforeEach(stubCmdkLayout);

  async function typeGoal() {
    await waitFor(() => expect(screen.getByPlaceholderText('說點什麼…')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('要說的話'), { target: { value: '/goal 做完' } });
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
  }

  it('回應畫出來之後伺服器開了一輪：跑著時講執行中，收尾後講就緒，命令回應不再冒出來', async () => {
    seq = 0;
    const { client, downlink, opened } = fakeClient([], {
      commands: [goalCommand],
      run: () => ({ kind: 'success', command_id: 'cmd-1', text: goalReply }),
    });
    render(<App client={client} />);
    await typeGoal();
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain(goalReply));

    downlink.push(opened[0]!, [downlink.lifecycleFrame('running')]);
    await waitFor(() => expect(screen.getByRole('status').textContent).not.toContain(goalReply));
    downlink.push(opened[0]!, [downlink.lifecycleFrame('completed')]);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('就緒'));
  });

  it('那一輪被中止：收尾後講已停止，不是命令回應', async () => {
    seq = 0;
    const { client, downlink, opened } = fakeClient([], {
      commands: [goalCommand],
      run: () => ({ kind: 'success', command_id: 'cmd-1', text: goalReply }),
    });
    render(<App client={client} />);
    await typeGoal();
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain(goalReply));

    downlink.push(opened[0]!, [downlink.lifecycleFrame('running')]);
    await waitFor(() => expect(screen.getByRole('status').textContent).not.toContain(goalReply));
    downlink.push(opened[0]!, [
      downlink.pushedFrame('lifecycle', 'lifecycle', {
        event: 'failed',
        graph_name: 'root',
        error: '這一輪被中止了',
        aborted: true,
      }),
    ]);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('已停止'));
    expect(screen.getByRole('status').textContent).not.toContain(goalReply);
  });

  it('命令的回應比那一輪晚到：已經有輪開跑過了，就不畫那句，收尾後講就緒', async () => {
    seq = 0;
    const { client, downlink, opened } = fakeClient([], {
      commands: [goalCommand],
      run: () => ({ kind: 'success', command_id: 'cmd-1', text: goalReply }),
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slashRun = client.slashRun;
    client.slashRun = async (...args) => {
      await gate;
      return slashRun(...args);
    };
    render(<App client={client} />);
    await typeGoal();

    downlink.push(opened[0]!, [downlink.lifecycleFrame('running')]);
    await waitFor(() => expect(screen.getByRole('status').textContent).not.toContain('就緒'));
    release();
    downlink.push(opened[0]!, [downlink.lifecycleFrame('completed')]);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('就緒'));
    expect(screen.queryByText(goalReply)).toBeNull();
  });
});

describe('計劃模式標籤（#900）', () => {
  const planCommand: SlashDescriptor = {
    name: 'plan',
    description: '進出計劃模式。',
    input: { hint: '[off]' },
  };

  beforeEach(stubCmdkLayout);

  const planFrame = (downlink: ReturnType<typeof fakeClient>['downlink'], active: boolean): Event =>
    downlink.customFrame(PLAN_MODE, { active });

  const chip = () => screen.queryByRole('button', { name: '退出計劃模式' });

  it('`planMode` 為 null、{active:false} 不畫，{active:true} 才畫', async () => {
    seq = 0;
    const { client, downlink, opened } = fakeClient([], { commands: [planCommand] });
    render(<App client={client} />);
    await waitFor(() => expect(screen.getByPlaceholderText('說點什麼…')).toBeTruthy());
    expect(chip()).toBeNull();

    downlink.push(opened[0]!, [planFrame(downlink, false)]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(chip()).toBeNull();

    downlink.push(opened[0]!, [planFrame(downlink, true)]);
    await waitFor(() => expect(chip()).toBeTruthy());
    expect(chip()!.hasAttribute('disabled')).toBe(false);
  });

  it('按標籤送一次 `/plan off`，成功了也不自己拿掉，等線上的值翻回關著；送出期間再按不送', async () => {
    seq = 0;
    const { client, downlink, opened, slashed } = fakeClient([], {
      commands: [planCommand],
      run: () => ({ kind: 'success', command_id: 'cmd-1', text: '計劃模式關了。' }),
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slashRun = client.slashRun;
    client.slashRun = async (...args) => {
      await gate;
      return slashRun(...args);
    };
    render(<App client={client} />);
    await waitFor(() => expect(screen.getByPlaceholderText('說點什麼…')).toBeTruthy());
    downlink.push(opened[0]!, [planFrame(downlink, true)]);
    await waitFor(() => expect(chip()).toBeTruthy());

    fireEvent.click(chip()!);
    await waitFor(() => expect(chip()!.hasAttribute('disabled')).toBe(true));
    fireEvent.click(chip()!);
    release();
    await waitFor(() => expect(slashed).toEqual(['/plan off']));
    // 命令回來了、線上的值還沒翻：標籤還在，能再按。
    await waitFor(() => expect(chip()!.hasAttribute('disabled')).toBe(false));
    expect(slashed).toEqual(['/plan off']);

    downlink.push(opened[0]!, [planFrame(downlink, false)]);
    await waitFor(() => expect(chip()).toBeNull());
  });

  it('被拒、不認得、命令回錯誤：標籤留著，旁邊說出原因，不佔狀態列', async () => {
    seq = 0;
    const outcomes: SlashRunOutcome[] = [
      { kind: 'rejected', message: '這條 thread 正在跑：等這一輪跑完再打斜線命令' },
      { kind: 'unknown' },
      { kind: 'error', command_id: 'cmd-2', text: '本來就不在計劃模式。' },
    ];
    let at = 0;
    const { client, downlink, opened } = fakeClient([], {
      commands: [planCommand],
      run: () => outcomes[at++]!,
    });
    render(<App client={client} />);
    await waitFor(() => expect(screen.getByPlaceholderText('說點什麼…')).toBeTruthy());
    downlink.push(opened[0]!, [planFrame(downlink, true)]);
    await waitFor(() => expect(chip()).toBeTruthy());

    for (const expected of ['正在跑', '不認得這個命令：/plan off', '本來就不在計劃模式']) {
      fireEvent.click(chip()!);
      await waitFor(() => expect(screen.getByTestId('plan-chip').textContent).toContain(expected));
      expect(chip()).toBeTruthy();
      // 失敗講在標籤旁邊，狀態列沒有被借走。
      expect(screen.getByRole('status').textContent).toBe('就緒');
    }
  });

  it('一輪跑著時標籤照畫但停用，提示說跑完才能關；收尾後恢復', async () => {
    seq = 0;
    const { client, downlink, opened } = fakeClient([], { commands: [planCommand] });
    render(<App client={client} />);
    await waitFor(() => expect(screen.getByPlaceholderText('說點什麼…')).toBeTruthy());
    downlink.push(opened[0]!, [planFrame(downlink, true), downlink.lifecycleFrame('running')]);
    await waitFor(() => expect(chip()!.hasAttribute('disabled')).toBe(true));
    expect(chip()!.getAttribute('title')).toBe('這一輪跑完才能關');

    downlink.push(opened[0]!, [downlink.lifecycleFrame('completed')]);
    await waitFor(() => expect(chip()!.hasAttribute('disabled')).toBe(false));
  });
});

describe('目標列（#945）', () => {
  beforeEach(stubCmdkLayout);

  const wireGoal = (patch: Partial<WireGoal> = {}): WireGoal => ({
    id: 'g1',
    revision: 1,
    objective: '把登入改好',
    phase: 'active',
    maxGoalRounds: 256,
    roundsStarted: 0,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  });
  const goalFrame = (
    downlink: ReturnType<typeof fakeClient>['downlink'],
    goal: WireGoal | null,
  ): Event => downlink.customFrame(GOAL, { goal });
  const bar = () => screen.queryByTestId('goal-bar');

  async function mounted() {
    seq = 0;
    const fake = fakeClient([]);
    render(<App client={fake.client} />);
    await waitFor(() => expect(screen.getByPlaceholderText('說點什麼…')).toBeTruthy());
    return fake;
  }

  it('沒有目標與 complete 不畫；active、paused、blocked 畫，階段字不說進行中', async () => {
    const { downlink, opened } = await mounted();
    expect(bar()).toBeNull();

    downlink.push(opened[0]!, [goalFrame(downlink, wireGoal({ phase: 'complete' }))]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bar()).toBeNull();

    downlink.push(opened[0]!, [goalFrame(downlink, wireGoal())]);
    await waitFor(() => expect(bar()).toBeTruthy());
    expect(bar()!.textContent).toContain('目標：未完成');
    expect(bar()!.textContent).toContain('把登入改好');
    expect(bar()!.textContent).not.toMatch(/進行中|正在跑/);

    downlink.push(opened[0]!, [goalFrame(downlink, wireGoal({ phase: 'paused' }))]);
    await waitFor(() => expect(bar()!.textContent).toContain('目標：已暫停'));
  });

  it('blocked 的理由直接顯示在列上；從有目標變成沒有（清掉）時整列消失', async () => {
    const { downlink, opened } = await mounted();
    downlink.push(opened[0]!, [
      goalFrame(
        downlink,
        wireGoal({ phase: 'blocked', blockedReason: { code: 'x', message: '連續兩輪沒有進展' } }),
      ),
    ]);
    await waitFor(() =>
      expect(screen.getByTestId('goal-blocked-reason').textContent).toBe('連續兩輪沒有進展'),
    );

    downlink.push(opened[0]!, [goalFrame(downlink, null)]);
    await waitFor(() => expect(bar()).toBeNull());
  });

  it('輪數：開始過才畫「第 N／M 輪」；長目標單行截短而全文在 title 與無障礙名稱', async () => {
    const { downlink, opened } = await mounted();
    const long = '把登入流程整個重寫一遍，包含錯誤處理、重試與測試。'.repeat(6);
    downlink.push(opened[0]!, [goalFrame(downlink, wireGoal({ objective: long }))]);
    await waitFor(() => expect(bar()).toBeTruthy());
    expect(screen.queryByTestId('goal-rounds')).toBeNull();
    const objective = screen.getByTitle(long);
    expect(objective.className).toContain('truncate');
    expect(bar()!.getAttribute('aria-label')).toContain(long);

    downlink.push(opened[0]!, [
      goalFrame(downlink, wireGoal({ objective: long, roundsStarted: 3, maxGoalRounds: 10 })),
    ]);
    await waitFor(() => expect(screen.getByTestId('goal-rounds').textContent).toBe('第 3／10 輪'));
  });

  it('跟計劃標籤同時出現：兩個都在，標籤排在目標列前面', async () => {
    const { downlink, opened } = await mounted();
    downlink.push(opened[0]!, [
      goalFrame(downlink, wireGoal()),
      downlink.customFrame(PLAN_MODE, { active: true }),
    ]);
    await waitFor(() => expect(bar()).toBeTruthy());
    const chip = await screen.findByTestId('plan-chip');
    expect(chip.compareDocumentPosition(bar()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

/** pump 收回時卡上的那一句（紅字是給模型看的英文）；碼才是 web 比的東西。 */
const WITHDRAWN_TEXT = 'Error: tool call aborted before dispatch';

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
      message: WITHDRAWN_TEXT,
      code: ABORTED_BEFORE_DISPATCH_CODE,
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
    expect(within(card).queryByText(WITHDRAWN_TEXT)).toBeNull();
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
   * serve 還開著，重新整理之後接回一條那一輪還沒收尾的 thread。停在核准點的話，伺服器從
   * [#728](https://github.com/DemianLi/nexus-agent/issues/728) 起會在下行接上時補送那一顆，面板回來、送出框跟著鎖
   * （見下一組）。這一條的假 client 什麼都不補、歷史也是空的，送出框就沒鎖——驗的是那一輪沒收尾時送出去的話：
   * #637 之前伺服器把它擋回來；現在照收、排著等那一輪收尾（#645），所以它出現在送出佇列裡，刪得掉。
   */
  it('接回一條還沒收尾的 thread：送出去的話排進佇列，看得到也刪得掉', async () => {
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

  describe('停在核准或提問時重新整理，面板回得來（#728）', () => {
    /** 歷史那一頁的 frame：**一律不帶號**（`historyPath` 的規則），伺服器從日誌導出來的就長這樣。 */
    function historyFrame(method: string, namespace: readonly string[], data: unknown): Event {
      return {
        type: 'event',
        event_id: `h:${method}`,
        method,
        params: { namespace, timestamp: 0, data },
      } as Event;
    }

    /** 歷史裡的那張工具卡：日誌只記得它開跑了，中斷的酬載不在日誌上。 */
    const HISTORY = [
      historyFrame('tools', ['tools:a'], {
        event: 'tool-started',
        tool_call_id: 'call_alpha',
        tool_name: 'alpha',
        input: '{"n":"alpha"}',
      }),
    ];

    /**
     * 重新整理後的那一頁：先開下行，伺服器在第一顆即時 frame 之前補送還掛著的中斷（`replayed`）；歷史是 {@link HISTORY}。
     * **補送的那顆帶原本的號**，而且比 0 大很多——網頁從空重折，歷史不帶號，所以收得下它。
     */
    function reloaded(replayed: readonly Event[]) {
      remember('停著的那條');
      const fake = fakeClient(replayed);
      const client: WireClient = {
        ...fake.client,
        threadHistory: async () => ({
          kind: 'ok',
          result: { events: HISTORY, firstSeq: 0, throughSeq: 0, hasMore: false, legacy: false },
        }),
      };
      render(<App client={client} />);
      return fake;
    }

    it('前提：歷史自己折不出面板——卡在，面板不在，送出框沒鎖', async () => {
      // 沒有這一條，哪天歷史自己補得出面板，下面兩條照樣綠而補送沒被量到。
      reloaded([]);
      await waitFor(() => expect(screen.getByTestId('tool-entry').textContent).toContain('alpha'));
      await waitFor(() => expect(screen.getByRole('status').textContent).toContain('就緒'));
      expect(screen.queryByRole('region', { name: /等待核准/ })).toBeNull();
      expect(screen.queryByTestId('approval-card')).toBeNull();
      fireEvent.change(screen.getByLabelText('要說的話'), { target: { value: '換條路' } });
      expect(screen.getByRole('button', { name: '送出' }).hasAttribute('disabled')).toBe(false);
    });

    it('核准：補送的那顆畫回面板、送出框鎖住，答得出去，之後的即時 frame 照樣折得進去', async () => {
      seq = 57;
      const fake = reloaded([
        approvalFrame([{ name: 'alpha', allowed: ['approve', 'reject'] }], 'int-7'),
      ]);

      const panel = await screen.findByRole('region', { name: '等待核准：alpha' });
      expect(screen.getByRole('status').textContent).toBe('等待核准：alpha');
      fireEvent.change(screen.getByLabelText('要說的話'), { target: { value: '換條路' } });
      expect(
        screen.getByRole('button', { name: '送出', hidden: true }).hasAttribute('disabled'),
      ).toBe(true);

      fireEvent.click(within(panel).getByRole('button', { name: '全部核准' }));
      await waitFor(() => expect(fake.responded).toHaveLength(1));
      expect(fake.responded[0]).toEqual({
        namespace: ['tools:a'],
        interrupt_id: 'int-7',
        response: { decisions: [{ type: 'approve' }] },
      });

      // 號比補送那顆大的即時 frame 沒被當成重複：resume 那一輪開跑、收尾，畫面回到就緒。
      fake.downlink.push(fake.opened[0]!, [
        fake.downlink.lifecycleFrame('running'),
        fake.downlink.lifecycleFrame('completed'),
      ]);
      await waitFor(() => expect(screen.getByRole('status').textContent).toContain('就緒'));
      await waitFor(() => expect(screen.queryByRole('region', { name: /等待核准/ })).toBeNull());
    });

    /**
     * 補送的一次計劃審核（#652 起 `exit_plan_mode` 這樣問）。同意的標籤故意不是 harness 的「同意」：網頁要照
     * `intent.approve` 回答，不能寫死字面。
     */
    function planReviewFrame(interruptId: string): Event {
      return frame('input.requested', ['tools:a'], {
        interrupt_id: interruptId,
        payload: {
          kind: 'question',
          questions: [
            {
              id: 'plan-review',
              header: '計劃審核',
              question: '同意這份計劃並離開計劃模式？',
              detail: '# 改登入頁\n\n- 改成中文\n- 補測試',
              options: [{ label: '核可' }, { label: '繼續規劃' }],
              intent: { kind: 'plan-review', approve: '核可', callId: 'call_alpha' },
            },
          ],
        },
      });
    }

    it('計劃卡：重新整理後走歷史照樣在，結果讀自工具卡（同意、要求修改；舊路由的拒絕也認得）', async () => {
      seq = 0;
      remember('審過計劃的那條');
      const plan = (callId: string, title: string, finished: Record<string, unknown>) => [
        historyFrame('tools', ['tools:a'], {
          event: 'tool-started',
          tool_call_id: callId,
          tool_name: 'exit_plan_mode',
          input: JSON.stringify({ plan: `# ${title}\n\n照這樣做。` }),
        }),
        historyFrame('tools', ['tools:a'], {
          event: 'tool-finished',
          tool_call_id: callId,
          ...finished,
        }),
      ];
      const events = [
        ...plan('call_1', '第一版', {
          failed: true,
          message: '使用者關掉了計劃審核，要自己說話。留在計劃模式，停在這裡，等使用者的訊息。',
        }),
        ...plan('call_2', '舊路由', {
          failed: true,
          message: '有人看過並拒絕了 "exit_plan_mode"。',
        }),
        ...plan('call_3', '第二版', {
          message: '計劃已獲准，離開計劃模式；從你的下一步起照計劃執行。',
        }),
      ].map((event, index) => ({ ...event, event_id: `h:${index}` }) as Event);
      const fake = fakeClient([]);
      render(
        <App
          client={{
            ...fake.client,
            threadHistory: async () => ({
              kind: 'ok',
              result: { events, firstSeq: 0, throughSeq: 0, hasMore: false, legacy: false },
            }),
          }}
        />,
      );

      await waitFor(() => expect(screen.getAllByTestId('plan-card')).toHaveLength(3));
      expect(
        screen
          .getAllByTestId('plan-card')
          .map((card) => [
            within(card).getByTestId('plan-title').textContent,
            within(card).getByTestId('plan-outcome').textContent,
          ]),
      ).toEqual([
        ['第一版', '要求修改'],
        ['舊路由', '要求修改'],
        ['第二版', '已同意'],
      ]);
      // 從計劃卡打開全文：分頁的名稱是計劃標題。
      fireEvent.click(
        within(screen.getAllByTestId('plan-card')[2]!).getByRole('button', {
          name: '查看全文：第二版',
        }),
      );
      await waitFor(() =>
        expect(screen.getByRole('tab', { name: '第二版' }).getAttribute('aria-selected')).toBe(
          'true',
        ),
      );
    });

    it('計劃審核：補送的那一題畫回審核面板，「同意執行」答的是同意那個標籤', async () => {
      seq = 91;
      const fake = reloaded([planReviewFrame('plan-1')]);

      // 名稱是「計劃待審」，只有兩顆鈕，沒有 ❌、不能收起（#654 二-Q2、Q5）。
      const panel = await screen.findByRole('region', { name: '計劃待審' });
      expect(within(panel).getByTestId('plan-title').textContent).toBe('改登入頁');
      expect(within(panel).getByTestId('plan-summary').textContent).toBe('改成中文');
      expect(within(panel).queryByRole('button', { name: STOP_QUESTIONS_LABEL })).toBeNull();
      expect(within(panel).queryByRole('button', { name: /收起/ })).toBeNull();
      expect(
        within(panel)
          .getAllByRole('button')
          .map((button) => button.textContent),
      ).toEqual(['查看全文', '要求修改', '同意執行']);

      // 寬螢幕：全文自動停靠在右側欄。這一份的工具卡不在歷史裡（歷史只有 alpha），全文來自那一題的 detail。
      // 分頁比面板晚一拍才畫出來，要等。
      expect(
        (await screen.findByRole('tab', { name: '改登入頁' })).getAttribute('aria-selected'),
      ).toBe('true');
      expect(
        within(screen.getByTestId('plan-preview')).getByRole('heading', { name: '改登入頁' }),
      ).toBeTruthy();

      fireEvent.click(within(panel).getByRole('button', { name: '同意執行' }));
      await waitFor(() => expect(fake.responded).toHaveLength(1));
      expect(fake.responded[0]).toEqual({
        namespace: ['tools:a'],
        interrupt_id: 'plan-1',
        response: { answers: [{ id: 'plan-review', selected: ['核可'] }] },
      });
    });

    it('計劃審核：「要求修改」關掉這一題、不停這一輪，焦點回到輸入框', async () => {
      seq = 91;
      const fake = reloaded([planReviewFrame('plan-2')]);

      const panel = await screen.findByRole('region', { name: '計劃待審' });
      within(panel).getByRole('button', { name: '要求修改' }).focus();
      fireEvent.click(within(panel).getByRole('button', { name: '要求修改' }));
      await waitFor(() => expect(fake.responded).toHaveLength(1));
      expect(fake.responded[0]).toEqual({
        namespace: ['tools:a'],
        interrupt_id: 'plan-2',
        response: { cancelled: true },
      });
      // 沒有送停止：這一輪由模型接著收（它收到的是「停在這裡等使用者的訊息」）。
      expect(fake.cancels).toHaveLength(0);
      await waitFor(() => expect(screen.queryByRole('region', { name: '計劃待審' })).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('要說的話')));
    });
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
      expect(within(running).getByTestId('thread-status').textContent).toBe('執行中');
      expect(within(list).getAllByTestId('thread-status')).toHaveLength(1);
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

    it('按內容搜（#760）：問的是伺服器，內容才對得上的那一列帶著片段接在後面', async () => {
      seq = 0;
      const fake = fakeClient([]);
      const asked: string[] = [];
      render(
        <App
          client={{
            ...listing(fake, async () => ({ kind: 'ok', result: recent() })),
            searchThreads: async (query) => {
              asked.push(query);
              return {
                kind: 'ok',
                result: {
                  items: [{ threadId: 't2', snippet: '…規格裡講登入的那一段…' }],
                  hasMore: false,
                },
              };
            },
          }}
        />,
      );
      const list = await openList();
      await waitFor(() => expect(within(list).getAllByRole('button')).toHaveLength(3));
      fireEvent.change(within(list).getByRole('searchbox', { name: '搜尋以前的會話' }), {
        target: { value: '登入' },
      });
      await waitFor(() => expect(rowNames(list)).toHaveLength(3));
      expect(asked).toEqual(['登入']);
      const hit = within(list).getByRole('button', { name: /讀規格/ });
      expect(within(hit).getByTestId('thread-snippet').textContent).toBe('…規格裡講登入的那一段…');
    });

    it('過 axe', async () => {
      await rendered();
      expect(await axeViolations(document.body)).toEqual([]);
    });
  });
});

/**
 * 側欄每一列的即時狀態（[#632](https://github.com/DemianLi/nexus-agent/issues/632)）。規則逐條驗在
 * `lib/thread-status.test.ts`；這裡驗接上畫面之後：全域下行推來的東西畫到哪一列、重接時的順序、晚到的列表不蓋新的。
 * `main.tsx` 開著 StrictMode，所以每條都在兩種模式各跑一次：dev 模式先掛上、卸載、再掛上，**活著的線只能有一條**。
 */
describe.each([false, true])('側欄的即時狀態（StrictMode：%s）', (strict) => {
  beforeEach(() => configure({ reactStrictMode: strict }));
  afterEach(() => configure({ reactStrictMode: false }));

  const row = (threadId: string, title: string, running: boolean) => ({
    threadId,
    updatedAt: Date.now(),
    running,
    blank: false,
    title,
  });

  const PLAN_REVIEW = {
    id: 'plan-review',
    question: '同意這份計劃嗎？',
    detail: '# 改登入頁',
    options: [{ label: '同意' }, { label: '繼續規劃' }],
    intent: { kind: 'plan-review', approve: '同意' },
  };

  /** 每次 `openThreadFeed` 開一條新的線；測試推 frame 或讓它斷。斷掉的、卸載時被 abort 的都不算活著。 */
  function scriptedFeed() {
    const lines: {
      readonly push: (...frames: ThreadFeedFrame[]) => void;
      readonly fail: () => void;
      readonly dead: () => boolean;
    }[] = [];
    const openThreadFeed: WireClient['openThreadFeed'] = async (signal) => {
      const queue: ThreadFeedFrame[] = [];
      let wake: (() => void) | undefined;
      let error: Error | undefined;
      signal?.addEventListener('abort', () => {
        error = new Error('aborted');
        wake?.();
      });
      lines.push({
        push: (...frames) => {
          queue.push(...frames);
          wake?.();
        },
        fail: () => {
          error = new Error('network error');
          wake?.();
        },
        dead: () => error !== undefined,
      });
      return (async function* stream() {
        for (;;) {
          while (queue.length > 0) yield queue.shift()!;
          if (error !== undefined) throw error;
          await new Promise<void>((resolve) => (wake = resolve));
        }
      })();
    };
    const live = () => lines.filter((line) => !line.dead());
    return {
      openThreadFeed,
      opened: () => lines.length,
      /** 唯一活著的那一條。StrictMode 下先開的那一條要已經被收掉。 */
      line: () => {
        expect(live()).toHaveLength(1);
        return live()[0]!;
      },
    };
  }

  function rendered(listThreads: WireClient['listThreads']) {
    seq = 0;
    const fake = fakeClient([]);
    const feed = scriptedFeed();
    render(<App client={{ ...fake.client, listThreads, openThreadFeed: feed.openThreadFeed }} />);
    return feed;
  }

  const ok = (...items: ReturnType<typeof row>[]): ThreadListOutcome => ({
    kind: 'ok',
    result: { unreadable: 0, items },
  });

  async function rowOf(title: string): Promise<HTMLElement> {
    const list = await screen.findByRole('group', { name: '以前的會話' });
    return within(list).findByRole('button', { name: new RegExp(title) });
  }

  const statusOf = (element: HTMLElement) =>
    within(element).queryByTestId('thread-status')?.getAttribute('data-status') ?? null;

  it('沒打開的那條停在核准：那一列標出來、時間換成「待核准」；撤回就回到在跑', async () => {
    const feed = rendered(async () => ok(row('a', '改登入頁', true)));
    const target = await rowOf('改登入頁');
    await waitFor(() => expect(statusOf(target)).toBe('running'));

    feed.line().push({
      type: 'input-requested',
      threadId: 'a',
      event: approvalFrame([{ name: 'alpha', allowed: ['approve', 'reject'] }], 'int-1'),
    });
    await waitFor(() => expect(statusOf(target)).toBe('approval'));
    expect(within(target).getByTestId('thread-status').textContent).toBe('等待核准');
    expect(target.textContent).toContain('待核准');
    expect(target.textContent).not.toMatch(/\d{1,2}:\d{2}/);

    feed.line().push({ type: 'input-withdrawn', threadId: 'a', interruptId: 'int-1' });
    await waitFor(() => expect(statusOf(target)).toBe('running'));
  });

  it('同一條同時掛核准與計劃審核，畫計劃審核', async () => {
    const feed = rendered(async () => ok(row('a', '改登入頁', true)));
    const target = await rowOf('改登入頁');
    feed.line().push(
      {
        type: 'input-requested',
        threadId: 'a',
        event: approvalFrame([{ name: 'alpha', allowed: ['approve'] }], 'int-1'),
      },
      {
        type: 'input-requested',
        threadId: 'a',
        event: frame('input.requested', ['tools:b'], {
          interrupt_id: 'int-2',
          payload: { kind: 'question', questions: [PLAN_REVIEW] },
        }),
      },
    );
    await waitFor(() => expect(statusOf(target)).toBe('plan-review'));
    expect(target.textContent).toContain('計劃待審');
  });

  it('別條跑完標「已完成」，點進去就清掉；目前這條停下不標', async () => {
    let items = [row('b', '寫測試', true)];
    const feed = rendered(async () => ok(...items));
    const target = await rowOf('寫測試');
    await waitFor(() => expect(statusOf(target)).toBe('running'));

    items = [row('b', '寫測試', false)];
    feed.line().push({ type: 'status', threadId: 'b', running: false });
    await waitFor(() => expect(statusOf(target)).toBe('completed'));
    expect(within(target).getByTestId('thread-status').textContent).toBe('已完成');

    fireEvent.click(target);
    const current = await rowOf('寫測試');
    await waitFor(() => expect(current.textContent).toContain('目前這條'));
    expect(statusOf(current)).toBeNull();

    feed.line().push({ type: 'status', threadId: 'b', running: true });
    await waitFor(() => expect(statusOf(current)).toBe('running'));
    feed.line().push({ type: 'status', threadId: 'b', running: false });
    await waitFor(() => expect(statusOf(current)).toBeNull());
  });

  it('換會話不重開全域下行：別條的「已完成」換過去之後還在', async () => {
    let items = [row('b', '寫測試', false), row('c', '跑腿', true)];
    const feed = rendered(async () => ok(...items));
    const errand = await rowOf('跑腿');
    await waitFor(() => expect(statusOf(errand)).toBe('running'));
    items = [row('b', '寫測試', false), row('c', '跑腿', false)];
    feed.line().push({ type: 'status', threadId: 'c', running: false });
    await waitFor(() => expect(statusOf(errand)).toBe('completed'));
    // **換之前記**：線掛在會跟著對話畫面重掛的地方的話，換的那一下就重開了。
    const opened = feed.opened();

    fireEvent.click(await rowOf('寫測試'));
    await waitFor(async () => expect((await rowOf('寫測試')).textContent).toContain('目前這條'));
    expect(statusOf(await rowOf('跑腿'))).toBe('completed');
    expect(feed.opened()).toBe(opened);
  });

  it('斷線重接：重抓一次列表、舊的標記清掉、補送回來的才畫', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    let reads = 0;
    const feed = rendered(async () => {
      reads += 1;
      return ok(row('a', '改登入頁', true), row('b', '寫測試', true));
    });
    const first = await rowOf('改登入頁');
    const second = await rowOf('寫測試');
    feed.line().push({
      type: 'input-requested',
      threadId: 'a',
      event: approvalFrame([{ name: 'alpha', allowed: ['approve'] }], 'int-a'),
    });
    await waitFor(() => expect(statusOf(first)).toBe('approval'));
    const opened = feed.opened();
    const before = reads;

    feed.line().fail();
    // 第 1 次重試等 250ms（亂數固定在 0）。
    await waitFor(() => expect(feed.opened()).toBe(opened + 1), { timeout: 2_000 });
    await waitFor(() => expect(reads).toBe(before + 1));
    // 斷線期間 a 那一題答掉了：接上時伺服器只補送 b 的。
    await waitFor(() => expect(statusOf(first)).toBe('running'));
    feed.line().push({
      type: 'input-requested',
      threadId: 'b',
      event: approvalFrame([{ name: 'beta', allowed: ['approve'] }], 'int-b'),
    });
    await waitFor(() => expect(statusOf(second)).toBe('approval'));
    expect(statusOf(first)).toBe('running');
    vi.restoreAllMocks();
  });

  it('早送出、晚回來的那份列表不蓋掉晚送出的', async () => {
    const pending: ((outcome: ThreadListOutcome) => void)[] = [];
    rendered(
      () =>
        new Promise<ThreadListOutcome>((resolve) => {
          pending.push(resolve);
        }),
    );
    // 掛上時一次、全域下行接上時一次（StrictMode 下更多）。
    await waitFor(() => expect(pending.length).toBeGreaterThanOrEqual(2));
    pending.at(-1)!(ok(row('a', '改登入頁', true)));
    const target = await rowOf('改登入頁');
    await waitFor(() => expect(statusOf(target)).toBe('running'));
    for (const resolve of pending.slice(0, -1)) resolve(ok(row('a', '改登入頁', false)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(statusOf(target)).toBe('running');
  });
});

/**
 * `@` 引用（[#653](https://github.com/DemianLi/nexus-agent/issues/653)）接上畫面：列檔綁在目前這條 thread 上，
 * 新對話第一句送出之前就能用。選單本身驗在 `components/composer.test.tsx`。
 */
describe('@ 引用', () => {
  beforeEach(stubCmdkLayout);

  it('新對話還沒講話就能打 @：查的是目前這條、選了之後原樣送出', async () => {
    seq = 0;
    const fake = fakeClient([]);
    const asked: { threadId: string; query: string }[] = [];
    const client: WireClient = {
      ...fake.client,
      fileReferences: async (threadId, query) => {
        asked.push({ threadId, query });
        return {
          kind: 'ok',
          result: { available: true, candidates: [{ path: '/src/alpha.ts', kind: 'file' }] },
        };
      },
    };
    render(<App client={client} />);
    const box = await screen.findByLabelText<HTMLTextAreaElement>('要說的話');
    await waitFor(() => expect(fake.opened).toHaveLength(1));
    fireEvent.change(box, { target: { value: '看 @alp' } });
    await screen.findByRole('dialog', { name: '@ 選單' });
    expect(asked).toEqual([{ threadId: fake.opened[0], query: 'alp' }]);

    fireEvent.keyDown(box, { key: 'Enter' });
    expect(box.value).toBe('看 @/src/alpha.ts ');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '@ 選單' })).toBeNull());
    fireEvent.keyDown(box, { key: 'Enter' });
    // 送出時照舊修掉頭尾空白；`@path` 本身原樣送（#653 Q1：協定就是純文字）。
    await waitFor(() => expect(fake.sent.at(-1)).toBe('看 @/src/alpha.ts'));
  });
});

/**
 * `@` 引用別的會話（[#713](https://github.com/DemianLi/nexus-agent/issues/713)）。規則逐條驗在 `lib/session-mention.test.ts`、
 * `lib/mention-menu.test.ts` 與 `components/composer.test.tsx`；這裡驗整條路：選單挑到草稿、原文送出、被領走之後
 * 泡泡畫成一小塊（同專案的會話點得開）、重新整理後還在、被拒絕時說出原因。
 */
describe('@ 引用別的會話', () => {
  beforeEach(stubCmdkLayout);

  const candidate = (
    sessionId: string,
    label: string,
    extra: Partial<SessionReferenceCandidate> = {},
  ): SessionReferenceCandidate => ({
    sessionId,
    label,
    sameWorkspace: true,
    createdAt: 1,
    updatedAt: 2,
    mention: formatSessionReferenceMention({ sessionId, label }),
    ...extra,
  });
  const mine = candidate('thread-mine', '昨天那條');
  const other = candidate('thread-other', '報表', { sameWorkspace: false, cwd: '/w/reports' });
  const sub = candidate('thread-sub', '查資料', {
    parentSessionId: 'thread-mine',
    parentLabel: '昨天那條',
  });

  /** 清單上只有 `thread-mine`（同專案的主會話）：別的專案與子代理不在上面，所以點不開。 */
  function mentionClient(fake: ReturnType<typeof fakeClient>) {
    const asked: { threadId: string; query: string }[] = [];
    const client: WireClient = {
      ...fake.client,
      sessionReferences: async (threadId, query) => {
        asked.push({ threadId, query });
        return {
          kind: 'ok',
          result: {
            available: true,
            candidates: [mine, other, sub].filter((item) => item.label.includes(query)),
          },
        };
      },
      listThreads: async () => ({
        kind: 'ok',
        result: {
          unreadable: 0,
          items: [
            {
              threadId: 'thread-mine',
              updatedAt: 1,
              running: false,
              blank: false,
              title: '昨天那條',
            },
          ],
        },
      }),
    };
    return { client, asked };
  }

  const chips = () => [...document.querySelectorAll<HTMLElement>('[data-session-reference]')];

  it('打 @ 挑會話：查的是目前這條；選了之後草稿是完整的引用文字，原文送出', async () => {
    seq = 0;
    const fake = fakeClient([]);
    const { client, asked } = mentionClient(fake);
    render(<App client={client} />);
    const box = await screen.findByLabelText<HTMLTextAreaElement>('要說的話');
    await waitFor(() => expect(fake.opened).toHaveLength(1));
    fireEvent.change(box, { target: { value: '照 @昨' } });
    await screen.findByRole('dialog', { name: '@ 選單' });
    expect(asked).toEqual([{ threadId: fake.opened[0], query: '昨' }]);
    expect(screen.getByRole('option', { name: /昨天那條/u })).toBeTruthy();

    fireEvent.keyDown(box, { key: 'Enter' });
    expect(box.value).toBe(`照 ${mine.mention} `);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '@ 選單' })).toBeNull());
    fireEvent.change(box, { target: { value: `${box.value}的方案改` } });
    fireEvent.keyDown(box, { key: 'Enter' });
    // 送出的是原文，伺服器在準備那一步才把它換成 `@標題`。
    await waitFor(() => expect(fake.sent.at(-1)).toBe(`照 ${mine.mention} 的方案改`));
  });

  it('被領走之後畫成一小塊：同專案的會話點了切過去，別的專案與子代理只顯示', async () => {
    seq = 0;
    const fake = fakeClient([]);
    const { client } = mentionClient(fake);
    render(<App client={client} />);
    const box = await screen.findByLabelText<HTMLTextAreaElement>('要說的話');
    await waitFor(() => expect(fake.opened).toHaveLength(1));
    // 清單讀回來了，才知道哪一條切得過去。
    await waitFor(() => expect(screen.queryByText('昨天那條')).not.toBeNull());
    fireEvent.change(box, {
      target: { value: `對照 ${mine.mention} 和 ${other.mention} 和 ${sub.mention}` },
    });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(chips()).toHaveLength(3));

    const [first, second, third] = chips();
    expect(first!.textContent).toBe('@昨天那條');
    expect(first!.tagName).toBe('BUTTON');
    expect(second!.textContent).toBe('@報表');
    expect(second!.tagName).toBe('SPAN');
    expect(third!.textContent).toBe('@查資料');
    expect(third!.tagName).toBe('SPAN');
    // 整句話還是那一句：換成 `@標題`，看不到網址。
    expect(first!.closest('[data-slot="message-scroller-item"]')!.textContent).toBe(
      '對照 @昨天那條 和 @報表 和 @查資料',
    );

    fireEvent.click(second!);
    expect(fake.opened).toHaveLength(1);
    fireEvent.click(first!);
    await waitFor(() => expect(fake.opened.at(-1)).toBe('thread-mine'));
  });

  it('重新整理（歷史回來的人話帶 references）也畫成一小塊', async () => {
    seq = 0;
    const fake = fakeClient([
      frame('messages', [], {
        event: 'message-start',
        role: 'human',
        run_id: 'h1',
        references: [{ sessionId: 'thread-mine', label: '昨天那條' }],
      }),
      frame('messages', [], {
        event: 'content-block-delta',
        index: 0,
        delta: { type: 'text-delta', text: '照 @昨天那條 的方案改' },
        run_id: 'h1',
      }),
      frame('messages', [], { event: 'message-finish', reason: 'stop', run_id: 'h1' }),
      frame('lifecycle', [], { event: 'completed', graph_name: 'root' }),
    ]);
    const { client } = mentionClient(fake);
    render(<App client={client} />);
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(chips()[0]!.textContent).toBe('@昨天那條');
    expect(chips()[0]!.closest('[data-slot="message-scroller-item"]')!.textContent).toBe(
      '照 @昨天那條 的方案改',
    );
  });

  it('沒有 references 的人話裡的 @ 字面不會被當成引用', async () => {
    seq = 0;
    const fake = fakeClient([
      frame('messages', [], { event: 'message-start', role: 'human', run_id: 'h1' }),
      frame('messages', [], {
        event: 'content-block-delta',
        index: 0,
        delta: { type: 'text-delta', text: '寫信給 @昨天那條' },
        run_id: 'h1',
      }),
      frame('messages', [], { event: 'message-finish', reason: 'stop', run_id: 'h1' }),
    ]);
    const { client } = mentionClient(fake);
    render(<App client={client} />);
    await screen.findByText('寫信給 @昨天那條');
    expect(chips()).toHaveLength(0);
  });

  it('跑著時排隊：停靠列與待送的插話顯示 @標題，編輯框拿原文', async () => {
    seq = 0;
    const fake = fakeClient([frame('lifecycle', [], { event: 'running', graph_name: 'root' })]);
    const { client } = mentionClient(fake);
    const running: WireClient = {
      ...client,
      runStart: async (threadId, text, options) => ({
        type: 'success',
        id: 1,
        result: {
          run_id:
            options?.mode === 'steer'
              ? fake.downlink.acceptSteer(threadId, text)
              : fake.downlink.accept(threadId, text, false),
        },
      }),
    };
    render(<App client={running} />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('執行中'));
    const box = screen.getByLabelText<HTMLTextAreaElement>('要說的話');

    fireEvent.change(box, { target: { value: `排一句 ${mine.mention}` } });
    fireEvent.keyDown(box, { key: 'Enter' });
    const dock = await screen.findByTestId('queue-dock');
    expect(dock.textContent).toContain('排一句 @昨天那條');
    expect(dock.textContent).not.toContain('nexus-session');
    expect(within(dock).getByRole('button', { name: '編輯：排一句 @昨天那條' })).toBeTruthy();
    fireEvent.click(within(dock).getByRole('button', { name: '編輯：排一句 @昨天那條' }));
    expect(within(dock).getByRole<HTMLTextAreaElement>('textbox').value).toBe(
      `排一句 ${mine.mention}`,
    );
    fireEvent.keyDown(within(dock).getByRole('textbox'), { key: 'Escape' });

    fireEvent.change(box, { target: { value: `插一句 ${other.mention}` } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    const pending = await screen.findByText('插一句 @報表');
    expect(pending.closest('[data-pending-steer]')).not.toBeNull();
    expect(document.body.textContent).not.toContain('nexus-session');
  });

  it('伺服器拒絕（引用太多）：說出原因，草稿放回去', async () => {
    seq = 0;
    const fake = fakeClient([frame('lifecycle', [], { event: 'completed', graph_name: 'root' })]);
    const { client } = mentionClient(fake);
    const refused: WireClient = {
      ...client,
      runStart: async () => ({
        type: 'error',
        id: 1,
        error: 'invalid_argument',
        message: 'SESSION_REFERENCE_TOO_MANY: 一句話最多引用 3 條會話',
      }),
    };
    render(<App client={refused} />);
    const box = await screen.findByLabelText<HTMLTextAreaElement>('要說的話');
    const text = `看 ${mine.mention} ${other.mention}`;
    fireEvent.change(box, { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    expect(await screen.findByText(/SESSION_REFERENCE_TOO_MANY/u)).toBeTruthy();
    await waitFor(() => expect(box.value).toBe(text));
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
    // 這一輪在跑，提示換成兩種送法（#710）；要驗的是用量表的位置。
    expect(meter.previousElementSibling?.textContent).toMatch(/^Enter 排隊・(⌘|Ctrl\+)Enter 插話$/);
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

  // 從空字串起算：預期寫「nexus-agent」的斷言才不會因為上一條留下的值而白白成立。
  beforeEach(() => {
    document.title = '';
  });

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
    await waitFor(() => expect(document.title).toBe('nexus-agent'));
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
    // 分頁標題在 effect 裡設，比標頭晚一拍。
    await waitFor(() => expect(document.title).toBe('幫我修登入 — nexus-agent'));
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
    await waitFor(() => expect(document.title).toBe('修好登入頁的錯誤 — nexus-agent'));
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
    await waitFor(() => expect(document.title).toBe('舊的那條 — nexus-agent'));
  });

  it('有輪次但沒有標題（目標排的）：跟列表講同一句', async () => {
    seq = 0;
    const { client } = fakeClient([
      ...textFrames('root-1', ['model_request:a'], '目標排的一輪。'),
      frame('lifecycle', [], { event: 'completed', graph_name: 'root' }),
    ]);
    render(<App client={client} />);
    await waitFor(() => expect(heading().textContent).toBe(UNTITLED_THREAD_LABEL));
    await waitFor(() => expect(document.title).toBe('nexus-agent'));
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

/** 子代理歷史的 frame：不帶 seq，同 server 那側。 */
const historyFrame = (method: string, data: unknown): Event =>
  ({ type: 'event', method, params: { namespace: [], timestamp: 0, data } }) as Event;
const historySaid = (role: 'human' | 'ai', id: string, text: string): Event[] => [
  historyFrame('messages', { event: 'message-start', role, id }),
  historyFrame('messages', {
    event: 'content-block-delta',
    index: 0,
    delta: { type: 'text-delta', text },
    id,
  }),
  historyFrame('messages', { event: 'message-finish', reason: 'stop', id }),
];

describe('背景子代理的輸入框接線（#869）', () => {
  const statusFrame = (items: readonly { runId: string; status: 'running' | 'idle' }[]) =>
    frame('custom', [], { name: SUBAGENT_STATUS, payload: { items } });

  /** 委派卡先派出、收尾時帶背景子代理的鑰匙（`meta`），再來一份狀態快照。 */
  const delegated = (items: readonly { runId: string; status: 'running' | 'idle' }[]) => [
    frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
    frame('tools', [], {
      event: 'tool-started',
      tool_call_id: 'call_bg',
      tool_name: 'subagent',
      input: '{"subagent_type":"researcher","description":"查三個檔案"}',
    }),
    frame('tools', [], {
      event: 'tool-finished',
      tool_call_id: 'call_bg',
      message: '子代理已在背景啟動',
      meta: { kind: 'background-subagent', runId: 'bg-1', subagentType: 'researcher' },
    }),
    frame('lifecycle', [], { event: 'completed', graph_name: 'root' }),
    statusFrame(items),
  ];

  it('狀態字跟著快照走；送出把 thread 與編號帶給 subagentSend，停止走 subagentInterrupt', async () => {
    seq = 0;
    const fake = fakeClient(delegated([{ runId: 'bg-1', status: 'running' }]));
    const send = vi.fn(async (): Promise<UplinkResult> => ({ type: 'success', id: 1, result: {} }));
    const interrupt = vi.fn(async (): Promise<UplinkResult> => ({
      type: 'success',
      id: 2,
      result: {},
    }));
    render(<App client={{ ...fake.client, subagentSend: send, subagentInterrupt: interrupt }} />);

    const card = await screen.findByTestId('tool-entry');
    await waitFor(() => expect(within(card).getByText('跑著')).toBeTruthy());
    fireEvent.click(within(card).getAllByRole('button')[0]!);

    fireEvent.change(screen.getByLabelText('對背景子代理說話'), { target: { value: '先看 A' } });
    fireEvent.click(screen.getByRole('button', { name: '送出給背景子代理' }));
    await waitFor(() => expect(document.querySelector('[data-subagent-echo]')).not.toBeNull());
    expect(send).toHaveBeenCalledExactlyOnceWith(fake.opened[0], 'bg-1', '先看 A');

    fireEvent.click(screen.getByRole('button', { name: '停止這一輪' }));
    expect(interrupt).toHaveBeenCalledExactlyOnceWith(fake.opened[0], 'bg-1');

    // 下一份快照整份取代：翻成閒著，狀態字與輸入框跟著換；停止鈕恢復成不可按。
    fake.downlink.push(fake.opened[0]!, [statusFrame([{ runId: 'bg-1', status: 'idle' }])]);
    await waitFor(() => expect(within(card).getByText('閒著')).toBeTruthy());
    expect((screen.getByLabelText('對背景子代理說話') as HTMLInputElement).placeholder).toContain(
      '喚醒',
    );
    expect((screen.getByRole('button', { name: '停止這一輪' }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    // 空快照＝收線。
    fake.downlink.push(fake.opened[0]!, [statusFrame([])]);
    await waitFor(() => expect(within(card).getByText('已收線')).toBeTruthy());
    expect((screen.getByLabelText('對背景子代理說話') as HTMLInputElement).disabled).toBe(true);
  });

  it('用量鈕的「看明細」打開成本分頁：主對話讀總帳、背景子代理各讀自己那份（#1032），不經委派卡的展開', async () => {
    seq = 0;
    const fake = fakeClient([
      ...delegated([{ runId: 'bg-1', status: 'idle' }]),
      frame('custom', [], {
        name: TOKEN_USAGE,
        payload: { inputTokens: 5_000, outputTokens: 500 },
      }),
      frame('custom', [], {
        name: SESSION_STATS,
        payload: { turns: 1, steps: 2, llmMs: 4_000, toolMs: 500 },
      }),
    ]);
    // 子代理那份日誌的總帳：跟 root 的數字分得開。
    const subagentHistory = vi.fn(async () => ({
      kind: 'ok' as const,
      result: {
        events: [
          historyFrame('custom', {
            name: TOKEN_USAGE,
            payload: { inputTokens: 21, outputTokens: 9 },
          }),
          historyFrame('custom', {
            name: SESSION_STATS,
            payload: { turns: 1, steps: 3, llmMs: 1_200, toolMs: 300 },
          }),
        ],
        firstSeq: 0,
        throughSeq: 0,
        hasMore: false,
        legacy: false,
      },
    }));
    render(<App client={{ ...fake.client, subagentHistory }} />);

    fireEvent.click(await screen.findByTestId('session-usage'));
    fireEvent.click(await screen.findByTestId('session-usage-detail'));
    const panel = await screen.findByTestId('right-sidebar-panel-cost');
    expect(within(panel).getByTestId('cost-totals').textContent).toContain('5,500 token');
    const row = await within(panel).findByTestId('cost-subagent');
    await waitFor(() => expect(row.textContent).toContain('30 token'));
    expect(row.getAttribute('data-run-id')).toBe('bg-1');
    expect(row.textContent).toContain('researcher');
    expect(subagentHistory).toHaveBeenCalledExactlyOnceWith(fake.opened[0], 'bg-1', {
      maxMessages: 1,
    });
    // root 的累計沒有把子代理加進去。
    expect(within(panel).getByTestId('cost-totals').textContent).not.toContain('5,530');
  });

  it('展開時讀子代理自己的對話並用主對話同一套畫法畫出來（#861）', async () => {
    seq = 0;
    const fake = fakeClient(delegated([{ runId: 'bg-1', status: 'idle' }]));
    const subagentHistory = vi.fn(async () => ({
      kind: 'ok' as const,
      result: {
        events: [
          historyFrame('lifecycle', { event: 'running', graph_name: 'root' }),
          ...historySaid(
            'human',
            'h1',
            '查三個檔案\n\nYour parent agent id is "root". 收尾前回報。',
          ),
          ...historySaid('ai', 'a1', '三個檔案都看過了'),
          historyFrame('lifecycle', { event: 'completed', graph_name: 'root' }),
        ],
        firstSeq: 0,
        throughSeq: 5,
        hasMore: false,
        legacy: false,
      },
    }));
    render(<App client={{ ...fake.client, subagentHistory }} />);

    const card = await screen.findByTestId('tool-entry');
    await waitFor(() => expect(within(card).getByText('閒著')).toBeTruthy());
    expect(subagentHistory).not.toHaveBeenCalled();
    fireEvent.click(within(card).getAllByRole('button')[0]!);

    const section = await screen.findByLabelText('背景子代理的對話');
    await waitFor(() => expect(within(section).getByText('三個檔案都看過了')).toBeTruthy());
    expect(within(section).getByText('查三個檔案')).toBeTruthy();
    expect(within(section).getByText('派出的任務')).toBeTruthy();
    expect(section.textContent).not.toContain('Your parent agent id');
    expect(subagentHistory).toHaveBeenCalledExactlyOnceWith(fake.opened[0], 'bg-1', {
      maxMessages: 40,
    });
  });
});
