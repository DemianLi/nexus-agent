import type {
  Event,
  ModelCatalogResult,
  ModelSelectResult,
  ModelSelection,
  PermissionCatalogResult,
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
  MODEL_DOES_NOT_SUPPORT_IMAGES,
  MODEL_USAGE,
  PLAN_MODE,
  PROJECTION,
  SESSION_STATS,
  SUBAGENT_STATUS,
  TITLE,
  TODOS,
  TOKEN_USAGE,
} from '@nexus/wire';
import {
  act,
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
import {
  BLANK_THREAD_LABEL,
  CLEAR_SEARCH_LABEL,
  UNTITLED_THREAD_LABEL,
} from '@/components/sidebar/thread-list';
import { ABORTED_BEFORE_DISPATCH_CODE, STOPPED_QUESTION_TEXT } from '@/lib/question-view';
import { REMEMBERED_THREAD_KEY } from '@/lib/remembered-thread';
import { PARKED_STEER_TEXT, PENDING_STEER_TEXT } from '@/lib/steer-view';
import { axeViolations } from '@/test/axe';
import { stubCmdkLayout } from '@/test/cmdk';
import { fakeDownlink } from '@/test/downlink';
import { UNWIRED_WIRE_CONTRACT } from '@/test/wire-contract';

/**
 * 一份活在記憶體裡的 `Storage`。
 *
 * **不用環境給的那一份**：Node 25 自己帶一個全域 `localStorage`，沒給 `--localstorage-file`
 * 時上面連 `getItem` 都沒有，而它蓋住了 jsdom 的那一份（實測 `getItem is not a function`）。
 * App 在那種環境照樣開得起來——那正是「讀寫失敗只是記不住」那條約定——但測試要的是一份真的
 * 記得住的。
 */
/** 側欄清單裡的會話列。搜尋框有字時的 ×（#1307）也是按鈕，不是列。 */
function threadRows(list: HTMLElement): HTMLElement[] {
  return within(list)
    .queryAllByRole('button')
    .filter((button) => button.getAttribute('aria-label') !== CLEAR_SEARCH_LABEL);
}

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

// 附件功能的開關今天寫死 false（#733）：整條送出路徑的測試把它打開，其餘照舊。
const attachmentGate = vi.hoisted(() => ({ on: false }));
vi.mock('@/lib/attachments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/attachments')>()),
  serverSupportsAttachments: () => attachmentGate.on,
}));

// App 會把 thread id 記進 `localStorage`；每條一份新的，不然下一條測試就成了「接回上一次」。
beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  attachmentGate.on = false;
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
  /** 收過的請求編號（thread＋編號）→ 那一件的 `run_id`。 */
  const requested = new Map<string, string>();
  const downlink = fakeDownlink();
  const client: WireClient = {
    ...UNWIRED_WIRE_CONTRACT,
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
    // 認得收過的請求編號（#1335，照 harness 的 `findPromptRequest`）：只比編號，回原本那一件的 `run_id`，不再排。
    runStart: async (threadId, text, options) => {
      const key =
        options?.requestId === undefined ? undefined : `${threadId}\n${options.requestId}`;
      const seen = key === undefined ? undefined : requested.get(key);
      if (seen !== undefined) return { type: 'success', id: 1, result: { run_id: seen } };
      sent.push(text);
      const runId = downlink.accept(threadId, text);
      if (key !== undefined) requested.set(key, runId);
      return { type: 'success', id: 1, result: { run_id: runId } };
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
  return frame('input.requested', [], {
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

    it('佇列裡有目標續行的預約（#638）：整批插話只動人排的，預約留著、沒有插話鈕、不跳「不收插話」', async () => {
      const { fake, input } = await runningWithQueue(['第一句']);
      fake.downlink.acceptGoal(fake.opened[0]!, 'Continue working toward the goal.');
      const dock = screen.getByTestId('queue-dock');
      await waitFor(() => expect(dock.textContent).toContain('2 則排著的訊息'));
      fireEvent.click(within(dock).getByRole('button', { name: '2 則排著的訊息' }));
      expect(await within(dock).findByTestId('queue-goal-label')).toBeTruthy();
      expect(within(dock).queryByRole('button', { name: /^插話：目標續行/u })).toBeNull();
      expect((input as HTMLTextAreaElement).placeholder).toBe(
        'Cmd/Ctrl+Enter 把排著的全部改成插話',
      );
      fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
      await waitFor(() =>
        expect(document.querySelectorAll('[data-pending-steer]')).toHaveLength(1),
      );
      expect(document.querySelector('[data-pending-steer]')?.textContent).toContain('第一句');
      // 預約還在隊裡，沒被插話帶走，也沒有「不收插話」的提示。
      await waitFor(() => expect(screen.getByTestId('queue-goal-label')).toBeTruthy());
      expect(screen.queryByText('這一輪已經不收插話了，那一則照舊排著')).toBeNull();
      // 只剩預約：沒有可插的件，空白 Cmd/Ctrl+Enter 的提示收回。
      expect((input as HTMLTextAreaElement).placeholder).toBe('說點什麼…');
    });

    it('佇列裡有不認得來源的件（#1247）：整份 inbox 不丟，通用標籤、沒有插話鈕，整批插話只動人排的', async () => {
      const { fake, input } = await runningWithQueue(['第一句']);
      fake.downlink.acceptUnknownSource(fake.opened[0]!, 'future instruction', 'future-kind');
      const dock = screen.getByTestId('queue-dock');
      await waitFor(() => expect(dock.textContent).toContain('2 則排著的訊息'));
      fireEvent.click(within(dock).getByRole('button', { name: '2 則排著的訊息' }));
      expect(await within(dock).findByTestId('queue-generic-label')).toBeTruthy();
      expect(within(dock).getByText('第一句')).toBeTruthy();
      expect(dock.textContent).not.toContain('future instruction');
      expect(within(dock).queryByRole('button', { name: /^插話：系統排入/u })).toBeNull();
      fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
      await waitFor(() =>
        expect(document.querySelectorAll('[data-pending-steer]')).toHaveLength(1),
      );
      expect(document.querySelector('[data-pending-steer]')?.textContent).toContain('第一句');
      await waitFor(() => expect(screen.getByTestId('queue-generic-label')).toBeTruthy());
      expect(screen.queryByText('這一輪已經不收插話了，那一則照舊排著')).toBeNull();
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
      ...UNWIRED_WIRE_CONTRACT,
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
      namespace: [],
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
      namespace: [],
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

  it.each([
    ['連不上', new TypeError('連不上（#1335 toast）')],
    ['回條的 JSON 斷在半路', new SyntaxError('JSON 斷了（#1335 toast）')],
  ])('斷在網路層（%s）：不說沒送出去，說不確定、原樣重送不會重複（#1335）', async (_case, error) => {
    seq = 0;
    const fake = fakeClient([frame('lifecycle', [], { event: 'completed', graph_name: 'root' })]);
    const runStart = async (): Promise<UplinkResult> => {
      throw error;
    };
    render(<App client={{ ...fake.client, runStart }} />);

    await waitFor(() => expect(screen.getByPlaceholderText('說點什麼…')).toBeTruthy());
    const input = screen.getByLabelText('要說的話') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '一句話' } });
    fireEvent.click(screen.getByRole('button', { name: '送出' }));

    const card = await toastWith(`原樣再按一次送出，不會重複。（${error.message}）`);
    expect(card.getAttribute('data-type')).toBe('warning');
    expect(card.textContent).toContain('不確定這一句有沒有送到');
    expect(card.textContent).not.toContain('沒送出去');
    await waitFor(() => expect(input.value).toBe('一句話'));
  });

  it.each([
    [
      '伺服器回錯誤',
      async (): Promise<UplinkResult> => ({
        type: 'error',
        id: 1,
        error: 'invalid_argument',
        message: '明說不收（#1335 toast）',
      }),
      '明說不收（#1335 toast）',
    ],
    [
      '載體層擋下（狀態碼不是 2xx）',
      async (): Promise<UplinkResult> => {
        throw new Error('上行被載體層擋下：403 擋了（#1335 toast）');
      },
      '上行被載體層擋下：403 擋了（#1335 toast）',
    ],
  ])('伺服器明說不收（%s）：照舊說這一句沒送出去（#1335）', async (_case, runStart, message) => {
    seq = 0;
    const fake = fakeClient([frame('lifecycle', [], { event: 'completed', graph_name: 'root' })]);
    render(<App client={{ ...fake.client, runStart }} />);

    await waitFor(() => expect(screen.getByPlaceholderText('說點什麼…')).toBeTruthy());
    const input = screen.getByLabelText('要說的話') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '一句話' } });
    fireEvent.click(screen.getByRole('button', { name: '送出' }));

    const card = await toastWith(message);
    expect(card.getAttribute('data-type')).toBe('error');
    expect(card.textContent).toContain('這一句沒送出去');
    expect(card.textContent).not.toContain('不確定');
  });
});

/**
 * 說明是 `text` 的那一條 toast。sonner 的 toast 是全域的、跨測試留著，所以 `text` 要是這一條測試才有的字；同一句也可能畫在
 * 狀態列上，只取 toast 裡的那一個。
 */
async function toastWith(text: string): Promise<Element> {
  return waitFor(() => {
    const card = screen
      .getAllByText(text)
      .map((element) => element.closest('[data-sonner-toast]'))
      .find((found) => found !== null);
    if (card === undefined || card === null) throw new Error(`沒有說明是「${text}」的 toast`);
    return card;
  });
}

