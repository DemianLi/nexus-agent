/** `App` 的畫面測試：會話：記住與接回、以前的會話、側欄的即時狀態、引用別的會話、標題、背景子代理的輸入框接線。共用的假 client 與 hook 在 `@/test/app-harness.fixture`。 */
import type {
  Event,
  SessionReferenceCandidate,
  ThreadFeedFrame,
  ThreadListResult,
  ThreadListOutcome,
  UplinkResult,
  WireClient,
} from '@nexus/wire';
import {
  CONTEXT_MEASURE,
  formatSessionReferenceMention,
  MODEL_USAGE,
  SESSION_STATS,
  SUBAGENT_STATUS,
  THREAD_AT_CAPACITY,
  THREAD_HISTORY_TOO_DEEP,
  TITLE,
  TODOS,
  TOKEN_USAGE,
  WireProtocolError,
  WireRejectedError,
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
import { App, RESUMED_THREAD_NOTICE, STOP_QUESTIONS_LABEL, SWITCHED_THREAD_NOTICE } from '@/App';
import { BLANK_THREAD_LABEL, UNTITLED_THREAD_LABEL } from '@/components/sidebar/thread-list';
import { HALTED_PLACEHOLDER, REFUSED_PLACEHOLDER } from '@/lib/connection-stall';
import { REMEMBERED_THREAD_KEY } from '@/lib/remembered-thread';
import { THREAD_AT_CAPACITY_TEXT } from '@/lib/thread-capacity';
import { THREAD_HISTORY_TOO_DEEP_TEXT } from '@/lib/thread-history-too-deep';
import { THREAD_PROTOCOL_ERROR_TEXT } from '@/lib/thread-protocol-error';
import { axeViolations } from '@/test/axe';
import { stubCmdkLayout } from '@/test/cmdk';
import { stubInsecureCrypto, UUID_V4 } from '@/test/insecure-crypto';
import {
  PANEL_WAIT,
  approvalFrame,
  attachmentGate,
  fakeClient,
  findPanel,
  frame,
  historyFrame,
  historySaid,
  memoryStorage,
  setSeq,
  textFrames,
  threadRows,
} from '@/test/app-harness.fixture';

// `serverSupportsAttachments` 的真實作回 true（#733）；這裡接到 `attachmentGate`，預設關著。這一檔沒有測試打開它。
vi.mock('@/lib/attachments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/attachments')>()),
  serverSupportsAttachments: () => attachmentGate.on,
}));

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
    setSeq(0);
    const { client, opened } = fakeClient([]);
    render(<App client={client} />);

    await waitFor(() => expect(opened).toHaveLength(1));
    await waitFor(() => expect(stored()).toBe(opened[0]));
    expect(screen.queryByText(RESUMED_THREAD_NOTICE)).toBeNull();
  });

  /** jsdom 裡的重新整理：拆掉再掛一次，中間只剩 `localStorage`。 */
  it('重新載入：開的是同一條，而且講一聲是接著上一次', async () => {
    setSeq(0);
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
    setSeq(0);
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
    setSeq(0);
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
      setSeq(57);
      const fake = reloaded([
        approvalFrame([{ name: 'alpha', allowed: ['approve', 'reject'] }], 'int-7'),
      ]);

      const panel = await findPanel('等待核准：alpha');
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
      await waitFor(
        () => expect(screen.queryByRole('region', { name: /等待核准/ })).toBeNull(),
        PANEL_WAIT,
      );
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
      setSeq(0);
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
      setSeq(91);
      const fake = reloaded([planReviewFrame('plan-1')]);

      // 名稱是「計劃待審」，只有兩顆鈕，沒有 ❌、不能收起（#654 二-Q2、Q5）。
      const panel = await findPanel('計劃待審');
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
      setSeq(91);
      const fake = reloaded([planReviewFrame('plan-2')]);

      const panel = await findPanel('計劃待審');
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
      await waitFor(
        () => expect(screen.queryByRole('region', { name: '計劃待審' })).toBeNull(),
        PANEL_WAIT,
      );
      await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('要說的話')));
    });
  });

  it('跑著的時候「新對話」也按得動——它不看忙不忙', async () => {
    setSeq(0);
    const { client } = fakeClient([
      frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
    ]);
    render(<App client={client} />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('執行中'));
    const button = screen.getByRole('button', { name: '新對話' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it('瀏覽器不讓存：照樣開得起來，只是記不住', async () => {
    setSeq(0);
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
    setSeq(0);
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
 * 網頁從非安全環境打開（內網用 IP 開的 `http://` 頁面，#1548）：瀏覽器不給 `crypto.randomUUID`。首次載入與「新對話」都要自己產
 * thread id；斷言 id 的形狀，不只看沒拋錯——換回 `crypto.randomUUID()` 的那一處會直接拋 TypeError。
 */
describe('非安全環境（#1548）', () => {
  it('首次載入：起得來，開的那條 id 是 UUID v4', async () => {
    setSeq(0);
    stubInsecureCrypto();
    const { client, opened } = fakeClient([]);
    render(<App client={client} />);

    await waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0]).toMatch(UUID_V4);
  });

  it('新對話、沒有可重用的空白會話：換一條新的 UUID v4', async () => {
    setSeq(0);
    stubInsecureCrypto();
    localStorage.setItem(REMEMBERED_THREAD_KEY, JSON.stringify({ threadId: '上一條' }));
    const { client, opened } = fakeClient([
      frame('lifecycle', [], { event: 'completed', graph_name: 'root' }),
    ]);
    render(<App client={client} />);
    await waitFor(() => expect(screen.getByPlaceholderText('說點什麼…')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('要說的話'), { target: { value: '記一筆。' } });
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    await waitFor(() => expect(screen.getByText('記一筆。')).toBeTruthy());

    // `fakeClient` 預設讀不到清單（`UNWIRED_THREAD_LIST`），所以沒有可重用的空白會話，走「開新的」那一支。
    fireEvent.click(screen.getByRole('button', { name: '新對話' }));

    await waitFor(() => expect(opened).toHaveLength(2));
    expect(opened[0]).toBe('上一條');
    expect(opened[1]).toMatch(UUID_V4);
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
    setSeq(0);
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

    // Base UI 的 Trigger 在 jsdom 裡用點的打開（Enter 轉 click 是瀏覽器做的，見 `thread-list.test.tsx` 的 `openMenu`）。
    const menuOf = async (list: HTMLElement, title: string) => {
      fireEvent.click(await within(list).findByRole('button', { name: `「${title}」的選項` }));
    };
    const choose = (item: string) => fireEvent.click(screen.getByRole('menuitem', { name: item }));

    it('列表沒帶兩個集合（server 還沒實作）：每一列都沒有選項鈕，也沒有已釘選與已封存兩區', async () => {
      setSeq(0);
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
      setSeq(0);
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
      setSeq(0);
      render(
        <App
          client={listing(fakeClient([]), async () => ({ kind: 'rejected', message: '讀不到' }))}
        />,
      );
      await openList();
      expect(screen.queryByRole('button', { name: /的選項/u })).toBeNull();
    });

    it('支援時走完整流程：釘選、取消釘選、封存、取消封存、改名，畫面跟著 server，換到別條之後還在', async () => {
      setSeq(0);
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
      setSeq(0);
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
      setSeq(0);
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
      setSeq(0);
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
      setSeq(0);
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
      setSeq(0);
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
      setSeq(0);
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
      setSeq(0);
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
      setSeq(0);
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
      setSeq(0);
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
    setSeq(0);
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
    setSeq(0);
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
    setSeq(0);
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
    setSeq(0);
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
    setSeq(0);
    const fake = fakeClient([]);
    render(<App client={listing(fake, listThreads)} />);
    const list = await openList();
    await waitFor(() => expect(list.textContent).toContain('列不出來'));
    expect(list.textContent).toContain(reason);
    expect(list.textContent).not.toContain('還沒有以前的會話');
  });

  it('一條都沒有：講「還沒有」', async () => {
    setSeq(0);
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
    setSeq(0);
    localStorage.setItem(REMEMBERED_THREAD_KEY, JSON.stringify({ threadId: '空白那條' }));
    const fake = fakeClient([]);
    render(<App client={listing(fake, async () => ({ kind: 'ok', result: LISTED }))} />);
    const list = await openList();

    await waitFor(() => expect(within(list).getAllByRole('button')).toHaveLength(3));
    const current = within(list).getByRole('button', { name: new RegExp(BLANK_THREAD_LABEL) });
    expect(current.textContent).toBe(`${BLANK_THREAD_LABEL}目前這條`);
  });

  it('磁碟上只剩別條空白的：照講「還沒有」', async () => {
    setSeq(0);
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

  /** 分組、搜尋、狀態（inventory 列 6）：分界與比對規則在 `lib/thread-groups.test.ts`，這裡驗畫出來的。 */
  describe('分組、搜尋、狀態', () => {
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
      setSeq(0);
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

    it('跑著的那一列寫「執行中」', async () => {
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
      setSeq(0);
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
    setSeq(0);
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

  it('沒打開的那條停在核准：那一列寫「等待核准」、不帶時間；撤回就回到在跑', async () => {
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

  it('清單在路上時那條跑完：晚到的清單還說在跑，畫「已完成」，不倒回執行中（#1600）', async () => {
    const pending: ((outcome: ThreadListOutcome) => void)[] = [];
    const feed = rendered(
      () =>
        new Promise<ThreadListOutcome>((resolve) => {
          pending.push(resolve);
        }),
    );
    await waitFor(() => expect(pending.length).toBeGreaterThanOrEqual(2));
    // 每一次列表請求都還沒回來的時候，全域下行說 a 跑完了。
    feed.line().push({ type: 'status', threadId: 'a', running: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const resolve of pending) resolve(ok(row('a', '改登入頁', true)));

    const target = await rowOf('改登入頁');
    await waitFor(() => expect(statusOf(target)).toBe('completed'));
  });

  it('清單說空白、全域下行說在跑的那條：照樣列出來，排在日期組、不在空白區（#1600）', async () => {
    const feed = rendered(async () => ({
      kind: 'ok',
      result: {
        unreadable: 0,
        items: [{ threadId: 'b', updatedAt: Date.now(), running: false, blank: true }],
      },
    }));
    const list = await screen.findByRole('group', { name: '以前的會話' });
    await waitFor(() => expect(feed.line()).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 別的分頁的空白會話不列（只列目前這條）。
    expect(within(list).queryByRole('button', { name: new RegExp(BLANK_THREAD_LABEL) })).toBeNull();

    feed.line().push({ type: 'status', threadId: 'b', running: true });

    const today = await within(list).findByRole('group', { name: '今天' });
    const target = await within(today).findByRole('button', {
      name: new RegExp(BLANK_THREAD_LABEL),
    });
    expect(statusOf(target)).toBe('running');
    // 只出現在日期組那一次：空白區沒有它。
    const named = { name: new RegExp(BLANK_THREAD_LABEL) };
    expect(within(list).getAllByRole('button', named)).toHaveLength(
      within(today).getAllByRole('button', named).length,
    );
  });
});

/**
 * `@` 引用（[#653](https://github.com/DemianLi/nexus-agent/issues/653)）接上畫面：列檔綁在目前這條 thread 上，
 * 新對話第一句送出之前就能用。選單本身驗在 `components/composer.test.tsx`。
 */
describe('@ 引用', () => {
  beforeEach(stubCmdkLayout);

  it('新對話還沒講話就能打 @：查的是目前這條、選了之後原樣送出', async () => {
    setSeq(0);
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
 * 泡泡畫成引用（同專案的會話是點得開的連結）、重新整理後還在、被拒絕時說出原因。
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
    setSeq(0);
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

  it('被領走之後畫成引用：同專案的會話點了切過去，別的專案與子代理只顯示', async () => {
    setSeq(0);
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

  it('重新整理（歷史回來的人話帶 references）也畫成引用', async () => {
    setSeq(0);
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
    setSeq(0);
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
    setSeq(0);
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
    setSeq(0);
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
    setSeq(0);
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
    setSeq(0);
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
    setSeq(0);
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

  /** 送出一句、不等它畫出來：`runStart` 可能還掛著。 */
  async function sendWithoutWaiting(text: string): Promise<void> {
    await waitFor(() => expect(screen.getByPlaceholderText('說點什麼…')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('要說的話'), { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
  }

  it('送出了、伺服器的回音還沒到就按：照樣換過去，不必按第二次（#1600）', async () => {
    setSeq(0);
    localStorage.setItem(REMEMBERED_THREAD_KEY, JSON.stringify({ threadId: '上一條' }));
    const fake = fakeClient([]);
    const { client, state } = gated(fake, LISTED);
    render(<App client={{ ...client, runStart: () => new Promise<never>(() => undefined) }} />);
    // 側欄的清單掛上來讀的那一次；下面驗的是「新對話」自己讀了一次。
    await waitFor(() => expect(state.reads).toBe(1));
    await sendWithoutWaiting('記一筆。');

    fireEvent.click(screen.getByRole('button', { name: '新對話' }));

    await waitFor(() => expect(fake.opened).toEqual(['上一條', '空白那條']));
    expect(state.reads).toBeGreaterThanOrEqual(2);
  });

  it('送出被伺服器拒絕之後按：仍是空白，留在原地（#1600，照 dsh）', async () => {
    setSeq(0);
    const fake = fakeClient([]);
    const { client, state } = gated(fake, LISTED);
    const runStart: WireClient['runStart'] = async () => ({
      type: 'error',
      id: 1,
      error: 'invalid_argument',
      message: '收不了',
    });
    render(<App client={{ ...client, runStart }} />);
    await waitFor(() => expect(state.reads).toBe(1));
    await sendWithoutWaiting('記一筆。');
    await settle();

    fireEvent.click(screen.getByRole('button', { name: '新對話' }));
    await settle();

    expect(state.reads).toBe(1);
    expect(fake.opened).toHaveLength(1);
  });

  it('送出斜線命令之後按：它不起一輪，留在原地（#1600）', async () => {
    setSeq(0);
    // 開頭的字在命令清單上才是命令（#1929）；列上之後打 `/` 會開選單。
    stubCmdkLayout();
    const fake = fakeClient([], { commands: [{ name: 'whatever', description: '隨便' }] });
    const { client, state } = gated(fake, LISTED);
    render(<App client={client} />);
    await waitFor(() => expect(state.reads).toBe(1));
    await sendWithoutWaiting('/whatever');
    await waitFor(() => expect(fake.slashed).toEqual(['/whatever']));
    await settle();

    fireEvent.click(screen.getByRole('button', { name: '新對話' }));
    await settle();

    expect(state.reads).toBe(1);
    expect(fake.opened).toHaveLength(1);
  });

  it('清單說空白、全域下行說在跑的那條不挑：別的分頁正在用它（#1600）', async () => {
    setSeq(0);
    localStorage.setItem(REMEMBERED_THREAD_KEY, JSON.stringify({ threadId: '上一條' }));
    const fake = fakeClient([frame('lifecycle', [], { event: 'completed', graph_name: 'root' })]);
    const { client } = gated(fake, LISTED);
    const openThreadFeed: WireClient['openThreadFeed'] = async () =>
      (async function* stream() {
        yield { type: 'status', threadId: '空白那條', running: true } as const;
        await new Promise<never>(() => undefined);
      })();
    render(<App client={{ ...client, openThreadFeed }} />);
    await sayOnce();

    fireEvent.click(screen.getByRole('button', { name: '新對話' }));

    await waitFor(() => expect(fake.opened).toEqual(['上一條', '更舊的空白']));
  });

  it('連不上的 thread：畫面是空的也不算空白，新對話走得出去', async () => {
    setSeq(0);
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
    setSeq(0);
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
    setSeq(0);
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
    setSeq(0);
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

describe('用量環（#528；#1591 換成 SG 的 ContextRing）', () => {
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

  it('畫在輸入框底下那一列的右邊（SG 的 ComposerFooter，#1591），數字來自線上', async () => {
    setSeq(0);
    const { client } = fakeClient(pressureFrames());
    render(<App client={client} />);

    const meter = await screen.findByRole('button', { name: '對話用量：約 75%，點開看明細' });
    expect(meter.closest('[data-slot="composer-footer-end"]')).not.toBeNull();
    expect(meter.closest('[data-slot="composer"]')).toBeNull();
    // 這一輪在跑，送出的說明換成兩種送法（#710），只給報讀：掛在輸入框的描述上（#1591）。
    const describedBy = screen.getByLabelText('要說的話').getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toMatch(
      /^Enter 排隊・(⌘|Ctrl\+)Enter 插話$/,
    );
    fireEvent.click(meter);
    expect(screen.getByTestId('context-meter-input').textContent).toBe('4,321 token');
  });

  it('點開明細之後底下換成核准面板：明細跟著關，不浮在面板上', async () => {
    setSeq(0);
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

    fireEvent.click(await screen.findByRole('button', { name: /^對話用量：/ }));
    expect(screen.getByRole('dialog', { name: '對話用量' })).toBeTruthy();
    release();
    await screen.findByTestId('approval-card');
    expect(screen.queryByRole('dialog', { name: '對話用量' })).toBeNull();
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
    setSeq(0);
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
    setSeq(0);
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
    setSeq(0);
    const { client } = fakeClient([
      ...textFrames('root-1', ['model_request:a'], '目標排的一輪。'),
      frame('lifecycle', [], { event: 'completed', graph_name: 'root' }),
    ]);
    render(<App client={client} />);
    await waitFor(() => expect(heading().textContent).toBe(UNTITLED_THREAD_LABEL));
    await waitFor(() => expect(document.title).toBe('nexus-agent'));
  });

  it('卸掉時分頁標題還原成產品名', async () => {
    setSeq(0);
    const { client } = fakeClient([
      frame('custom', [], { name: TITLE, payload: { title: '要走的那條' } }),
    ]);
    const { unmount } = render(<App client={client} />);
    await waitFor(() => expect(document.title).toBe('要走的那條 — nexus-agent'));
    unmount();
    expect(document.title).toBe('nexus-agent');
  });
});

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
    setSeq(0);
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

    fireEvent.click(screen.getByRole('button', { name: '只停這個子代理' }));
    expect(interrupt).toHaveBeenCalledExactlyOnceWith(fake.opened[0], 'bg-1');

    // 下一份快照整份取代：翻成閒著，狀態字與輸入框跟著換；停止鈕恢復成不可按。
    fake.downlink.push(fake.opened[0]!, [statusFrame([{ runId: 'bg-1', status: 'idle' }])]);
    await waitFor(() => expect(within(card).getByText('閒著')).toBeTruthy());
    expect((screen.getByLabelText('對背景子代理說話') as HTMLInputElement).placeholder).toContain(
      '喚醒',
    );
    expect(
      (screen.getByRole('button', { name: '只停這個子代理' }) as HTMLButtonElement).disabled,
    ).toBe(true);

    // 空快照＝收線。
    fake.downlink.push(fake.opened[0]!, [statusFrame([])]);
    await waitFor(() => expect(within(card).getByText('已收線')).toBeTruthy());
    expect((screen.getByLabelText('對背景子代理說話') as HTMLInputElement).disabled).toBe(true);
  });

  /**
   * 第一次開線吐完委派卡與狀態快照就收掉（一般的斷線），之後每次重開都拋 `reopen()` 給的錯。畫面留著那張委派卡（重連失敗不清畫面），
   * 展開它，讀子代理面板的灰字（#1876）。
   */
  async function panelAfterReopenFails(reopen: () => Error): Promise<HTMLInputElement> {
    setSeq(0);
    const fake = fakeClient([]);
    const frames = delegated([{ runId: 'bg-1', status: 'running' }]);
    let calls = 0;
    const openEvents: WireClient['openEvents'] = async () => {
      calls += 1;
      if (calls === 1) {
        return (async function* () {
          yield* frames;
        })();
      }
      throw reopen();
    };
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(<App client={{ ...fake.client, openEvents }} />);
    const card = await screen.findByTestId('tool-entry');
    await waitFor(() => expect(calls).toBeGreaterThanOrEqual(2), { timeout: 5_000 });
    fireEvent.click(within(card).getAllByRole('button')[0]!);
    return screen.getByLabelText('對背景子代理說話') as HTMLInputElement;
  }

  const tooDeep = () => {
    const serverMessage = '這條 thread 建不起來：日誌第 3 顆事件巢狀 3000 層，超過上限 600';
    const body = JSON.stringify({
      type: 'error',
      id: null,
      error: THREAD_HISTORY_TOO_DEEP,
      message: serverMessage,
    });
    return new WireRejectedError(THREAD_HISTORY_TOO_DEEP, serverMessage, `下行被拒：${body}`);
  };

  it('重連時伺服器送來看不懂的資料（#1876）：子代理面板跟主送出框講停住那一句', async () => {
    const input = await panelAfterReopenFails(
      () => new WireProtocolError('params', '下行事件的 params 必須是物件'),
    );
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(THREAD_PROTOCOL_ERROR_TEXT),
    );
    expect(input.placeholder).toBe(HALTED_PLACEHOLDER);
  });

  it('重連時歷史太深被拒（#1876）：子代理面板講打不開那一句', async () => {
    const input = await panelAfterReopenFails(tooDeep);
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(THREAD_HISTORY_TOO_DEEP_TEXT),
    );
    expect(input.placeholder).toBe(REFUSED_PLACEHOLDER);
  });

  it('重連時 thread 數滿了（#1876）：背景還在重試，子代理面板照舊講連線中', async () => {
    const input = await panelAfterReopenFails(() => {
      const message = 'thread 數已到上限 2／2；重啟 serve 才會釋放';
      const body = JSON.stringify({ type: 'error', id: null, error: THREAD_AT_CAPACITY, message });
      return new WireRejectedError(THREAD_AT_CAPACITY, message, `下行被拒：${body}`);
    });
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain(THREAD_AT_CAPACITY_TEXT),
    );
    expect(input.placeholder).toBe('連線中…');
  });

  it('用量鈕的「看明細」打開成本分頁：主對話讀總帳、背景子代理各讀自己那份（#1032），不經委派卡的展開', async () => {
    setSeq(0);
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
    setSeq(0);
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