describe('重送同一句話（請求編號，#1335）', () => {
  /**
   * 回條斷在半路：伺服器其實收下了（推了 `inbox`、畫了人的泡泡），呼叫端卻拿到例外，畫面說「沒送出去」、草稿放回去。
   * `dropFirst` 讓前幾次 `run.start` 照常送到假伺服器、回應丟掉。
   */
  function setup(dropFirst = 1) {
    seq = 0;
    const fake = fakeClient([frame('lifecycle', [], { event: 'completed', graph_name: 'root' })]);
    let drops = dropFirst;
    const runStart = vi.fn(async (...args: Parameters<WireClient['runStart']>) => {
      const result = await fake.client.runStart(...args);
      if (drops > 0) {
        drops -= 1;
        // 瀏覽器的 fetch 斷在網路層丟的是 `TypeError`。
        throw new TypeError('Failed to fetch');
      }
      return result;
    });
    render(<App client={{ ...fake.client, runStart }} />);
    const requestIds = () =>
      runStart.mock.calls.map(([, , options]) => options?.requestId as string | undefined);
    return { fake, runStart, requestIds };
  }
  const input = () => screen.getByLabelText('要說的話') as HTMLTextAreaElement;
  const send = (text: string) => {
    fireEvent.change(input(), { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
  };

  it('回條斷掉後原樣重送：帶同一個編號，伺服器只排一次，畫面只有一則', async () => {
    const { fake, runStart, requestIds } = setup();
    await screen.findByPlaceholderText('說點什麼…');

    send('一句話');
    await waitFor(() => expect(input().value).toBe('一句話'));
    // 第一次其實到了：人的泡泡已經畫出來。輸入框裡放回去的那一句不算。
    await waitFor(() => expect(fake.sent).toEqual(['一句話']));
    const shown = () => screen.getAllByText('一句話', { ignore: 'script, style, textarea' }).length;
    expect(shown()).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(input().value).toBe(''));
    const [first, second] = requestIds();
    expect(first).toEqual(expect.any(String));
    expect(second).toBe(first);
    expect(fake.sent).toEqual(['一句話']);
    expect(shown()).toBe(1);
  });

  it('改了字再送是新的一句：換新編號（不然改過的字會被伺服器當成重送丟掉）', async () => {
    const { runStart, requestIds } = setup();
    await screen.findByPlaceholderText('說點什麼…');

    send('一句話');
    await waitFor(() => expect(input().value).toBe('一句話'));
    send('一句話，改過');
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(2));
    const [first, second] = requestIds();
    expect(second).not.toBe(first);
  });

  it('頭尾空白不算改：trim 之後一樣就沿用', async () => {
    const { runStart, requestIds } = setup();
    await screen.findByPlaceholderText('說點什麼…');

    send('一句話');
    await waitFor(() => expect(input().value).toBe('一句話'));
    send('  一句話\n');
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(2));
    const [first, second] = requestIds();
    expect(second).toBe(first);
  });

  it('收下之後再送同樣的字是新的一句：換新編號', async () => {
    const { fake, runStart, requestIds } = setup(0);
    await screen.findByPlaceholderText('說點什麼…');

    send('好');
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(input().value).toBe(''));
    send('好');
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(2));
    const [first, second] = requestIds();
    expect(second).not.toBe(first);
    await waitFor(() => expect(fake.sent).toEqual(['好', '好']));
  });

  it('重送收下之後，同樣的字再送一次是新的一句：不沿用重送用過的編號', async () => {
    const { fake, runStart, requestIds } = setup();
    await screen.findByPlaceholderText('說點什麼…');

    send('再一次');
    await waitFor(() => expect(input().value).toBe('再一次'));
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(input().value).toBe(''));

    send('再一次');
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(3));
    const [first, second, third] = requestIds();
    expect(second).toBe(first);
    expect(third).not.toBe(first);
    await waitFor(() => expect(fake.sent).toEqual(['再一次', '再一次']));
  });

  it('沒放回去（人已經在打下一句）時，下一句帶新編號', async () => {
    seq = 0;
    const fake = fakeClient([frame('lifecycle', [], { event: 'completed', graph_name: 'root' })]);
    let fail: (error: Error) => void = () => undefined;
    const runStart = vi.fn((...args: Parameters<WireClient['runStart']>): Promise<UplinkResult> =>
      runStart.mock.calls.length === 1
        ? new Promise((_resolve, reject) => {
            fail = reject;
          })
        : fake.client.runStart(...args),
    );
    render(<App client={{ ...fake.client, runStart }} />);
    await screen.findByPlaceholderText('說點什麼…');

    send('第一句');
    fireEvent.change(input(), { target: { value: '第二句' } });
    fail(new Error('fetch failed'));
    // sonner 的 toast 是全域的、跨測試留著：不斷言 toast，等呼叫端處理完（輸入框留著第二句）。
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(input().value).toBe('第二句');

    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(2));
    const [first, second] = runStart.mock.calls.map(([, , options]) => options?.requestId);
    expect(second).toEqual(expect.any(String));
    expect(second).not.toBe(first);
  });

  it('不同的兩句話各有各的編號', async () => {
    const { runStart, requestIds } = setup(0);
    await screen.findByPlaceholderText('說點什麼…');

    send('第一句');
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    send('第二句');
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(2));
    const [first, second] = requestIds();
    expect(first).toEqual(expect.any(String));
    expect(second).toEqual(expect.any(String));
    expect(second).not.toBe(first);
  });

  it('斜線命令不帶編號：走 slash.run，不碰 run.start', async () => {
    seq = 0;
    stubCmdkLayout();
    const fake = fakeClient([frame('lifecycle', [], { event: 'completed', graph_name: 'root' })], {
      commands: [{ name: 'compact', description: '壓縮' }],
    });
    const runStart = vi.fn(fake.client.runStart);
    render(<App client={{ ...fake.client, runStart }} />);
    await screen.findByPlaceholderText('說點什麼…');

    send('/compact');
    await waitFor(() => expect(fake.slashed).toEqual(['/compact']));
    expect(runStart).not.toHaveBeenCalled();
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

  describe('MCP 反問（#1098）', () => {
    function elicitationFrame(interruptId = 'q-mcp'): Event {
      return frame('input.requested', ['tools:a'], {
        interrupt_id: interruptId,
        payload: {
          kind: 'question',
          questions: [
            { id: 'ok', question: '確定刪除嗎？', options: [{ label: '是' }, { label: '否' }] },
          ],
          origin: {
            kind: 'mcp-elicitation',
            server: 'files',
            tool: 'delete_dir',
            arguments: { path: '/tmp/x' },
          },
        },
      });
    }
    const elicitationPanel = () => screen.findByRole('region', { name: '有 1 個問題要你回答' });

    it('面板說出是哪台 server、哪支工具、什麼參數；模型自己問的那種沒有這一塊', async () => {
      seq = 0;
      const { client } = fakeClient([elicitationFrame()]);
      render(<App client={client} />);
      const panel = await elicitationPanel();
      expect(within(panel).getByTestId('question-origin').textContent).toContain(
        'MCP 伺服器「files」的工具「delete_dir」在問你',
      );
      expect(within(panel).getByTestId('question-origin-arguments').textContent).toContain(
        '/tmp/x',
      );
    });

    it('拒絕送 {declined:true}、取消送 {cancelled:true}，面板收掉、這一輪不停（沒有 run.cancel）', async () => {
      seq = 0;
      const first = fakeClient([elicitationFrame('q-1')]);
      const view = render(<App client={first.client} />);
      let panel = await elicitationPanel();
      fireEvent.click(within(panel).getByRole('button', { name: '拒絕' }));
      await waitFor(() => expect(first.responded).toHaveLength(1));
      expect(first.responded[0]).toEqual({
        namespace: ['tools:a'],
        interrupt_id: 'q-1',
        response: { declined: true },
      });
      expect(first.cancels).toHaveLength(0);
      await waitFor(() =>
        expect(screen.queryByRole('region', { name: '有 1 個問題要你回答' })).toBeNull(),
      );
      view.unmount();
      cleanup();

      seq = 0;
      const second = fakeClient([elicitationFrame('q-2')]);
      render(<App client={second.client} />);
      panel = await elicitationPanel();
      fireEvent.click(within(panel).getByRole('button', { name: '取消' }));
      await waitFor(() => expect(second.responded).toHaveLength(1));
      expect(second.responded[0]).toEqual({
        namespace: ['tools:a'],
        interrupt_id: 'q-2',
        response: { cancelled: true },
      });
      expect(second.cancels).toHaveLength(0);
    });

    it('作答照舊送 {answers}；模型自己問的面板沒有拒絕與取消', async () => {
      seq = 0;
      const { client, responded } = fakeClient([elicitationFrame('q-3')]);
      render(<App client={client} />);
      const panel = await elicitationPanel();
      fireEvent.click(within(panel).getByRole('radio', { name: '是' }));
      fireEvent.click(within(panel).getByRole('button', { name: '送出答案' }));
      await waitFor(() => expect(responded).toHaveLength(1));
      expect((responded[0] as { response: { answers: unknown[] } }).response.answers).toHaveLength(
        1,
      );
      cleanup();

      seq = 0;
      const plain = fakeClient([questionFrame('q-4')]);
      render(<App client={plain.client} />);
      const plainPanel = await questionPanel();
      expect(within(plainPanel).queryByRole('button', { name: '拒絕' })).toBeNull();
      expect(within(plainPanel).queryByRole('button', { name: '取消' })).toBeNull();
    });
  });

  it('兩個前景子代理平行各自要核准（#328）：面板與狀態列講出是誰在問，各答各的，答對的那個 namespace', async () => {
    seq = 0;
    const delegate = (callId: string, namespace: string, type: string, description: string) =>
      frame('tools', [namespace], {
        event: 'tool-started',
        tool_call_id: callId,
        tool_name: 'task',
        input: JSON.stringify({ subagent_type: type, description }),
      });
    const ask = (id: string, namespace: string) =>
      frame('input.requested', [namespace], {
        interrupt_id: id,
        payload: {
          actionRequests: [{ name: 'write_file', args: { path: id } }],
          reviewConfigs: [{ actionName: 'write_file', allowedDecisions: ['approve', 'reject'] }],
        },
      });
    const { client, responded } = fakeClient([
      frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
      delegate('c1', 'tools:u1', 'explore', '整理 README'),
      delegate('c2', 'tools:u2', 'writer', '寫測試'),
      ask('int-1', 'tools:u1'),
      ask('int-2', 'tools:u2'),
    ]);
    render(<App client={client} />);

    const first = await screen.findByRole('region', {
      name: '等待核准：write_file（子代理「explore」要的）（1／2）',
    });
    expect(screen.getByRole('status').textContent).toBe(
      '等待核准：write_file（子代理「explore」要的）（1／2）',
    );
    expect(within(first).getByTestId('approval-asker').textContent).toBe(
      '子代理「explore」要執行這個操作，它在做：整理 README',
    );
    fireEvent.click(within(first).getByRole('button', { name: '全部核准' }));
    await waitFor(() => expect(responded).toHaveLength(1));
    expect(responded[0]).toMatchObject({ namespace: ['tools:u1'], interrupt_id: 'int-1' });

    // 第一顆答掉之後才輪到第二顆，講的是另一個子代理。
    const second = await screen.findByRole('region', {
      name: '等待核准：write_file（子代理「writer」要的）',
    });
    expect(within(second).getByTestId('approval-asker').textContent).toContain('子代理「writer」');
    fireEvent.click(within(second).getByRole('button', { name: '全部拒絕' }));
    await waitFor(() => expect(responded).toHaveLength(2));
    expect(responded[1]).toMatchObject({ namespace: ['tools:u2'], interrupt_id: 'int-2' });
  });

  it('重新整理後子代理的核准還掛著、委派卡接不回（#328）：只說「子代理」，不編名字，答得出去', async () => {
    seq = 0;
    // 即時那條線沒重播、歷史讀的是 root 的日誌：state.subagents 是空的，但 namespace 非空（root 自己問的是 []）。
    const { client, responded } = fakeClient([
      frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
      frame('input.requested', ['tools:gone'], {
        interrupt_id: 'int-9',
        payload: {
          actionRequests: [{ name: 'write_file', args: { path: 'x' } }],
          reviewConfigs: [{ actionName: 'write_file', allowedDecisions: ['approve', 'reject'] }],
        },
      }),
    ]);
    render(<App client={client} />);

    const panel = await screen.findByRole('region', { name: '等待核准：write_file（子代理要的）' });
    expect(within(panel).getByTestId('approval-asker').textContent).toBe('子代理要執行這個操作');
    fireEvent.click(within(panel).getByRole('button', { name: '全部核准' }));
    await waitFor(() => expect(responded).toHaveLength(1));
    expect(responded[0]).toMatchObject({ namespace: ['tools:gone'], interrupt_id: 'int-9' });
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
      namespace: [],
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
        namespace: [],
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

  describe('釘選、封存、改名（#633）', () => {
    /**
     * 有狀態的假 server：兩個集合與標題都在這裡，五支動作照 dsh 的規則改它、回整份集合，列表每次讀都帶最新的。
     * `rules` 讓個別測試改寫某一支的回應（例如別的分頁同時動了集合）。
     */
    function managed(
      initial: { pinned?: string[]; archived?: string[] } = {},
      rules: Partial<{
        pin: (id: string, state: { pinned: string[]; archived: string[] }) => string[];
      }> = {},
    ) {
      const state = {
        pinned: [...(initial.pinned ?? [])],
        archived: [...(initial.archived ?? [])],
        titles: new Map<string, string>(),
      };
      const calls: string[] = [];
      let lists = 0;
      const ok = <V,>(value: V) => ({ kind: 'ok' as const, result: { ok: true as const, value } });
      const failed = (code: string, message?: string, activity?: readonly string[]) => ({
        kind: 'ok' as const,
        result: {
          ok: false as const,
          error: {
            code,
            ...(message === undefined ? {} : { message }),
            ...(activity === undefined ? {} : { activity }),
          },
        },
      });
      const fake = fakeClient([]);
      const client = {
        ...listing(fake, async () => {
          lists += 1;
          return {
            kind: 'ok',
            result: {
              ...LISTED,
              items: LISTED.items.map((item) =>
                state.titles.has(item.threadId)
                  ? { ...item, title: state.titles.get(item.threadId)! }
                  : item,
              ),
              pinnedThreadIds: [...state.pinned],
              archivedThreadIds: [...state.archived],
            },
          };
        }),
        threadPin: async (id: string) => {
          calls.push(`pin ${id}`);
          if (state.archived.includes(id)) return failed('thread_archived');
          state.pinned = rules.pin?.(id, state) ?? [
            id,
            ...state.pinned.filter((other) => other !== id),
          ];
          return ok({ pinnedThreadIds: [...state.pinned] });
        },
        threadUnpin: async (id: string) => {
          calls.push(`unpin ${id}`);
          state.pinned = state.pinned.filter((other) => other !== id);
          return ok({ pinnedThreadIds: [...state.pinned] });
        },
        threadArchive: async (id: string, options?: { stopActivity?: boolean }) => {
          calls.push(`archive ${id}${options?.stopActivity === true ? ' stop' : ''}`);
          if (id === '跑著的那條' && options?.stopActivity !== true) {
            return failed('thread_active', undefined, ['turn']);
          }
          // dsh：封存的那一刻它就不在釘選裡。回應只帶封存集合。
          state.pinned = state.pinned.filter((other) => other !== id);
          if (!state.archived.includes(id)) state.archived.push(id);
          return ok({ archivedThreadIds: [...state.archived] });
        },
        threadUnarchive: async (id: string) => {
          calls.push(`unarchive ${id}`);
          state.archived = state.archived.filter((other) => other !== id);
          return ok({ archivedThreadIds: [...state.archived] });
        },
        threadRename: async (id: string, title: string) => {
          calls.push(`rename ${id} ${title}`);
          if (title.includes('壞')) return failed('title_invalid', '標題裡不能有「壞」。');
          state.titles.set(id, title);
          return ok({ title, seq: 9 });
        },
      } as unknown as WireClient;
      return { client, state, calls, sent: fake.sent, lists: () => lists };
    }

    const menuOf = async (list: HTMLElement, title: string) => {
      fireEvent.keyDown(await within(list).findByRole('button', { name: `「${title}」的選項` }), {
        key: 'Enter',
      });
    };
    const choose = (item: string) => fireEvent.click(screen.getByRole('menuitem', { name: item }));

    it('列表沒帶兩個集合（server 還沒實作）：每一列都沒有選項鈕，也沒有已釘選與已封存兩區', async () => {
      seq = 0;
      render(
        <App client={listing(fakeClient([]), async () => ({ kind: 'ok', result: LISTED }))} />,
      );
      const list = await openList();
      await waitFor(() => expect(within(list).getAllByRole('button')).toHaveLength(2));
      expect(within(list).queryByRole('button', { name: /的選項/u })).toBeNull();
      expect(screen.queryByTestId('thread-pinned')).toBeNull();
      expect(screen.queryByTestId('thread-archived')).toBeNull();
    });

    it.each([
      ['只帶釘選', { pinnedThreadIds: [] }],
      ['只帶封存', { archivedThreadIds: [] }],
    ])('缺一格就當沒有：%s', async (_case, sets) => {
      seq = 0;
      render(
        <App
          client={listing(fakeClient([]), async () => ({
            kind: 'ok',
            result: { ...LISTED, ...sets },
          }))}
        />,
      );
      const list = await openList();
      await waitFor(() => expect(within(list).getAllByRole('button')).toHaveLength(2));
      expect(within(list).queryByRole('button', { name: /的選項/u })).toBeNull();
    });

    it('列表讀失敗：什麼都不多畫', async () => {
      seq = 0;
      render(
        <App
          client={listing(fakeClient([]), async () => ({ kind: 'rejected', message: '讀不到' }))}
        />,
      );
      await openList();
      expect(screen.queryByRole('button', { name: /的選項/u })).toBeNull();
    });

    it('支援時走完整流程：釘選、取消釘選、封存、取消封存、改名，畫面跟著 server，換到別條之後還在', async () => {
      seq = 0;
      const server = managed();
      render(<App client={server.client} />);
      let list = await openList();

      await menuOf(list, UNTITLED_THREAD_LABEL);
      choose('釘選');
      const pinned = await screen.findByTestId('thread-pinned');
      expect(within(pinned).getByText(UNTITLED_THREAD_LABEL)).toBeTruthy();
      expect(server.state.pinned).toEqual(['目標那條']);

      // 換到別條：整個對話畫面重掛，列表重抓，釘選仍是 server 的那一份。
      fireEvent.click(within(list).getByRole('button', { name: /^幫我改登入頁/u }));
      await waitFor(() => expect(stored()).toBe('跑著的那條'));
      list = await openList();
      expect(
        within(await screen.findByTestId('thread-pinned')).getByText(UNTITLED_THREAD_LABEL),
      ).toBeTruthy();

      await menuOf(list, UNTITLED_THREAD_LABEL);
      choose('取消釘選');
      await waitFor(() => expect(screen.queryByTestId('thread-pinned')).toBeNull());
      expect(server.state.pinned).toEqual([]);

      await menuOf(list, UNTITLED_THREAD_LABEL);
      choose('封存');
      const archived = await screen.findByTestId('thread-archived');
      expect(within(archived).getByRole('button', { name: '已封存（1）' })).toBeTruthy();
      fireEvent.click(within(archived).getByRole('button', { name: '已封存（1）' }));
      await menuOf(list, UNTITLED_THREAD_LABEL);
      choose('取消封存');
      await waitFor(() => expect(screen.queryByTestId('thread-archived')).toBeNull());
      expect(server.state.archived).toEqual([]);

      await menuOf(list, '幫我改登入頁');
      choose('重新命名');
      const field = screen.getByRole('textbox', { name: '重新命名會話' });
      fireEvent.change(field, { target: { value: '  登入頁   重做 ' } });
      fireEvent.keyDown(field, { key: 'Enter' });
      expect(await within(list).findByText('登入頁 重做')).toBeTruthy();
      // 送出的是正規化後的標題；之後重抓列表，標題來自列表（server）。
      expect(server.calls).toContain('rename 跑著的那條 登入頁 重做');
      await waitFor(() => expect(server.lists()).toBeGreaterThan(2));
      expect(within(list).getByText('登入頁 重做')).toBeTruthy();
    });

    it('一開始 server 就帶了釘選與封存：列表照畫（已釘選在最上、封存收起來）', async () => {
      seq = 0;
      const server = managed({ pinned: ['目標那條'], archived: ['跑著的那條'] });
      render(<App client={server.client} />);
      await openList();
      const pinned = await screen.findByTestId('thread-pinned');
      expect(within(pinned).getByText(UNTITLED_THREAD_LABEL)).toBeTruthy();
      expect(
        within(await screen.findByTestId('thread-archived')).getByRole('button', {
          name: '已封存（1）',
        }),
      ).toBeTruthy();
    });

    it('集合以 server 回的整份為準：別的分頁同時釘了一條，這邊跟著出現，不是本機自己加一條', async () => {
      seq = 0;
      // 這一次釘選，server 回的集合裡多了別的分頁剛釘的「跑著的那條」，而且排在前面。
      const server = managed({}, { pin: (id) => ['跑著的那條', id] });
      render(<App client={server.client} />);
      const list = await openList();
      await menuOf(list, UNTITLED_THREAD_LABEL);
      choose('釘選');
      const pinned = await screen.findByTestId('thread-pinned');
      await waitFor(() =>
        expect(
          within(pinned)
            .getAllByTestId('thread-title-text')
            .map((row) => row.textContent),
        ).toEqual(['幫我改登入頁', UNTITLED_THREAD_LABEL]),
      );
    });

    it('封存釘選的那條：釘選集合重抓 server 的，不在本機推（server 規則是封存順手取消釘選）', async () => {
      seq = 0;
      const server = managed({ pinned: ['目標那條'] });
      render(<App client={server.client} />);
      const list = await openList();
      await screen.findByTestId('thread-pinned');
      const before = server.lists();
      await menuOf(list, UNTITLED_THREAD_LABEL);
      choose('封存');
      await screen.findByTestId('thread-archived');
      // 回應只帶封存集合，所以封存之後重抓了列表。
      await waitFor(() => expect(server.lists()).toBeGreaterThan(before));
      expect(screen.queryByTestId('thread-pinned')).toBeNull();
      expect(server.state.pinned).toEqual([]);
      // 取消封存：server 不會把它放回釘選，畫面也不放回去。
      fireEvent.click(
        within(await screen.findByTestId('thread-archived')).getByRole('button', {
          name: '已封存（1）',
        }),
      );
      await menuOf(list, UNTITLED_THREAD_LABEL);
      choose('取消封存');
      await waitFor(() => expect(screen.queryByTestId('thread-archived')).toBeNull());
      expect(screen.queryByTestId('thread-pinned')).toBeNull();
    });

    it('封存還在跑的會話：先問「要停掉再封存嗎」，先不要就什麼都沒變', async () => {
      seq = 0;
      const server = managed();
      render(<App client={server.client} />);
      const list = await openList();
      await menuOf(list, '幫我改登入頁');
      choose('封存');
      const dialog = await screen.findByRole('alertdialog');
      expect(within(dialog).getByText(/「幫我改登入頁」正在回答。要停掉再封存嗎？/u)).toBeTruthy();
      fireEvent.click(within(dialog).getByRole('button', { name: '先不要' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(server.calls.filter((call) => call.startsWith('archive'))).toEqual([
        'archive 跑著的那條',
      ]);
      expect(screen.queryByTestId('thread-archived')).toBeNull();
    });

    it('封存還在跑的會話：確認之後帶 stopActivity 再送一次，會話移到已封存', async () => {
      seq = 0;
      const server = managed();
      render(<App client={server.client} />);
      const list = await openList();
      await menuOf(list, '幫我改登入頁');
      choose('封存');
      fireEvent.click(
        within(await screen.findByRole('alertdialog')).getByRole('button', { name: '停掉並封存' }),
      );
      await waitFor(() => expect(screen.getByTestId('thread-archived')).toBeTruthy());
      expect(server.calls.filter((call) => call.startsWith('archive'))).toEqual([
        'archive 跑著的那條',
        'archive 跑著的那條 stop',
      ]);
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });

    it('封存時 server 說找不到：說出原因、不問', async () => {
      seq = 0;
      const server = managed();
      server.client.threadArchive = (async () => ({
        kind: 'ok' as const,
        result: { ok: false as const, error: { code: 'thread_not_found' } },
      })) as unknown as WireClient['threadArchive'];
      render(<App client={server.client} />);
      const list = await openList();
      await menuOf(list, '幫我改登入頁');
      choose('封存');
      expect(await screen.findByText('找不到這條會話（可能已經被刪掉）。')).toBeTruthy();
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });

    it('打開封存的會話：輸入框上方有「此會話已封存」橫幅，送出鈕停用、Enter 不送；取消封存之後橫幅消失、能送', async () => {
      seq = 0;
      const server = managed({ archived: ['目標那條'] });
      render(<App client={server.client} />);
      await openList();
      fireEvent.click(
        within(await screen.findByTestId('thread-archived')).getByRole('button', {
          name: '已封存（1）',
        }),
      );
      // 現在這條是新生的，沒有橫幅。
      expect(screen.queryByTestId('archived-banner')).toBeNull();
      fireEvent.click(
        within(screen.getByTestId('thread-archived')).getByText(UNTITLED_THREAD_LABEL),
      );
      const banner = await screen.findByTestId('archived-banner');
      expect(within(banner).getByText('此會話已封存')).toBeTruthy();
      const box = screen.getByLabelText('要說的話');
      fireEvent.change(box, { target: { value: '還能說嗎' } });
      expect((screen.getByRole('button', { name: '送出' }) as HTMLButtonElement).disabled).toBe(
        true,
      );
      fireEvent.keyDown(box, { key: 'Enter' });
      expect(server.sent).toEqual([]);
      // 草稿留著，不因為擋住而被清掉。
      expect((box as HTMLTextAreaElement).value).toBe('還能說嗎');

      fireEvent.click(within(banner).getByRole('button', { name: '取消封存' }));
      await waitFor(() => expect(screen.queryByTestId('archived-banner')).toBeNull());
      expect(server.calls).toContain('unarchive 目標那條');
      await waitFor(() =>
        expect((screen.getByRole('button', { name: '送出' }) as HTMLButtonElement).disabled).toBe(
          false,
        ),
      );
      fireEvent.keyDown(box, { key: 'Enter' });
      await waitFor(() => expect(server.sent).toEqual(['還能說嗎']));
    });

    it('封存的會話不能釘：server 回 thread_archived，說出原因', async () => {
      seq = 0;
      const server = managed({ archived: ['目標那條'] });
      render(<App client={server.client} />);
      const list = await openList();
      fireEvent.click(
        within(await screen.findByTestId('thread-archived')).getByRole('button', {
          name: '已封存（1）',
        }),
      );
      await menuOf(list, UNTITLED_THREAD_LABEL);
      // 封存的那一列選單裡沒有「釘選」（畫面不給），所以直接驗 hook 的說法在文字庫裡：見 lib 測試。
      expect(screen.queryByRole('menuitem', { name: '釘選' })).toBeNull();
    });

    it('改名被 server 拒絕（標題不合法）：用 server 的說明，標題不變', async () => {
      seq = 0;
      const server = managed();
      render(<App client={server.client} />);
      const list = await openList();
      await menuOf(list, '幫我改登入頁');
      choose('重新命名');
      const field = screen.getByRole('textbox', { name: '重新命名會話' });
      fireEvent.change(field, { target: { value: '壞標題' } });
      fireEvent.keyDown(field, { key: 'Enter' });
      expect(await screen.findByText('標題裡不能有「壞」。')).toBeTruthy();
      // server 沒改標題，輸入框還開著讓人改。
      expect(server.state.titles.size).toBe(0);
      expect(screen.getByRole('textbox', { name: '重新命名會話' })).toBeTruthy();
    });
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

    const rowNames = (list: HTMLElement) => threadRows(list).map((row) => row.textContent ?? '');

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
      expect(threadRows(list)).toHaveLength(0);
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
    // 側欄有會話時，搜尋框旁邊常駐一格 status（#1290）：狀態列限在 main 裡找。
    await waitFor(() =>
      expect(within(screen.getByRole('main')).getByRole('status').textContent).toContain('執行中'),
    );
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
    // 側欄有會話時，搜尋框旁邊常駐一格 status（#1290）：狀態列限在 main 裡找。
    await waitFor(() =>
      expect(within(screen.getByRole('main')).getByRole('status').textContent).toContain('就緒'),
    );
    fake.downlink.push(fake.opened[0]!, [fake.downlink.titleFrame('修好登入頁的錯誤')]);
    await waitFor(() => expect(heading().textContent).toBe('修好登入頁的錯誤'));
    await waitFor(() => expect(document.title).toBe('修好登入頁的錯誤 — nexus-agent'));
    fireEvent.change(within(list).getByRole('searchbox', { name: '搜尋以前的會話' }), {
      target: { value: '錯誤' },
    });
    await waitFor(() => expect(threadRows(list)).toHaveLength(1));
    expect(threadRows(list)[0]!.textContent).toContain('修好登入頁的錯誤');
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

describe('模型座（#723）', () => {
  beforeEach(stubCmdkLayout);

  const CATALOG: ModelCatalogResult = {
    ok: true,
    value: {
      catalog: {
        default: { modelId: 'model-a' },
        models: [
          { id: 'model-a', name: 'Alpha' },
          {
            id: 'model-b',
            name: 'Beta',
            reasoning: {
              efforts: [
                { id: 'low', name: '低' },
                { id: 'high', name: '高' },
              ],
              defaultEffort: 'low',
            },
          },
        ],
      },
      selection: { lastUsed: null, next: null },
    },
  };

  /** 接上模型型錄的假 client；`select` 記下每一次選擇，回 `result`。 */
  function withModels(
    result: ModelSelectResult | ((selection: ModelSelection) => ModelSelectResult) = (
      selection,
    ) => ({
      ok: true,
      value: { selected: selection },
    }),
    catalog: ModelCatalogResult = CATALOG,
  ) {
    seq = 0;
    const fake = fakeClient([frame('lifecycle', [], { event: 'completed', graph_name: 'root' })]);
    const selected: ModelSelection[] = [];
    const client: WireClient = {
      ...fake.client,
      modelCatalog: async () => ({ kind: 'ok', result: catalog }),
      selectModel: async (_threadId, selection) => {
        selected.push(selection);
        return { kind: 'ok', result: typeof result === 'function' ? result(selection) : result };
      },
    };
    return { ...fake, client, selected };
  }

  const seat = () => screen.queryByTestId('model-seat');
  const typeLine = (value: string) =>
    fireEvent.change(screen.getByLabelText('要說的話'), { target: { value } });
  const submit = () => fireEvent.keyDown(screen.getByLabelText('要說的話'), { key: 'Enter' });
  const pickOption = async (name: string) => {
    const list = await screen.findByRole('listbox');
    fireEvent.click(within(list).getByText(name));
  };

  it.each([
    ['not_supported', { kind: 'rejected', code: 'not_supported', message: '還沒實作' }],
    ['其他拒絕', { kind: 'rejected', message: '這條線收不了' }],
  ] as const)('伺服器回 %s 時沒有模型座、`/` 選單也沒有 /model', async (_case, outcome) => {
    seq = 0;
    const fake = fakeClient([frame('lifecycle', [], { event: 'completed', graph_name: 'root' })]);
    const modelCatalog = vi.fn(async () => outcome);
    render(<App client={{ ...fake.client, modelCatalog }} />);

    await waitFor(() => expect(modelCatalog).toHaveBeenCalled());
    await screen.findByPlaceholderText('說點什麼…');
    expect(seat()).toBeNull();
    typeLine('/');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    // 沒有 /model 時，打 /model 就是一般的斜線命令：走伺服器，不被客戶端攔。
    typeLine('/model');
    submit();
    await waitFor(() => expect(fake.slashed).toEqual(['/model']));
  });

  it('讀型錄時拋錯也不畫模型座', async () => {
    seq = 0;
    const fake = fakeClient([frame('lifecycle', [], { event: 'completed', graph_name: 'root' })]);
    const modelCatalog = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    render(<App client={{ ...fake.client, modelCatalog }} />);
    await waitFor(() => expect(modelCatalog).toHaveBeenCalled());
    await screen.findByPlaceholderText('說點什麼…');
    expect(seat()).toBeNull();
  });

  it('座位寫目前的模型（無障礙名稱含目前的值），沒選過就是部署預設', async () => {
    const { client } = withModels();
    render(<App client={client} />);

    const button = await screen.findByTestId('model-seat');
    expect(button.getAttribute('aria-label')).toBe('模型：Alpha，點開切換');
    expect(button.textContent).toBe('Alpha');
  });

  it('點開選另一顆：送 { modelId }，成功後座位換成新的', async () => {
    const { client, selected } = withModels();
    render(<App client={client} />);

    fireEvent.click(await screen.findByTestId('model-seat'));
    await pickOption('Beta');

    await waitFor(() => expect(selected).toEqual([{ modelId: 'model-b' }]));
    await waitFor(() =>
      expect(screen.getByTestId('model-seat').getAttribute('aria-label')).toBe(
        '模型：Beta · 低，點開切換',
      ),
    );
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('有宣告推理強度的模型多一段強度；沒宣告的沒有', async () => {
    const { client, selected } = withModels();
    render(<App client={client} />);

    fireEvent.click(await screen.findByTestId('model-seat'));
    const alphaList = await screen.findByRole('listbox');
    expect(within(alphaList).queryByText('推理強度')).toBeNull();
    fireEvent.click(within(alphaList).getByText('Beta'));
    await waitFor(() => expect(selected).toHaveLength(1));

    fireEvent.click(await screen.findByTestId('model-seat'));
    const betaList = await screen.findByRole('listbox');
    expect(within(betaList).getByText('推理強度')).toBeTruthy();
    fireEvent.click(within(betaList).getByText('高'));
    await waitFor(() =>
      expect(selected).toEqual([
        { modelId: 'model-b' },
        { modelId: 'model-b', reasoningEffort: 'high' },
      ]),
    );
    await waitFor(() =>
      expect(screen.getByTestId('model-seat').getAttribute('aria-label')).toContain('Beta · 高'),
    );
  });

  it('選不上（model_unavailable）：說出來，座位不變', async () => {
    const { client, selected } = withModels({
      ok: false,
      error: { code: 'model_unavailable', modelId: 'model-b' },
    });
    render(<App client={client} />);

    fireEvent.click(await screen.findByTestId('model-seat'));
    await pickOption('Beta');

    await waitFor(() => expect(selected).toHaveLength(1));
    expect(await screen.findByText(/這顆模型現在選不了/u)).toBeTruthy();
    expect(screen.getByTestId('model-seat').getAttribute('aria-label')).toBe(
      '模型：Alpha，點開切換',
    );
  });

  it('伺服器推來的投影（別的分頁選的）蓋過先前的選擇', async () => {
    const { client, downlink, opened } = withModels();
    render(<App client={client} />);
    await screen.findByTestId('model-seat');

    downlink.push(opened[0]!, [
      downlink.customFrame(PROJECTION, {
        key: 'model-selection',
        version: 1,
        view: {
          lastUsed: { modelId: 'model-a' },
          next: { modelId: 'model-b', reasoningEffort: 'high' },
        },
      }),
    ]);
    await waitFor(() =>
      expect(screen.getByTestId('model-seat').getAttribute('aria-label')).toBe(
        '模型：Beta · 高，點開切換',
      ),
    );
  });

  it('自己剛選的先頂著；投影之後再推來的以伺服器為準', async () => {
    const { client, downlink, opened, selected } = withModels();
    render(<App client={client} />);

    fireEvent.click(await screen.findByTestId('model-seat'));
    await pickOption('Beta');
    await waitFor(() => expect(selected).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByTestId('model-seat').getAttribute('aria-label')).toContain('Beta'),
    );

    // 別的分頁把它改回 Alpha：伺服器講的比這個分頁記得的新。
    downlink.push(opened[0]!, [
      downlink.customFrame(PROJECTION, {
        key: 'model-selection',
        version: 1,
        view: { lastUsed: { modelId: 'model-b' }, next: { modelId: 'model-a' } },
      }),
    ]);
    await waitFor(() =>
      expect(screen.getByTestId('model-seat').getAttribute('aria-label')).toBe(
        '模型：Alpha，點開切換',
      ),
    );
  });

  describe('/model', () => {
    it('`/` 選單列出 /model；選它打開座位並清掉那一行', async () => {
      const { client } = withModels();
      render(<App client={client} />);
      await screen.findByTestId('model-seat');

      typeLine('/mod');
      await pickOption('/model');

      await screen.findByRole('dialog', { name: '選模型' });
      expect((screen.getByLabelText('要說的話') as HTMLTextAreaElement).value).toBe('');
    });

    it('`/model Beta high` 直接換，不送給模型、不進佇列', async () => {
      const { client, selected, sent, slashed } = withModels();
      render(<App client={client} />);
      await screen.findByTestId('model-seat');

      typeLine('/model Beta high');
      submit();

      await waitFor(() =>
        expect(selected).toEqual([{ modelId: 'model-b', reasoningEffort: 'high' }]),
      );
      expect((screen.getByLabelText('要說的話') as HTMLTextAreaElement).value).toBe('');
      expect(sent).toEqual([]);
      expect(slashed).toEqual([]);
    });

    it('找不到那顆：說出來，那一行留在草稿裡，不選', async () => {
      const { client, selected } = withModels();
      render(<App client={client} />);
      await screen.findByTestId('model-seat');

      typeLine('/model nope');
      submit();

      expect(await screen.findByText('型錄上找不到「nope」。')).toBeTruthy();
      expect((screen.getByLabelText('要說的話') as HTMLTextAreaElement).value).toBe('/model nope');
      expect(selected).toEqual([]);
    });

    it('一輪還在跑時也能換（從下一步生效）', async () => {
      seq = 0;
      const running = fakeClient([
        frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
      ]);
      const selected: ModelSelection[] = [];
      const client: WireClient = {
        ...running.client,
        modelCatalog: async () => ({ kind: 'ok', result: CATALOG }),
        selectModel: async (_threadId, selection) => {
          selected.push(selection);
          return { kind: 'ok', result: { ok: true, value: { selected: selection } } };
        },
      };
      render(<App client={client} />);
      await screen.findByTestId('model-seat');
      await waitFor(() => expect(screen.getByRole('status').textContent).toContain('執行中'));

      typeLine('/model beta');
      submit();

      await waitFor(() => expect(selected).toEqual([{ modelId: 'model-b' }]));
    });
  });
});

describe('權限座（#437）', () => {
  beforeEach(stubCmdkLayout);

  const CATALOG: PermissionCatalogResult = {
    ok: true,
    value: {
      catalog: {
        options: [
          { value: 'read-only', name: '唯讀', description: '只能讀，改東西要問' },
          { value: 'workspace-write', name: '可寫工作區' },
          { value: 'danger-full-access', name: '全開' },
        ],
        defaultOptions: [{ value: 'workspace-write', name: '可寫工作區' }],
        defaultPreset: 'workspace-write',
      },
    },
  };

  const seat = () => screen.queryByTestId('permission-seat');
  const permissionFrame = (
    downlink: ReturnType<typeof fakeClient>['downlink'],
    currentValue: string,
  ): Event =>
    downlink.customFrame(PROJECTION, {
      key: 'permissions',
      version: 1,
      view: { currentValue },
    });

  /** 接上權限目錄的假 client；`current` 不是 `undefined` 就在一開始推那顆投影。 */
  async function withPermissions(
    current: string | undefined,
    events: readonly Event[] = [frame('lifecycle', [], { event: 'completed', graph_name: 'root' })],
  ) {
    seq = 0;
    const fake = fakeClient(events);
    const client: WireClient = {
      ...fake.client,
      permissionCatalog: async () => ({ kind: 'ok', result: CATALOG }),
    };
    render(<App client={client} />);
    await screen.findByPlaceholderText('說點什麼…');
    if (current !== undefined) {
      fake.downlink.push(fake.opened[0]!, [permissionFrame(fake.downlink, current)]);
      await screen.findByTestId('permission-seat');
    }
    return fake;
  }

  const pickOption = async (name: string) => {
    fireEvent.click(await screen.findByTestId('permission-seat'));
    const list = await screen.findByRole('listbox');
    fireEvent.click(within(list).getByText(name));
  };

  it.each([
    ['not_supported', { kind: 'rejected', code: 'not_supported', message: '還沒實作' }],
    ['其他拒絕', { kind: 'rejected', message: '這條線收不了' }],
  ] as const)('目錄回 %s：沒有權限座，即使投影到了', async (_case, outcome) => {
    seq = 0;
    const fake = fakeClient([frame('lifecycle', [], { event: 'completed', graph_name: 'root' })]);
    const permissionCatalog = vi.fn(async () => outcome);
    render(<App client={{ ...fake.client, permissionCatalog }} />);
    await screen.findByPlaceholderText('說點什麼…');
    await waitFor(() => expect(permissionCatalog).toHaveBeenCalled());
    fake.downlink.push(fake.opened[0]!, [permissionFrame(fake.downlink, 'workspace-write')]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seat()).toBeNull();
  });

  it('投影沒有送來（這個組裝沒有權限組合）：沒有權限座', async () => {
    await withPermissions(undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seat()).toBeNull();
  });

  it('座位寫目前的組（無障礙名稱含目前的值），投影換了就跟著換', async () => {
    const fake = await withPermissions('workspace-write');
    const button = screen.getByTestId('permission-seat');
    expect(button.getAttribute('aria-label')).toBe('權限：可寫工作區，點開切換');
    expect(button.getAttribute('data-warning')).toBe('false');

    fake.downlink.push(fake.opened[0]!, [permissionFrame(fake.downlink, 'read-only')]);
    await waitFor(() =>
      expect(screen.getByTestId('permission-seat').getAttribute('aria-label')).toBe(
        '權限：唯讀，點開切換',
      ),
    );
  });

  it('`custom`（對不上任何一組）寫「自訂」，清單裡沒有哪一列打勾', async () => {
    await withPermissions('custom');
    expect(screen.getByTestId('permission-seat').getAttribute('aria-label')).toBe(
      '權限：自訂，點開切換',
    );
    fireEvent.click(screen.getByTestId('permission-seat'));
    const list = await screen.findByRole('listbox');
    expect(within(list).getAllByRole('option')).toHaveLength(3);
    expect(list.querySelector('[data-checked="true"]')).toBeNull();
  });

  it('選另一組：送 `/permission <組名>`；座位等伺服器推新值才換', async () => {
    const { slashed } = await withPermissions('workspace-write');

    await pickOption('唯讀');

    await waitFor(() => expect(slashed).toEqual(['/permission read-only']));
    expect(screen.getByTestId('permission-seat').getAttribute('aria-label')).toBe(
      '權限：可寫工作區，點開切換',
    );
  });

  it('選目前這一組：什麼都不送', async () => {
    const { slashed } = await withPermissions('workspace-write');
    await pickOption('可寫工作區');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(slashed).toEqual([]);
  });

  it('命令失敗：原因由斜線命令的那一套顯示，座位不自己改', async () => {
    seq = 0;
    const fake = fakeClient([frame('lifecycle', [], { event: 'completed', graph_name: 'root' })]);
    const client: WireClient = {
      ...fake.client,
      permissionCatalog: async () => ({ kind: 'ok', result: CATALOG }),
      slashRun: async () => ({ kind: 'error', text: '這一組在設定裡被拿掉了' }),
    };
    render(<App client={client} />);
    await screen.findByPlaceholderText('說點什麼…');
    fake.downlink.push(fake.opened[0]!, [permissionFrame(fake.downlink, 'workspace-write')]);
    await pickOption('唯讀');

    expect(await screen.findByText('這一組在設定裡被拿掉了')).toBeTruthy();
    expect(screen.getByTestId('permission-seat').getAttribute('aria-label')).toContain(
      '可寫工作區',
    );
  });

  describe('全開要先確認', () => {
    it('選「全開」先跳確認，還沒送；取消就不送', async () => {
      const { slashed } = await withPermissions('workspace-write');

      await pickOption('全開');

      const dialog = await screen.findByRole('alertdialog');
      expect(within(dialog).getByText('切換到「全開」？')).toBeTruthy();
      expect(within(dialog).getByText(/不再跳出核准請求/u)).toBeTruthy();
      expect(slashed).toEqual([]);
      // 預設落在取消：不小心按 Enter 不會切過去。
      expect(document.activeElement?.textContent).toBe('取消');

      fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(slashed).toEqual([]);
    });

    it('按「切換」才送 `/permission danger-full-access`', async () => {
      const { slashed } = await withPermissions('workspace-write');

      await pickOption('全開');
      const dialog = await screen.findByRole('alertdialog');
      fireEvent.click(within(dialog).getByRole('button', { name: '切換' }));

      await waitFor(() => expect(slashed).toEqual(['/permission danger-full-access']));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    });

    it('其他組不問、直接送；目前就是全開時座位換警示色', async () => {
      const fake = await withPermissions('danger-full-access');
      expect(screen.getByTestId('permission-seat').getAttribute('data-warning')).toBe('true');

      await pickOption('唯讀');

      await waitFor(() => expect(fake.slashed).toEqual(['/permission read-only']));
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
  });

  it('一輪在跑時清單停用，寫明原因，選了也不送', async () => {
    const { slashed } = await withPermissions('workspace-write', [
      frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
    ]);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('執行中'));

    fireEvent.click(screen.getByTestId('permission-seat'));
    const list = await screen.findByRole('listbox');
    expect(screen.getByTestId('picker-locked').textContent).toBe('這一輪結束後才能切換。');
    fireEvent.click(within(list).getByText('唯讀'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(slashed).toEqual([]);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('附件送出（#733、#732）', () => {
  beforeEach(() => {
    attachmentGate.on = true;
    URL.createObjectURL = vi.fn(() => 'blob:preview');
    URL.revokeObjectURL = vi.fn();
  });

  const png = (name = 'shot.png') => new File(['PNG'], name, { type: 'image/png' });
  const pdf = (name = 'plan.pdf') => new File(['PDF'], name, { type: 'application/pdf' });

  /** 接好上傳與送出的假 client：`runStart` 記下每次的參數，`uploadFile` 回 `r-<檔名>`。 */
  function withUploads(
    runStartResult: UplinkResult = { type: 'success', id: 1, result: { run_id: 'run-1' } },
  ) {
    seq = 0;
    const fake = fakeClient([frame('lifecycle', [], { event: 'completed', graph_name: 'root' })]);
    const uploads: { threadId: string; name: string | undefined }[] = [];
    const runStart = vi.fn(async (..._args: Parameters<WireClient['runStart']>) => runStartResult);
    const client: WireClient = {
      ...fake.client,
      runStart,
      uploadFile: async (threadId, _body, name) => {
        uploads.push({ threadId, name });
        return { kind: 'ok', receipt: { receiptId: `r-${name}`, name: name ?? '', bytes: 3 } };
      },
    };
    return { ...fake, client, runStart, uploads };
  }

  const addFiles = (files: File[]) =>
    fireEvent.change(screen.getByTestId('attachment-input'), { target: { files } });
  const input = () => screen.getByLabelText('要說的話') as HTMLTextAreaElement;
  const chips = () => screen.queryAllByTestId('draft-attachment');
  const send = (text: string) => {
    fireEvent.change(input(), { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
  };

  it('圖內嵌、檔案先上傳換收據，照選取順序帶進 run.start；收下後草稿與附件都清掉', async () => {
    const { client, runStart, uploads } = withUploads();
    render(<App client={client} />);
    await screen.findByPlaceholderText('說點什麼…');

    addFiles([png('a.png'), pdf('b.pdf'), png('c.png')]);
    expect(chips()).toHaveLength(3);
    send('看這幾個');

    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    const [threadId, text, options] = runStart.mock.calls[0]!;
    expect(text).toBe('看這幾個');
    expect(options?.attachments).toEqual([
      { type: 'image', mediaType: 'image/png', data: btoa('PNG'), name: 'a.png' },
      { type: 'file', receiptId: 'r-b.pdf' },
      { type: 'image', mediaType: 'image/png', data: btoa('PNG'), name: 'c.png' },
    ]);
    // 只有檔案上傳，傳到的是同一條 thread。
    expect(uploads).toEqual([{ threadId, name: 'b.pdf' }]);
    await waitFor(() => expect(chips()).toHaveLength(0));
    expect(input().value).toBe('');
  });

  it('只有附件、沒打字也送得出去：文字是空字串，附件照帶；沒附件沒文字仍送不出', async () => {
    const { client, runStart } = withUploads();
    render(<App client={client} />);
    await screen.findByPlaceholderText('說點什麼…');
    const sendButton = () => screen.getByRole('button', { name: '送出' });

    expect(sendButton().hasAttribute('disabled')).toBe(true);
    addFiles([png('a.png'), pdf('b.pdf')]);
    expect(input().value).toBe('');
    await waitFor(() => expect(sendButton().hasAttribute('disabled')).toBe(false));
    fireEvent.click(sendButton());

    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    const [, text, options] = runStart.mock.calls[0]!;
    expect(text).toBe('');
    expect(options?.attachments).toEqual([
      { type: 'image', mediaType: 'image/png', data: btoa('PNG'), name: 'a.png' },
      { type: 'file', receiptId: 'r-b.pdf' },
    ]);
    await waitFor(() => expect(chips()).toHaveLength(0));
    expect(sendButton().hasAttribute('disabled')).toBe(true);
  });

  it('只有附件時 Enter 也送；Cmd+Enter 是帶著附件插話，不是把佇列改成插話', async () => {
    const { client, runStart } = withUploads();
    render(<App client={client} />);
    await screen.findByPlaceholderText('說點什麼…');

    addFiles([png('a.png')]);
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    expect(runStart.mock.calls[0]![1]).toBe('');

    addFiles([png('b.png')]);
    fireEvent.keyDown(input(), { key: 'Enter', metaKey: true, ctrlKey: true });
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(2));
    expect(runStart.mock.calls[1]![2]?.attachments).toHaveLength(1);
  });

  it('被拒時只有附件的那句：附件留著，草稿維持空白', async () => {
    const { client, runStart } = withUploads({
      type: 'error',
      id: 1,
      error: 'invalid_argument',
      message: '只有附件的那句被拒了（伺服器的話）',
    });
    render(<App client={client} />);
    await screen.findByPlaceholderText('說點什麼…');
    addFiles([png('a.png')]);
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/只有附件的那句被拒了/u)).toBeTruthy();
    expect(chips()).toHaveLength(1);
    expect(input().value).toBe('');
  });

  it('沒有附件：run.start 沒有 attachments 這個鍵（只多了請求編號，#1335）', async () => {
    const { client, runStart, uploads } = withUploads();
    render(<App client={client} />);
    await screen.findByPlaceholderText('說點什麼…');
    send('只有字');
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    expect(Object.keys(runStart.mock.calls[0]![2] as object)).toEqual(['requestId']);
    expect(uploads).toEqual([]);
  });

  it.each([
    [
      '目前的模型不收圖',
      { type: 'error', id: 1, error: MODEL_DOES_NOT_SUPPORT_IMAGES, message: 'model rejects' },
      '目前的模型不收圖片',
    ],
    [
      '伺服器不收附件',
      { type: 'error', id: 1, error: 'not_supported', message: 'no attachment store' },
      '這個伺服器不收附件。',
    ],
    [
      '別的原因',
      { type: 'error', id: 1, error: 'invalid_argument', message: '圖太大了（伺服器的話）' },
      '圖太大了（伺服器的話）',
    ],
  ] as const)('被拒（%s）：說原因，草稿與附件都留著', async (_case, result, shown) => {
    const { client, runStart } = withUploads(result as UplinkResult);
    render(<App client={client} />);
    await screen.findByPlaceholderText('說點什麼…');

    addFiles([png('a.png'), pdf('b.pdf')]);
    send('這句會被拒');

    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(new RegExp(shown, 'u'))).toBeTruthy();
    await waitFor(() => expect(input().value).toBe('這句會被拒'));
    expect(chips()).toHaveLength(2);
  });

  it('沒送出去後原樣重送沿用編號（收據會重新上傳，比的是草稿附件）；增減附件是新的一句（#1335）', async () => {
    const { client, runStart, uploads } = withUploads({
      type: 'error',
      id: 1,
      error: 'invalid_argument',
      message: '帶附件的這句沒收下（#1335）',
    });
    render(<App client={client} />);
    await screen.findByPlaceholderText('說點什麼…');
    const ids = () => runStart.mock.calls.map(([, , options]) => options?.requestId);

    addFiles([png('a.png'), pdf('b.pdf')]);
    send('帶附件');
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(input().value).toBe('帶附件'));

    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(2));
    expect(uploads.map((upload) => upload.name)).toEqual(['b.pdf', 'b.pdf']);
    expect(ids()[1]).toBe(ids()[0]);

    await waitFor(() => expect(input().value).toBe('帶附件'));
    addFiles([pdf('c.pdf')]);
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(3));
    expect(ids()[2]).not.toBe(ids()[1]);

    await waitFor(() => expect(input().value).toBe('帶附件'));
    fireEvent.click(screen.getAllByRole('button', { name: /移除/u })[0]!);
    await waitFor(() => expect(chips()).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(4));
    expect(ids()[3]).not.toBe(ids()[2]);
    expect(ids()[3]).not.toBe(ids()[0]);
  });

  it('上傳失敗：這句不送，說原因，草稿與附件留著；再按一次會重傳', async () => {
    const { client, runStart, uploads } = withUploads();
    let failing = true;
    const failingClient: WireClient = {
      ...client,
      uploadFile: async (threadId, body, name, signal) => {
        if (failing) return { kind: 'rejected', message: '磁碟滿了' };
        return client.uploadFile(threadId, body, name, signal);
      },
    };
    render(<App client={failingClient} />);
    await screen.findByPlaceholderText('說點什麼…');

    addFiles([pdf('b.pdf')]);
    send('帶檔案');
    expect(await screen.findByText('「b.pdf」上傳失敗：磁碟滿了')).toBeTruthy();
    expect(runStart).not.toHaveBeenCalled();
    await waitFor(() => expect(input().value).toBe('帶檔案'));
    expect(chips()).toHaveLength(1);

    failing = false;
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    expect(uploads).toEqual([{ threadId: expect.any(String), name: 'b.pdf' }]);
  });

  it('送出中不收第二次送出', async () => {
    const { client, runStart } = withUploads();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: WireClient = {
      ...client,
      uploadFile: async (threadId, body, name, signal) => {
        await gate;
        return client.uploadFile(threadId, body, name, signal);
      },
    };
    render(<App client={slow} />);
    await screen.findByPlaceholderText('說點什麼…');

    addFiles([pdf('b.pdf')]);
    send('第一句');
    fireEvent.change(input(), { target: { value: '第二句' } });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '送出' }).hasAttribute('disabled')).toBe(true),
    );
    release();
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    expect(runStart.mock.calls[0]![1]).toBe('第一句');
  });

  it('送出期間才加進來的附件，收下後留著；只清掉送出的那一批', async () => {
    const { client, runStart } = withUploads();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: WireClient = {
      ...client,
      uploadFile: async (threadId, body, name, signal) => {
        await gate;
        return client.uploadFile(threadId, body, name, signal);
      },
    };
    render(<App client={slow} />);
    await screen.findByPlaceholderText('說點什麼…');

    addFiles([pdf('first.pdf')]);
    send('第一句');
    addFiles([pdf('late.pdf')]);
    release();

    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(chips()[0]!.textContent).toContain('late.pdf');
  });

  describe('上傳進度與取消（#733）', () => {
    type Progress = (progress: { loaded: number; total?: number }) => void;

    /** 上傳會一直掛著、自己報進度，收到 abort 才結束的假 client；`finish` 讓目前掛著的那次成功。 */
    function hanging() {
      const base = withUploads();
      const report: Progress[] = [];
      const finishers: (() => void)[] = [];
      let starts = 0;
      const client: WireClient = {
        ...base.client,
        uploadFile: ((
          threadId: string,
          body: Blob | Uint8Array,
          name?: string,
          signal?: AbortSignal,
          onProgress?: Progress,
        ) => {
          starts += 1;
          if (onProgress !== undefined) report.push(onProgress);
          return new Promise((resolve, reject) => {
            signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
            finishers.push(() => resolve(base.client.uploadFile(threadId, body, name, signal)));
          });
        }) as WireClient['uploadFile'],
      };
      return {
        ...base,
        client,
        report: (progress: { loaded: number; total?: number }) =>
          act(() => report.at(-1)?.(progress)),
        finish: () => act(async () => finishers.at(-1)?.()),
        starts: () => starts,
      };
    }

    const bar = () => screen.getByRole('progressbar', { name: '上傳 b.pdf' });

    it('上傳中卡片畫進度條，跟著進度回呼走；傳完後收下，卡片離開草稿', async () => {
      const { client, runStart, report, finish } = hanging();
      render(<App client={client} />);
      await screen.findByPlaceholderText('說點什麼…');

      addFiles([pdf('b.pdf')]);
      // 沒送出之前沒有進度條：附件還沒開始上傳。
      expect(screen.queryByRole('progressbar')).toBeNull();
      send('帶檔案');
      await waitFor(() => expect(bar()).toBeTruthy());
      expect(bar().hasAttribute('aria-valuenow')).toBe(false);

      report({ loaded: 30, total: 100 });
      expect(bar().getAttribute('aria-valuenow')).toBe('30');
      report({ loaded: 80, total: 100 });
      expect(bar().getAttribute('aria-valuenow')).toBe('80');
      expect(screen.queryByRole('button', { name: '移除 b.pdf' })).toBeNull();

      await finish();
      await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(chips()).toHaveLength(0));
      expect(screen.queryByRole('progressbar')).toBeNull();
    });

    it('取消：卡片回到未上傳，這一句不送，草稿與附件都在；不當成錯誤', async () => {
      const { client, runStart } = hanging();
      render(<App client={client} />);
      await screen.findByPlaceholderText('說點什麼…');

      addFiles([pdf('b.pdf')]);
      send('帶檔案');
      fireEvent.click(await screen.findByRole('button', { name: '取消上傳 b.pdf' }));

      await waitFor(() => expect(chips()[0]!.textContent).toContain('未上傳（已取消）'));
      expect(screen.queryByRole('progressbar')).toBeNull();
      // sonner 的 toast 是全域的、跨測試留著：斷言這一條才有的說明，不斷言共用的標題；
      // 不是錯誤，看的是那一條 toast 自己的種類（`toast.error` 會帶 `data-type="error"`）。
      const note = (await screen.findAllByText('附件還在，再按送出會重新上傳。'))[0]!;
      expect(note.closest('[data-sonner-toast]')?.getAttribute('data-type')).not.toBe('error');
      expect(runStart).not.toHaveBeenCalled();
      await waitFor(() => expect(input().value).toBe('帶檔案'));
      expect(chips()).toHaveLength(1);
      expect(screen.getByRole('button', { name: '移除 b.pdf' })).toBeTruthy();
    });

    it('取消後重試：再按送出重新上傳，這一次傳完就送出；進度從頭算', async () => {
      const { client, runStart, report, finish, starts } = hanging();
      render(<App client={client} />);
      await screen.findByPlaceholderText('說點什麼…');

      addFiles([pdf('b.pdf')]);
      send('帶檔案');
      report({ loaded: 90, total: 100 });
      fireEvent.click(await screen.findByRole('button', { name: '取消上傳 b.pdf' }));
      await waitFor(() => expect(chips()[0]!.textContent).toContain('未上傳（已取消）'));
      await waitFor(() => expect(input().value).toBe('帶檔案'));

      await waitFor(() =>
        expect(screen.getByRole('button', { name: '送出' }).hasAttribute('disabled')).toBe(false),
      );
      fireEvent.click(screen.getByRole('button', { name: '送出' }));
      await waitFor(() => expect(starts()).toBe(2));
      await waitFor(() => expect(bar()).toBeTruthy());
      expect(bar().hasAttribute('aria-valuenow')).toBe(false);
      expect(chips()[0]!.textContent).not.toContain('未上傳');

      await finish();
      await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
      expect(runStart.mock.calls[0]![2]?.attachments).toEqual([
        { type: 'file', receiptId: 'r-b.pdf' },
      ]);
      await waitFor(() => expect(chips()).toHaveLength(0));
    });

    it('取消是整句取消：同一句裡的另一個檔案也回到未上傳', async () => {
      const { client, runStart } = hanging();
      render(<App client={client} />);
      await screen.findByPlaceholderText('說點什麼…');

      addFiles([pdf('b.pdf'), pdf('c.pdf')]);
      send('兩個檔案');
      await waitFor(() => expect(screen.getAllByRole('progressbar')).toHaveLength(2));
      fireEvent.click(screen.getByRole('button', { name: '取消上傳 c.pdf' }));

      await waitFor(() =>
        expect(chips().map((chip) => chip.getAttribute('data-upload'))).toEqual(['idle', 'idle']),
      );
      expect(runStart).not.toHaveBeenCalled();
    });

    it('上傳失敗的卡寫「未上傳（上傳失敗）」；再送時又變回上傳中', async () => {
      const { client, runStart } = withUploads();
      let failing = true;
      const flaky: WireClient = {
        ...client,
        uploadFile: async (threadId, body, name, signal) =>
          failing
            ? { kind: 'rejected', message: '磁碟滿了' }
            : client.uploadFile(threadId, body, name, signal),
      };
      render(<App client={flaky} />);
      await screen.findByPlaceholderText('說點什麼…');
      addFiles([pdf('b.pdf')]);
      send('帶檔案');
      await waitFor(() => expect(chips()[0]!.textContent).toContain('未上傳（上傳失敗）'));
      expect(chips()[0]!.getAttribute('data-state')).toBe('error');

      failing = false;
      await waitFor(() => expect(input().value).toBe('帶檔案'));
      fireEvent.click(screen.getByRole('button', { name: '送出' }));
      await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    });

    it('上傳成功、伺服器沒收下這一句：卡片照常畫（不寫上傳失敗），附件還在', async () => {
      const { client, runStart } = withUploads({
        type: 'error',
        id: 1,
        error: 'invalid_argument',
        message: '這句被拒了（伺服器的話）',
      });
      render(<App client={client} />);
      await screen.findByPlaceholderText('說點什麼…');
      addFiles([pdf('b.pdf')]);
      send('帶檔案');
      await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
      expect(await screen.findByText(/這句被拒了/u)).toBeTruthy();
      expect(chips()).toHaveLength(1);
      expect(chips()[0]!.getAttribute('data-upload')).toBe('none');
      expect(chips()[0]!.textContent).toContain('PDF');
      expect(screen.getByRole('button', { name: '移除 b.pdf' })).toBeTruthy();
    });
  });

  describe('斜線命令帶附件（#733）', () => {
    type SlashCall = { line: string; attachments: Parameters<WireClient['slashRun']>[2] };
    function withSlash(run: (line: string) => SlashRunOutcome) {
      const fake = withUploads();
      const calls: SlashCall[] = [];
      const client: WireClient = {
        ...fake.client,
        slashRun: async (_threadId, line, attachments) => {
          calls.push({ line, attachments });
          return run(line);
        },
      };
      return { ...fake, client, calls };
    }

    it('命令收下：附件（檔案先換成收據）放進 slash.run，不走 run.start；草稿與附件都清掉', async () => {
      const { client, calls, runStart, uploads } = withSlash(() => ({
        kind: 'success',
        command_id: 'c',
      }));
      render(<App client={client} />);
      await screen.findByPlaceholderText('說點什麼…');

      addFiles([pdf('note.pdf'), png('a.png')]);
      send('/goal 照附件做');

      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]).toEqual({
        line: '/goal 照附件做',
        attachments: [
          { type: 'file', receiptId: 'r-note.pdf' },
          { type: 'image', mediaType: 'image/png', data: btoa('PNG'), name: 'a.png' },
        ],
      });
      expect(uploads).toHaveLength(1);
      expect(runStart).not.toHaveBeenCalled();
      await waitFor(() => expect(chips()).toHaveLength(0));
      expect(input().value).toBe('');
    });

    it('帶附件的命令斷在網路層：照舊說沒送出去，不說原樣重送不會重複（命令沒有請求編號，#1335）', async () => {
      const { client, calls } = withSlash(() => {
        throw new TypeError('命令斷了（#1335 toast）');
      });
      render(<App client={client} />);
      await screen.findByPlaceholderText('說點什麼…');

      addFiles([pdf('b.pdf')]);
      send('/goal 斷線');

      const card = await toastWith('命令斷了（#1335 toast）');
      expect(card.getAttribute('data-type')).toBe('error');
      expect(card.textContent).toContain('這一句沒送出去');
      expect(card.textContent).not.toContain('不會重複');
      expect(calls).toHaveLength(1);
      await waitFor(() => expect(input().value).toBe('/goal 斷線'));
    });

    it('命令回錯誤（不收附件）：錯誤畫出來，草稿文字與附件卡都還在', async () => {
      const { client, calls } = withSlash(() => ({
        kind: 'error',
        text: 'Command "/model" does not accept attachments.',
      }));
      render(<App client={client} />);
      await screen.findByPlaceholderText('說點什麼…');

      addFiles([pdf('b.pdf')]);
      send('/other 試試');

      expect(await screen.findAllByText(/does not accept attachments/u)).not.toHaveLength(0);
      expect(calls).toHaveLength(1);
      await waitFor(() => expect(input().value).toBe('/other 試試'));
      expect(chips()).toHaveLength(1);
    });

    it('不認得的命令：同樣說出來、草稿與附件留著', async () => {
      const { client } = withSlash(() => ({ kind: 'unknown' }));
      render(<App client={client} />);
      await screen.findByPlaceholderText('說點什麼…');

      addFiles([pdf('b.pdf')]);
      send('/nope');

      expect(await screen.findAllByText(/不認得這個命令：\/nope/u)).not.toHaveLength(0);
      await waitFor(() => expect(input().value).toBe('/nope'));
      expect(chips()).toHaveLength(1);
    });

    it('沒帶附件的命令：照舊，slash.run 不帶附件', async () => {
      const { client, calls } = withSlash(() => ({ kind: 'success', command_id: 'c' }));
      render(<App client={client} />);
      await screen.findByPlaceholderText('說點什麼…');

      send('/plan');

      await waitFor(() => expect(calls).toEqual([{ line: '/plan', attachments: undefined }]));
    });

    it('光打 /feedback 只開回饋框：不上傳、不送出，附件留在草稿裡', async () => {
      const { client, calls, uploads } = withSlash(() => ({ kind: 'success', command_id: 'c' }));
      render(<App client={client} />);
      await screen.findByPlaceholderText('說點什麼…');

      addFiles([pdf('b.pdf')]);
      send('/feedback');

      await screen.findByRole('dialog');
      expect(calls).toEqual([]);
      expect(uploads).toEqual([]);
      expect(chips()).toHaveLength(1);
    });
  });

  it('超過上限的圖不收進草稿，並說原因', async () => {
    const { client } = withUploads();
    render(<App client={client} />);
    await screen.findByPlaceholderText('說點什麼…');

    const big = png('big.png');
    Object.defineProperty(big, 'size', { value: 25 * 1024 * 1024 });
    addFiles([big, pdf('ok.pdf')]);

    expect(await screen.findByText(/「big.png」有 25.0 MB/u)).toBeTruthy();
    expect(chips().map((chip) => chip.textContent)).toEqual([expect.stringContaining('ok.pdf')]);
  });
});

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
  ) {
    seq = 0;
    const fake = fakeClient([frame('lifecycle', [], { event: 'completed', graph_name: 'root' })]);
    const runStart = vi.fn(async (..._args: Parameters<WireClient['runStart']>) => runStartResult);
    const listed = vi.fn(subagentList);
    render(<App client={{ ...fake.client, runStart, subagentList: listed }} />);
    await screen.findByPlaceholderText('說點什麼…');
    return { runStart, listed };
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
    ],
    [
      '被拒',
      async () => ({ kind: 'rejected' as const, code: 'invalid_argument', message: '不行' }),
    ],
    [
      '讀的時候拋錯',
      async (): Promise<never> => {
        throw new Error('斷了');
      },
    ],
    [
      '清單是空的（沒有可點名的對象）',
      async () => ({
        kind: 'ok' as const,
        result: { ok: true as const, value: { subagents: [] } },
      }),
    ],
  ])('server 不支援就整個不出現：%s', async (_case, list) => {
    const { listed } = await ready(list);
    await waitFor(() => expect(listed).toHaveBeenCalledTimes(1));
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
    });
    expect(chip()).toBeNull();
  });

  it('沒選就沒有 mention 欄位：只帶請求編號（#1335）', async () => {
    const { runStart } = await ready();
    type('一句話');
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    expect(Object.keys(runStart.mock.calls[0]![2] as object)).toEqual(['requestId']);
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
    seq = 0;
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
    const { runStart } = await ready();
    await pick('@');
    type('/model');
    fireEvent.keyDown(input(), { key: 'Escape' });
    fireEvent.keyDown(input(), { key: 'Enter' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runStart).not.toHaveBeenCalled();
    expect(chip()).not.toBeNull();
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
