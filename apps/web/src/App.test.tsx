/** `App` 的畫面測試：對話介面：送出與回覆、核准、斜線命令、目標與計劃標籤、停止、上行被拒、提問面板。共用的假 client 與 hook 在 `@/test/app-harness.fixture`。 */
import type {
  CommandOutcome,
  Event,
  GoalPauseResult,
  SkillEntry,
  SlashDescriptor,
  SlashRunOutcome,
  RunStartMode,
  UplinkResult,
  WireClient,
  WireGoal,
} from '@nexus/wire';
import {
  GOAL,
  GOAL_ACTIVATION,
  PLAN_MODE,
  THREAD_AT_CAPACITY,
  THREAD_HISTORY_TOO_DEEP,
  THREAD_IS_SUBAGENT,
  UplinkTransportError,
  WireProtocolError,
  WireRejectedError,
} from '@nexus/wire';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App, inputPlaceholder, RESUMED_THREAD_NOTICE, STOP_QUESTIONS_LABEL } from '@/App';
import { NO_DECISION_REASON } from '@/components/approval-card';
import { commandsFailedText } from '@/hooks/use-conversation';
import { connectionStall, HALTED_PLACEHOLDER, REFUSED_PLACEHOLDER } from '@/lib/connection-stall';
import { STOPPED_QUESTION_TEXT } from '@/lib/question-view';
import { REMEMBERED_THREAD_KEY } from '@/lib/remembered-thread';
import { PARKED_STEER_TEXT, PENDING_STEER_TEXT } from '@/lib/steer-view';
import { THREAD_AT_CAPACITY_TEXT } from '@/lib/thread-capacity';
import { THREAD_HISTORY_TOO_DEEP_TEXT } from '@/lib/thread-history-too-deep';
import { THREAD_PROTOCOL_ERROR_TEXT } from '@/lib/thread-protocol-error';
import { THREAD_IS_SUBAGENT_TEXT } from '@/lib/thread-subagent';
import { axeViolations } from '@/test/axe';
import { stubCmdkLayout } from '@/test/cmdk';
import { UNWIRED_WIRE_CONTRACT } from '@/test/wire-contract';
import {
  PANEL_WAIT,
  SILENT_THREAD_FEED,
  UNWIRED_FEEDBACK,
  UNWIRED_FILE_REFERENCES,
  UNWIRED_QUEUE,
  UNWIRED_SESSION_REFERENCES,
  UNWIRED_SUBAGENT,
  UNWIRED_THREAD_LIST,
  UNWIRED_THREAD_SEARCH,
  WITHDRAWN_TEXT,
  approvalFrame,
  attachmentGate,
  fakeClient,
  findPanel,
  frame,
  freeAnswer,
  questionFrame,
  questionPanel,
  setSeq,
  stoppedQuestionFrames,
  textFrames,
  toastWith,
} from '@/test/app-harness.fixture';

// `serverSupportsAttachments` 的真實作回 true（#733）；這裡接到 `attachmentGate`，預設關著。這一檔沒有測試打開它。
vi.mock('@/lib/attachments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/attachments')>()),
  serverSupportsAttachments: () => attachmentGate.on,
}));

describe('對話介面', () => {
  it('伺服器不收附件時沒有加入鈕，貼上檔案照瀏覽器本來的行為（#733）', async () => {
    setSeq(0);
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
    setSeq(0);
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
    setSeq(0);
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

  it('頂列的側欄、主題、右側欄三顆鈕用 SG 36px 圖示鈕的 rounded-md，不是圓形（#1696 G2）', async () => {
    const { client } = fakeClient([]);
    const { container } = render(<App client={client} />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('就緒'));
    const header = container.querySelector('header')!;
    const buttons = [
      within(header).getByRole('button', { name: '開關側欄' }),
      within(header).getByRole('button', { name: /^目前：/ }),
      within(header).getByRole('button', { name: /右側欄$/ }),
    ];
    // 兩顆是 `icon-sm`（自帶 `rounded-sm`），要被頂列給的 `rounded-md` 蓋掉，三顆才一樣。
    for (const button of buttons) {
      const radius = button.className.split(' ').filter((c) => c.startsWith('rounded-'));
      expect(radius).toEqual(['rounded-md']);
    }
  });

  /**
   * 人的話**等開跑才畫**（#645）：伺服器收下就進送出佇列，領走開跑那一顆 `inbox` 帶 `claimed`，泡泡由它畫——跑著時
   * 送的那句才不會插進正在跑的那一輪中間。送出當下什麼都不畫。
   */
  it('人的話等開跑才畫：送出當下不畫，伺服器領走那一顆到了才畫', async () => {
    setSeq(0);
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
    setSeq(0);
    stubCmdkLayout();
    const fake = fakeClient([frame('lifecycle', [], { event: 'running', graph_name: 'root' })], {
      // `/feedback` 在真的伺服器上也列（回饋插件登記的命令），命令認不認得照這份清單（#1929）。
      commands: [
        { name: 'plan', description: '計劃模式', input: { hint: '[on|off]' } },
        { name: 'feedback', description: '回饋' },
      ],
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
    const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

    // 跑著時送不出去的那一行：主按鈕是停止（dsh `InputBar.tsx` 的 `blocked`，#1591）。
    fireEvent.change(input, { target: { value: '/plan' } });
    expect(screen.queryByRole('button', { name: '送出' })).toBeNull();
    expect(button('停止').disabled).toBe(false);
    // 命令照舊叫「送出」，不說排隊（dsh 的 `plainMessageDraft`）。
    fireEvent.change(input, { target: { value: '/feedback' } });
    expect(button('送出').disabled).toBe(false);

    fireEvent.change(input, { target: { value: '下一句' } });
    expect(button('排隊送出').disabled).toBe(false);
    fireEvent.click(button('排隊送出'));

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
      setSeq(0);
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
      setSeq(0);
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
      setSeq(0);
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

    it('命令在途時整批插話不收（#1941，dsh `canSteerQueue` 排除 `machineBusy`）', async () => {
      stubCmdkLayout();
      setSeq(0);
      const made = steeringClient([
        frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
      ]);
      const holds: ((outcome: SlashRunOutcome) => void)[] = [];
      // 跑著也放行的那一行（有 input、宣告了 runWhileBusy，同出貨的 `/goal pause`）：按 Enter 進在途（#1941）。
      // 沒有 input 的 bare 命令不進在途（#1971），伺服器也不讓它宣告 runWhileBusy 的空字串。
      const client: WireClient = {
        ...made.client,
        slashList: async () => ({
          kind: 'ok',
          commands: [
            {
              name: 'goal',
              description: '目標',
              input: { hint: '[<目標>|pause]' },
              runWhileBusy: ['pause'],
            },
          ],
        }),
        slashRun: () => new Promise<SlashRunOutcome>((resolve) => holds.push(resolve)),
      };
      render(<App client={client} />);
      await waitFor(() => expect(screen.getByRole('status').textContent).toContain('執行中'));
      const input = screen.getByLabelText<HTMLTextAreaElement>('要說的話');
      fireEvent.change(input, { target: { value: '先讀設定' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(input.value).toBe(''));
      await screen.findByTestId('queue-dock');
      expect(input.placeholder).toBe('Cmd/Ctrl+Enter 把排著的全部改成插話');

      fireEvent.change(input, { target: { value: '/goal pause' } });
      fireEvent.keyDown(input, { key: 'Escape' });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(holds).toHaveLength(1));
      expect(input.readOnly).toBe(true);
      expect(input.placeholder).not.toBe('Cmd/Ctrl+Enter 把排著的全部改成插話');
      fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(made.updates).toEqual([]);

      holds[0]!({ kind: 'success', command_id: 'goal' });
      await waitFor(() => expect(input.placeholder).toBe('Cmd/Ctrl+Enter 把排著的全部改成插話'));
    });

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
      setSeq(0);
      const { client, modes } = steeringClient([
        frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
      ]);
      render(<App client={client} />);
      await waitFor(() => expect(screen.getByRole('status').textContent).toContain('執行中'));
      fireEvent.change(screen.getByLabelText('要說的話'), { target: { value: '下一句' } });
      // 名稱說出這一下是排隊（dsh 的 `primaryLabel`，#1591）。
      fireEvent.click(screen.getByRole('button', { name: '排隊送出' }));
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

  /** 第一次開下行被拒（`code` 是哪一個由測試給），之後照常；`thenEnds` 時第二次開好的那條立刻收掉。 */
  function refusedOnce(code: string, thenEnds = false) {
    setSeq(0);
    const fake = fakeClient([frame('lifecycle', [], { event: 'completed', graph_name: 'root' })]);
    let calls = 0;
    const openEvents: WireClient['openEvents'] = async (...args) => {
      calls += 1;
      if (calls === 1) {
        const body = JSON.stringify({
          type: 'error',
          id: null,
          error: code,
          message: 'thread 數已到上限 2／2；重啟 serve 才會釋放',
        });
        throw new WireRejectedError(
          code,
          'thread 數已到上限 2／2；重啟 serve 才會釋放',
          `下行被拒：${body}`,
        );
      }
      if (calls === 2 && thenEnds) {
        return (async function* () {})();
      }
      return fake.client.openEvents(...args);
    };
    return { ...fake.client, openEvents };
  }

  it('thread 數滿了（#1478）：狀態列講給使用者看的那一句，不接原文；重試接上之後回到正常', async () => {
    render(<App client={refusedOnce(THREAD_AT_CAPACITY)} />);

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(THREAD_AT_CAPACITY_TEXT),
    );
    expect(screen.queryByText(/2／2|重啟 serve|下行被拒/)).toBeNull();
    // 滿了是暫時的、背景在重試：送出框照舊講「連線中…」（#1865）。
    expect(screen.getByPlaceholderText('連線中…')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '立刻重連' }));
    await waitFor(() => expect(screen.getByPlaceholderText('說點什麼…')).toBeTruthy());
    await waitFor(() => expect(screen.queryByText(THREAD_AT_CAPACITY_TEXT)).toBeNull());
    expect(screen.getByRole('status').textContent).not.toContain('連不上');
  });

  it('滿了之後接上、下行又自己收掉（#1478）：講一般的斷線，不留上一次被拒的那一句', async () => {
    render(<App client={refusedOnce(THREAD_AT_CAPACITY, true)} />);

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(THREAD_AT_CAPACITY_TEXT),
    );
    fireEvent.click(screen.getByRole('button', { name: '立刻重連' }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('連線中斷，正在重新連線…'),
    );
  });

  it('開頁時模型座也滿了（#1483）：下行接回之後重讀，座位畫出來', async () => {
    let catalogCalls = 0;
    const modelCatalog: WireClient['modelCatalog'] = async () => {
      catalogCalls += 1;
      return catalogCalls === 1
        ? { kind: 'rejected', code: THREAD_AT_CAPACITY, message: 'thread 數已到上限 1／1' }
        : {
            kind: 'ok',
            result: {
              ok: true,
              value: {
                catalog: {
                  default: { modelId: 'model-a' },
                  models: [{ id: 'model-a', name: 'Alpha' }],
                },
                selection: { lastUsed: null, next: null },
              },
            },
          };
    };
    render(<App client={{ ...refusedOnce(THREAD_AT_CAPACITY), modelCatalog }} />);

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(THREAD_AT_CAPACITY_TEXT),
    );
    expect(screen.queryByTestId('model-seat')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '立刻重連' }));
    expect(await screen.findByTestId('model-seat')).toBeTruthy();
    expect(catalogCalls).toBe(2);
  });

  it('下行沒斷過（#1483 驗收 B）：開頁時讀的三樣各只請求一次，跟以前一樣', async () => {
    setSeq(0);
    const fake = fakeClient([frame('lifecycle', [], { event: 'completed', graph_name: 'root' })]);
    const modelCatalog = vi.fn(fake.client.modelCatalog);
    const permissionCatalog = vi.fn(fake.client.permissionCatalog);
    const subagentList = vi.fn(fake.client.subagentList);
    render(<App client={{ ...fake.client, modelCatalog, permissionCatalog, subagentList }} />);

    await screen.findByPlaceholderText('說點什麼…');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect([
      modelCatalog.mock.calls.length,
      permissionCatalog.mock.calls.length,
      subagentList.mock.calls.length,
    ]).toEqual([1, 1, 1]);
  });

  it('續開記住的會話被拒（#1483 驗收 E）：不講「接著上一次」；接上之後照舊講', async () => {
    localStorage.setItem(REMEMBERED_THREAD_KEY, JSON.stringify({ threadId: '記住的那條' }));
    render(<App client={refusedOnce(THREAD_AT_CAPACITY)} />);

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(THREAD_AT_CAPACITY_TEXT),
    );
    expect(screen.queryByText(RESUMED_THREAD_NOTICE)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '立刻重連' }));
    expect(await screen.findByText(RESUMED_THREAD_NOTICE)).toBeTruthy();
  });

  it('記住的是子代理的會話（#1708，localStorage 被改過）：講那一句，沒有重連鈕、不接原文，也不再開', async () => {
    localStorage.setItem(REMEMBERED_THREAD_KEY, JSON.stringify({ threadId: '記住的那條/1' }));
    const fake = fakeClient([]);
    const serverMessage =
      '"記住的那條/1" 是子代理的會話，不能當一條 thread 開；要對它說話，請從它的主對話用 subagent.send。';
    const openEvents = vi.fn<WireClient['openEvents']>(async () => {
      const body = JSON.stringify({
        type: 'error',
        id: null,
        error: THREAD_IS_SUBAGENT,
        message: serverMessage,
      });
      throw new WireRejectedError(THREAD_IS_SUBAGENT, serverMessage, `下行被拒：${body}`);
    });
    render(<App client={{ ...fake.client, openEvents }} />);

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(THREAD_IS_SUBAGENT_TEXT),
    );
    // 送出框不講「連線中…」：不會再接回（#1865）。
    expect(screen.getByPlaceholderText(REFUSED_PLACEHOLDER)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '立刻重連' })).toBeNull();
    expect(screen.queryByText(/subagent\.send|下行被拒/)).toBeNull();
    expect(screen.queryByText(RESUMED_THREAD_NOTICE)).toBeNull();
    // 第一次退避最多 500ms：等過去，下行仍只開過一次。
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(openEvents).toHaveBeenCalledOnce();
  });

  it('記住的會話歷史太深（#1753）：講那一句，沒有重連鈕、不接原文，也不再開', async () => {
    localStorage.setItem(REMEMBERED_THREAD_KEY, JSON.stringify({ threadId: '記住的那條' }));
    const fake = fakeClient([]);
    const serverMessage = '這條 thread 建不起來：日誌第 3 顆事件巢狀 3000 層，超過上限 600';
    const openEvents = vi.fn<WireClient['openEvents']>(async () => {
      const body = JSON.stringify({
        type: 'error',
        id: null,
        error: THREAD_HISTORY_TOO_DEEP,
        message: serverMessage,
      });
      throw new WireRejectedError(THREAD_HISTORY_TOO_DEEP, serverMessage, `下行被拒：${body}`);
    });
    render(<App client={{ ...fake.client, openEvents }} />);

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(THREAD_HISTORY_TOO_DEEP_TEXT),
    );
    // 送出框不講「連線中…」：不會再接回（#1865）。
    expect(screen.getByPlaceholderText(REFUSED_PLACEHOLDER)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '立刻重連' })).toBeNull();
    expect(screen.queryByText(/建不起來|下行被拒|上限 600/)).toBeNull();
    expect(screen.queryByText(RESUMED_THREAD_NOTICE)).toBeNull();
    // 第一次退避最多 500ms：等過去，下行仍只開過一次。
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(openEvents).toHaveBeenCalledOnce();
  });

  it('伺服器送來看不懂的資料（#1601）：送出框講停住那一句；按「立刻重連」接上之後回到一般的灰字（#1865）', async () => {
    const fake = fakeClient([frame('lifecycle', [], { event: 'completed', graph_name: 'root' })]);
    let calls = 0;
    const openEvents: WireClient['openEvents'] = async (...args) => {
      calls += 1;
      // 怎麼認出這種錯在 `use-conversation-reconnect.test.tsx` 用真的 client 驗過；這裡驗 App 的接線，拋替身就夠。
      if (calls === 1) throw new WireProtocolError('params', '下行事件的 params 必須是物件');
      return fake.client.openEvents(...args);
    };
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(<App client={{ ...fake.client, openEvents }} />);

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(THREAD_PROTOCOL_ERROR_TEXT),
    );
    expect(screen.getByPlaceholderText(HALTED_PLACEHOLDER)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '立刻重連' }));
    await waitFor(() => expect(screen.getByPlaceholderText('說點什麼…')).toBeTruthy());
  });

  it('下行被拒但不是滿了（#1478）：照舊講連不上與原因', async () => {
    render(<App client={refusedOnce('unknown_error')} />);

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('連不上 agent：下行被拒：'),
    );
    expect(screen.queryByText(THREAD_AT_CAPACITY_TEXT)).toBeNull();
  });
});

describe('核准請求', () => {
  it('畫出來、按下去，而且一個決定送滿整批', async () => {
    setSeq(0);
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
    setSeq(0);
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
    setSeq(0);
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
    setSeq(0);
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
    setSeq(0);
    const { client, responded } = fakeClient([
      approvalFrame([{ name: 'alpha', allowed: ['approve', 'reject'] }], 'int-1'),
      approvalFrame([{ name: 'beta', allowed: ['approve', 'reject'] }], 'int-2'),
    ]);
    render(<App client={client} />);

    // 先來的那顆先畫；只有一個面板。
    const first = await findPanel('等待核准：alpha（1／2）');
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
    const second = await findPanel('等待核准：beta');
    expect(screen.getByRole('status').textContent).toBe('等待核准：beta');
    fireEvent.click(within(second).getByRole('button', { name: '全部核准' }));
    await waitFor(() => expect(responded.length).toBe(2));
    expect(responded[1]).toMatchObject({ interrupt_id: 'int-2' });
  });

  it('兩張裡有一張沒有出路時也不解鎖：按得動的先處理，輪到它時面板上有「停止這一輪」', async () => {
    // 以前取 `some` 解鎖送出框（`stuck`）；那是假出口（送出去撞上「停在核准點」），#409 拿掉了。
    setSeq(0);
    const { client, responded } = fakeClient([
      approvalFrame([{ name: 'alpha', allowed: ['approve', 'reject'] }], 'int-1'),
      approvalFrame([{ name: 'beta', allowed: [] }], 'int-2'),
    ]);
    render(<App client={client} />);

    const first = await findPanel('等待核准：alpha（1／2）');
    fireEvent.change(screen.getByLabelText('要說的話'), { target: { value: '換條路' } });
    expect(
      screen.getByRole('button', { name: '送出', hidden: true }).hasAttribute('disabled'),
    ).toBe(true);

    fireEvent.click(within(first).getByRole('button', { name: '全部核准' }));
    await waitFor(() => expect(responded).toHaveLength(1));
    const second = await findPanel('等待核准：beta');
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
    setSeq(0);
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
    setSeq(0);
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
    setSeq(0);
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
    // 留在草稿裡的那一行送不出去：主按鈕是停止，不是送出（dsh 的 `blocked`，#1591）。
    expect(screen.queryByRole('button', { name: '送出' })).toBeNull();
    expect(screen.getByRole('button', { name: '停止' })).toBeTruthy();
  });

  it('開頭的字是清單上的命令就走 slash.run，而且不進 transcript', async () => {
    setSeq(0);
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

  it('清單上有、伺服器卻說不認得：說「不認得」，不是靜靜送給模型', async () => {
    setSeq(0);
    // 清單上沒有的 `/nope` 是一句話、送給模型（#1929，見「開頭的字」那一組）；「不認得」只剩清單與伺服器對不上的這一種。
    const { client, sent } = fakeClient([], {
      commands: [{ name: 'nope', description: '剛被移掉的命令' }],
      run: () => ({ kind: 'unknown' }),
    });
    render(<App client={client} />);

    await waitFor(() => expect(screen.getByPlaceholderText('說點什麼…')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('要說的話'), { target: { value: '/nope' } });
    fireEvent.click(screen.getByRole('button', { name: '送出' }));

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('不認得這個命令'));
    expect(sent).toEqual([]);
  });

  it('命令自己失敗與這條線拒絕發派，說出來的話不一樣', async () => {
    setSeq(0);
    const { client } = fakeClient([], {
      commands: [planCommand],
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

describe('開頭的字是命令才走 slash.run，其餘送給模型（#1929，#1574 Q2 (a)）', () => {
  const planCommand: SlashDescriptor = { name: 'plan', description: '進出計劃模式。' };
  const deploy: SkillEntry = {
    name: 'deploy',
    description: '部署到預備環境',
    modelInvocable: false,
  };
  const normal: SkillEntry = { name: 'normal', description: '整理週報', modelInvocable: true };
  const skillList: WireClient['skillList'] = async () => ({
    kind: 'ok',
    skills: [deploy, normal],
  });

  beforeEach(stubCmdkLayout);

  const input = () => screen.getByLabelText<HTMLTextAreaElement>('要說的話');
  /** 打一行、按送出鈕（選單開著也一樣送）。 */
  const sendLine = (line: string) => {
    fireEvent.change(input(), { target: { value: line } });
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
  };
  /** 等命令清單到：打 `/` 看得到 `/plan`，再清掉。 */
  async function commandsListed() {
    await screen.findByPlaceholderText('說點什麼…');
    fireEvent.change(input(), { target: { value: '/' } });
    await within(await screen.findByRole('listbox')).findByText('/plan');
    fireEvent.change(input(), { target: { value: '' } });
  }

  it('紅燈 4：「/plan」照舊走 slash.run；「/deploy 今天」原字串送給模型、不走 slash.run', async () => {
    setSeq(0);
    const fake = fakeClient([], {
      commands: [planCommand],
      run: () => ({ kind: 'success', command_id: 'c' }),
    });
    render(<App client={{ ...fake.client, skillList }} />);
    await commandsListed();

    sendLine('/plan');
    await waitFor(() => expect(fake.slashed).toEqual(['/plan']));
    expect(fake.sent).toEqual([]);

    sendLine('/deploy 今天');
    await waitFor(() => expect(fake.sent).toEqual(['/deploy 今天']));
    expect(fake.slashed).toEqual(['/plan']);
  });

  it('打錯的 /plna 也是一句話，送給模型（Q2 (a)）', async () => {
    setSeq(0);
    const fake = fakeClient([], { commands: [planCommand] });
    render(<App client={fake.client} />);
    await commandsListed();

    sendLine('/plna');
    await waitFor(() => expect(fake.sent).toEqual(['/plna']));
    expect(fake.slashed).toEqual([]);
  });

  it('清單在途時送出：兩條都先不走，等清單到了才路由（dsh 的 strong-wait）', async () => {
    setSeq(0);
    const fake = fakeClient([], {
      commands: [planCommand],
      run: () => ({ kind: 'success', command_id: 'c' }),
    });
    let arrive: (() => void) | undefined;
    const slashList: WireClient['slashList'] = () =>
      new Promise((resolve) => {
        arrive = () => resolve({ kind: 'ok', commands: [planCommand] });
      });
    render(<App client={{ ...fake.client, slashList }} />);
    await screen.findByPlaceholderText('說點什麼…');
    await waitFor(() => expect(arrive).toBeDefined());

    sendLine('/plan');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.sent).toEqual([]);
    expect(fake.slashed).toEqual([]);

    arrive!();
    await waitFor(() => expect(fake.slashed).toEqual(['/plan']));
    expect(fake.sent).toEqual([]);
  });

  it('一行在等清單認的期間再送：都不發；清單到了只送第一行（dsh `adjudicating` 時 Enter 不動作）', async () => {
    setSeq(0);
    const fake = fakeClient([], {
      commands: [planCommand],
      run: () => ({ kind: 'success', command_id: 'c' }),
    });
    let arrive: (() => void) | undefined;
    const slashList: WireClient['slashList'] = () =>
      new Promise((resolve) => {
        arrive = () => resolve({ kind: 'ok', commands: [planCommand] });
      });
    render(<App client={{ ...fake.client, slashList }} />);
    await screen.findByPlaceholderText('說點什麼…');
    await waitFor(() => expect(arrive).toBeDefined());

    sendLine('/plan');
    // 在等的時候草稿不動（還沒 commit）。
    expect(input().value).toBe('/plan');
    sendLine('幫我規劃');
    fireEvent.keyDown(input(), { key: 'Enter' });
    sendLine('/plan');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.sent).toEqual([]);
    expect(fake.slashed).toEqual([]);

    arrive!();
    await waitFor(() => expect(fake.slashed).toEqual(['/plan']));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.slashed).toEqual(['/plan']);
    expect(fake.sent).toEqual([]);
  });

  it('等清單認的期間文字框唯讀：草稿照樣看得到、打字不進去；認完才放開（dsh `editable` 排除 `machineBusy`）', async () => {
    setSeq(0);
    const fake = fakeClient([], { commands: [planCommand] });
    let arrive: (() => void) | undefined;
    const slashList: WireClient['slashList'] = () =>
      new Promise((resolve) => {
        arrive = () => resolve({ kind: 'ok', commands: [planCommand] });
      });
    render(<App client={{ ...fake.client, slashList }} />);
    await screen.findByPlaceholderText('說點什麼…');
    await waitFor(() => expect(arrive).toBeDefined());
    expect(input().readOnly).toBe(false);

    sendLine('/plna 試試');
    expect(input().readOnly).toBe(true);
    expect(input().value).toBe('/plna 試試');
    fireEvent.change(input(), { target: { value: '/plna 改了' } });
    expect(input().value).toBe('/plna 試試');

    arrive!();
    await waitFor(() => expect(fake.sent).toEqual(['/plna 試試']));
    await waitFor(() => expect(input().readOnly).toBe(false));
    expect(input().value).toBe('');
  });

  it('等清單認的期間 / 選單收起：游標移回 / 那一段也不開（#1929，dsh `popup.dismiss()` 並凍結觸發）', async () => {
    setSeq(0);
    const fake = fakeClient([], { commands: [planCommand] });
    let arrive: (() => void) | undefined;
    const slashList: WireClient['slashList'] = () =>
      new Promise((resolve) => {
        arrive = () => resolve({ kind: 'ok', commands: [planCommand] });
      });
    render(<App client={{ ...fake.client, slashList, skillList }} />);
    await screen.findByPlaceholderText('說點什麼…');
    await waitFor(() => expect(arrive).toBeDefined());
    // 技能列到了：沒鎖時游標在 `/` 後面就列得出 /deploy。
    fireEvent.change(input(), { target: { value: '/' } });
    await within(await screen.findByRole('listbox')).findByText('/deploy');

    sendLine('/plna 試試');
    expect(input().readOnly).toBe(true);
    act(() => input().setSelectionRange(1, 1));
    fireEvent.select(input());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByRole('listbox')).toBeNull();

    arrive!();
    await waitFor(() => expect(fake.sent).toEqual(['/plna 試試']));
  });

  it('命令清單抓失敗：送出時重抓一次，還是失敗才退回、說出原因；不是 / 開頭的照常送', async () => {
    setSeq(0);
    const fake = fakeClient([], { commands: [planCommand] });
    const slashList = vi.fn<WireClient['slashList']>(async () => ({
      kind: 'rejected',
      message: '清單讀不出來',
    }));
    render(<App client={{ ...fake.client, slashList }} />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('清單讀不出來'));
    expect(slashList).toHaveBeenCalledTimes(1);

    sendLine('/plan');
    const card = await toastWith(commandsFailedText('清單讀不出來'));
    expect(card.textContent).toContain('這一句沒送出去');
    expect(slashList).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(input().value).toBe('/plan'));
    expect(fake.sent).toEqual([]);
    expect(fake.slashed).toEqual([]);

    sendLine('一句話');
    await waitFor(() => expect(fake.sent).toEqual(['一句話']));
  });

  it('第一次抓失敗、送出時重抓成功：這一句照清單路由，送得出去', async () => {
    setSeq(0);
    const fake = fakeClient([], {
      commands: [planCommand],
      run: () => ({ kind: 'success', command_id: 'c' }),
    });
    const slashList = vi
      .fn<WireClient['slashList']>()
      .mockResolvedValueOnce({ kind: 'rejected', message: '清單讀不出來' })
      .mockResolvedValue({ kind: 'ok', commands: [planCommand] });
    render(<App client={{ ...fake.client, slashList }} />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('清單讀不出來'));

    sendLine('/plan');
    await waitFor(() => expect(fake.slashed).toEqual(['/plan']));
    expect(slashList).toHaveBeenCalledTimes(2);
    expect(fake.sent).toEqual([]);
  });

  it('跑著時：技能那一行跟一句話一樣能排隊；命令照舊送不出去', async () => {
    setSeq(0);
    const fake = fakeClient([frame('lifecycle', [], { event: 'running', graph_name: 'root' })], {
      commands: [planCommand],
    });
    render(<App client={{ ...fake.client, skillList }} />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('執行中'));
    fireEvent.change(input(), { target: { value: '/' } });
    await within(await screen.findByRole('listbox')).findByText('/plan');

    fireEvent.change(input(), { target: { value: '/deploy 今天' } });
    const queue = screen.getByRole('button', { name: '排隊送出' }) as HTMLButtonElement;
    expect(queue.disabled).toBe(false);
    fireEvent.change(input(), { target: { value: '/plan' } });
    expect(screen.queryByRole('button', { name: '送出' })).toBeNull();
    expect(screen.queryByRole('button', { name: '排隊送出' })).toBeNull();
  });

  it('紅燈 5：打 /de，候選有 deploy，描述帶「只給人叫」；選了在草稿落成「/deploy 」', async () => {
    setSeq(0);
    const fake = fakeClient([], { commands: [planCommand] });
    render(<App client={{ ...fake.client, skillList }} />);
    await commandsListed();

    // 空查詢：命令一組在前、技能一組在後，各有段標題；一般技能不帶標記。
    fireEvent.change(input(), { target: { value: '/' } });
    const all = await screen.findByRole('listbox');
    await within(all).findByText('/deploy');
    expect(
      within(all)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['/plan進出計劃模式。', '/deploy只給人叫 · 部署到預備環境', '/normal整理週報']);
    expect(within(all).getByText('命令')).toBeTruthy();
    expect(within(all).getByText('技能')).toBeTruthy();

    fireEvent.change(input(), { target: { value: '/de' } });
    const listbox = await screen.findByRole('listbox');
    await waitFor(() =>
      expect(
        within(listbox)
          .getAllByRole('option')
          .map((option) => option.textContent),
      ).toEqual(['/deploy只給人叫 · 部署到預備環境']),
    );
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(input().value).toBe('/deploy ');
    expect(fake.slashed).toEqual([]);
    expect(fake.sent).toEqual([]);
  });

  it('技能清單拋錯（看不懂的資料）：只少了技能那一組，這條線不停、命令照常', async () => {
    setSeq(0);
    const fake = fakeClient([], {
      commands: [planCommand],
      run: () => ({ kind: 'success', command_id: 'c' }),
    });
    const broken: WireClient['skillList'] = async () => {
      throw new WireProtocolError(
        'skills[0].modelInvocable',
        'skill.list 的結果少了 modelInvocable',
      );
    };
    render(<App client={{ ...fake.client, skillList: broken }} />);
    await commandsListed();

    fireEvent.change(input(), { target: { value: '/' } });
    const listbox = await screen.findByRole('listbox');
    expect(
      within(listbox)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['/plan進出計劃模式。']);
    expect(within(listbox).queryByText('技能')).toBeNull();
    expect(screen.queryByText(THREAD_PROTOCOL_ERROR_TEXT)).toBeNull();

    sendLine('/plan');
    await waitFor(() => expect(fake.slashed).toEqual(['/plan']));
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
    setSeq(0);
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
    setSeq(0);
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
    setSeq(0);
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
    setSeq(0);
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

  it('按「退出」送一次 `/plan off`，成功了也不自己拿掉，等線上的值翻回關著；送出期間再按不送', async () => {
    setSeq(0);
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
    // 命令回來了、線上的值還沒翻：標籤還在，「退出」能再按。
    await waitFor(() => expect(chip()!.hasAttribute('disabled')).toBe(false));
    expect(slashed).toEqual(['/plan off']);

    downlink.push(opened[0]!, [planFrame(downlink, false)]);
    await waitFor(() => expect(chip()).toBeNull());
  });

  it('被拒、不認得、命令回錯誤：標籤留著，旁邊說出原因，不佔狀態列', async () => {
    setSeq(0);
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

  it('一輪跑著時標籤照畫、「退出」停用，提示說跑完才能關；收尾後恢復', async () => {
    setSeq(0);
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
    setSeq(0);
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
    // 只推了目標、沒推 activation（還沒收到，`null`）：照中性的寫，不說進行中（#1608）。
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

  it('active 時看 activation（#1608）：disarmed 講沒有在跑並給下一步，armed 寫進行中、那句消失', async () => {
    const { downlink, opened } = await mounted();
    const activationFrame = (activation: 'armed' | 'disarmed'): Event =>
      downlink.customFrame(GOAL_ACTIVATION, { goal: { id: 'g1', revision: 1, activation } });
    const hint = () => screen.queryByTestId('goal-resume-hint');

    downlink.push(opened[0]!, [goalFrame(downlink, wireGoal())]);
    await waitFor(() => expect(bar()).toBeTruthy());
    expect(hint()).toBeNull();

    downlink.push(opened[0]!, [activationFrame('disarmed')]);
    await waitFor(() => expect(hint()?.textContent).toBe('輸入 /goal resume 讓它繼續。'));
    expect(bar()!.textContent).toContain('目標：未完成，沒有在跑');
    expect(bar()!.getAttribute('aria-label')).toContain('/goal resume');
    // 暫停鈕照舊只看相位（Q1 (a)）。
    expect(screen.getByRole('button', { name: '暫停目標' })).toBeTruthy();

    downlink.push(opened[0]!, [activationFrame('armed')]);
    await waitFor(() => expect(bar()!.textContent).toContain('目標：進行中'));
    expect(hint()).toBeNull();
    expect(screen.getByRole('button', { name: '暫停目標' })).toBeTruthy();
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

  const pauseButton = () => screen.queryByRole('button', { name: '暫停目標' });

  /** 假 client 換上接了線的 `goalPause`（蓋掉 spread 進來的未接線預設），記下每一次帶的參數。 */
  async function mountedWithPause(
    reply: () => CommandOutcome<GoalPauseResult>,
    events: readonly Event[] = [],
    commands: readonly SlashDescriptor[] = [],
  ) {
    setSeq(0);
    const fake = fakeClient(events, { commands });
    const paused: { threadId: string; goalId: string; revision: number }[] = [];
    const client: WireClient = {
      ...fake.client,
      goalPause: async (threadId, params) => {
        paused.push({ threadId, ...params });
        return reply();
      },
    };
    render(<App client={client} />);
    await waitFor(() => expect(screen.getByLabelText('要說的話')).toBeTruthy());
    return { ...fake, paused };
  }

  const acceptedPause = (): CommandOutcome<GoalPauseResult> => ({
    kind: 'ok',
    result: { ok: true, value: { goal: { id: 'g1', revision: 4, phase: 'paused' } } },
  });

  it('暫停鈕（#1517）：active 才有；paused、blocked、complete、沒有目標都沒有', async () => {
    const { downlink, opened } = await mounted();
    expect(pauseButton()).toBeNull();
    downlink.push(opened[0]!, [goalFrame(downlink, wireGoal())]);
    await waitFor(() => expect(pauseButton()).toBeTruthy());
    for (const phase of ['paused', 'blocked', 'complete'] as const) {
      downlink.push(opened[0]!, [goalFrame(downlink, wireGoal({ phase }))]);
      await waitFor(() => expect(pauseButton()).toBeNull());
    }
    downlink.push(opened[0]!, [goalFrame(downlink, wireGoal())]);
    await waitFor(() => expect(pauseButton()).toBeTruthy());
    downlink.push(opened[0]!, [goalFrame(downlink, null)]);
    await waitFor(() => expect(pauseButton()).toBeNull());
  });

  it('一輪跑著時按暫停：送 goal.pause，帶畫面上那份目標的身分與修訂；不自己改相位，等下行翻成 paused 鈕才消失', async () => {
    const { downlink, opened, paused } = await mountedWithPause(acceptedPause, [
      frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
    ]);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('執行中'));
    downlink.push(opened[0]!, [goalFrame(downlink, wireGoal({ revision: 3 }))]);
    await waitFor(() => expect(pauseButton()).toBeTruthy());
    expect(pauseButton()!.hasAttribute('disabled')).toBe(false);

    fireEvent.click(pauseButton()!);
    await waitFor(() =>
      expect(paused).toEqual([{ threadId: opened[0], goalId: 'g1', revision: 3 }]),
    );
    // 收下了也不搶先改：相位要等下行。
    expect(bar()!.textContent).toContain('目標：未完成');
    expect(screen.queryByTestId('goal-pause-failure')).toBeNull();

    downlink.push(opened[0]!, [goalFrame(downlink, wireGoal({ revision: 4, phase: 'paused' }))]);
    await waitFor(() => expect(bar()!.textContent).toContain('目標：已暫停'));
    expect(pauseButton()).toBeNull();
  });

  it('停在核准點時目標列還在、暫停鈕按得到（伺服器停在核准點也收）', async () => {
    const { downlink, opened, paused } = await mountedWithPause(acceptedPause, [
      frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
      approvalFrame([{ name: 'danger', allowed: ['approve', 'reject'] }]),
    ]);
    await screen.findByTestId('approval-card');
    downlink.push(opened[0]!, [goalFrame(downlink, wireGoal())]);
    await waitFor(() => expect(pauseButton()).toBeTruthy());
    fireEvent.click(pauseButton()!);
    await waitFor(() => expect(paused).toHaveLength(1));
  });

  it('過期被拒：列留著，列下面說出原因並掛在鈕的描述上；再按一次先收掉上一句', async () => {
    let reply: CommandOutcome<GoalPauseResult> = {
      kind: 'ok',
      result: {
        ok: false,
        error: { code: 'goal-stale', current: { id: 'g1', revision: 5, phase: 'active' } },
      },
    };
    const { downlink, opened, paused } = await mountedWithPause(() => reply);
    downlink.push(opened[0]!, [goalFrame(downlink, wireGoal())]);
    await waitFor(() => expect(pauseButton()).toBeTruthy());

    fireEvent.click(pauseButton()!);
    const failure = await screen.findByTestId('goal-pause-failure');
    expect(failure.textContent).toBe('目標剛被改過，這次沒有暫停。請看過現在的目標再決定。');
    expect(pauseButton()!.getAttribute('aria-describedby')).toBe(failure.id);
    expect(bar()).toBeTruthy();

    reply = { kind: 'rejected', code: 'not_supported', message: 'not supported' };
    fireEvent.click(pauseButton()!);
    await waitFor(() =>
      expect(screen.getByTestId('goal-pause-failure').textContent).toBe(
        '這台伺服器不支援暫停目標。',
      ),
    );
    expect(paused).toHaveLength(2);
  });

  it('一輪跑著時打 /goal pause 送得出去（命令宣告了 runWhileBusy）；/goal <目標> 與 /plan 照舊送不出去', async () => {
    await mountedWithPause(
      acceptedPause,
      [frame('lifecycle', [], { event: 'running', graph_name: 'root' })],
      [
        {
          name: 'goal',
          description: '目標',
          input: { hint: '[<目標>|pause]' },
          runWhileBusy: ['pause'],
        },
        { name: 'plan', description: '計劃模式', input: { hint: '[on|off]' } },
      ],
    );
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('執行中'));
    const input = screen.getByLabelText('要說的話');
    // 跑著時送不出去的那一行，主按鈕是停止（dsh 的 `blocked`，#1591）；送得出去的命令叫「送出」。
    const sendable = () => screen.queryByRole('button', { name: '送出' }) !== null;
    const stops = () => screen.queryByRole('button', { name: '停止' }) !== null;

    // 清單是非同步到的：等它到了 `/goal pause` 才會放行。
    fireEvent.change(input, { target: { value: '/goal pause' } });
    await waitFor(() => expect(sendable()).toBe(true));
    fireEvent.change(input, { target: { value: '/goal 把登入改好' } });
    expect([sendable(), stops()]).toEqual([false, true]);
    fireEvent.change(input, { target: { value: '/goal PAUSE' } });
    expect([sendable(), stops()]).toEqual([false, true]);
    fireEvent.change(input, { target: { value: '/plan' } });
    expect([sendable(), stops()]).toEqual([false, true]);
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
    setSeq(0);
    const { client, cancels } = fakeClient([
      frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
    ]);
    render(<App client={client} />);
    fireEvent.click(await screen.findByRole('button', { name: '停止' }));
    await waitFor(() => expect(cancels).toHaveLength(1));
  });

  it('停在核准點時沒有停止——想結束就按不允許（#376 第 10、11 條）', async () => {
    // 翻面的絆索：#265 Q7「停在核准點按停止收回」在畫面上沒有入口了，demian 知情後選的。
    setSeq(0);
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
    setSeq(0);
    const { client } = fakeClient([
      frame('lifecycle', [], { event: 'completed', graph_name: 'root' }),
    ]);
    render(<App client={client} />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('就緒'));
    expect(screen.queryByRole('button', { name: '停止' })).toBeNull();
  });

  it('收到帶 aborted 的收尾：狀態列說已停止，不是失敗；被打斷的那則標出來', async () => {
    setSeq(0);
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
    setSeq(0);
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
    setSeq(0);
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
    ['閘道逾時 504', new UplinkTransportError(504, '逾時了（#1335 toast）')],
  ])(
    '可能已經到了（%s）：不說沒送出去，說不確定、原樣重送不會重複（#1335）',
    async (_case, error) => {
      setSeq(0);
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
    },
  );

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
        throw new UplinkTransportError(403, '擋了（#1335 toast）');
      },
      '上行被載體層擋下：403 擋了（#1335 toast）',
    ],
    [
      '伺服器暫時不收 503',
      async (): Promise<UplinkResult> => {
        throw new UplinkTransportError(503, '忙（#1335 toast）');
      },
      '上行被載體層擋下：503 忙（#1335 toast）',
    ],
  ])('伺服器明說不收（%s）：照舊說這一句沒送出去（#1335）', async (_case, runStart, message) => {
    setSeq(0);
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

  it('thread 數滿了（#1478）：草稿放回去，說明換成給使用者看的那一句，不接 server 的原文', async () => {
    setSeq(0);
    const fake = fakeClient([frame('lifecycle', [], { event: 'completed', graph_name: 'root' })]);
    const runStart = async (): Promise<UplinkResult> => ({
      type: 'error',
      id: 1,
      error: THREAD_AT_CAPACITY,
      message: 'thread 數已到上限 2／2（#1478 toast）；重啟 serve 才會釋放',
    });
    render(<App client={{ ...fake.client, runStart }} />);

    await waitFor(() => expect(screen.getByPlaceholderText('說點什麼…')).toBeTruthy());
    const input = screen.getByLabelText('要說的話') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '滿了的那一句' } });
    fireEvent.click(screen.getByRole('button', { name: '送出' }));

    const card = await toastWith(THREAD_AT_CAPACITY_TEXT);
    expect(card.textContent).not.toContain('#1478 toast');
    expect(input.value).toBe('滿了的那一句');
  });

  it('歷史太深（#1753）：草稿放回去，說明換成給使用者看的那一句，不接 server 的原文', async () => {
    setSeq(0);
    const fake = fakeClient([frame('lifecycle', [], { event: 'completed', graph_name: 'root' })]);
    const runStart = async (): Promise<UplinkResult> => ({
      type: 'error',
      id: 1,
      error: THREAD_HISTORY_TOO_DEEP,
      message: '這條 thread 建不起來：日誌第 3 顆事件巢狀 3000 層（#1753 toast）',
    });
    render(<App client={{ ...fake.client, runStart }} />);

    await waitFor(() => expect(screen.getByPlaceholderText('說點什麼…')).toBeTruthy());
    const input = screen.getByLabelText('要說的話') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '太深的那一句' } });
    fireEvent.click(screen.getByRole('button', { name: '送出' }));

    const card = await toastWith(THREAD_HISTORY_TOO_DEEP_TEXT);
    expect(card.textContent).not.toContain('#1753 toast');
    expect(input.value).toBe('太深的那一句');
  });
});

describe('重送同一句話（請求編號，#1335）', () => {
  /**
   * 回條斷在半路：伺服器其實收下了（推了 `inbox`、畫了人的泡泡），呼叫端卻拿到例外，畫面說「沒送出去」、草稿放回去。
   * `dropFirst` 讓前幾次 `run.start` 照常送到假伺服器、回應丟掉。
   */
  function setup(dropFirst = 1) {
    setSeq(0);
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
    setSeq(0);
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
    setSeq(0);
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

describe('提問面板', () => {
  it('問答中斷畫成提問面板，不是核准面板；一題一頁', async () => {
    setSeq(0);
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
    setSeq(0);
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
    setSeq(0);
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
    setSeq(0);
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
    const elicitationPanel = () => findPanel('有 1 個問題要你回答');

    it('面板說出是哪台 server、哪支工具、什麼參數；模型自己問的那種沒有這一塊', async () => {
      setSeq(0);
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
      setSeq(0);
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
      await waitFor(
        () => expect(screen.queryByRole('region', { name: '有 1 個問題要你回答' })).toBeNull(),
        PANEL_WAIT,
      );
      view.unmount();
      cleanup();

      setSeq(0);
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
      setSeq(0);
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

      setSeq(0);
      const plain = fakeClient([questionFrame('q-4')]);
      render(<App client={plain.client} />);
      const plainPanel = await questionPanel();
      expect(within(plainPanel).queryByRole('button', { name: '拒絕' })).toBeNull();
      expect(within(plainPanel).queryByRole('button', { name: '取消' })).toBeNull();
    });
  });

  it('兩個前景子代理平行各自要核准（#328）：面板與狀態列講出是誰在問，各答各的，答對的那個 namespace', async () => {
    setSeq(0);
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

    const first = await findPanel('等待核准：write_file（子代理「explore」要的）（1／2）');
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
    const second = await findPanel('等待核准：write_file（子代理「writer」要的）');
    expect(within(second).getByTestId('approval-asker').textContent).toContain('子代理「writer」');
    fireEvent.click(within(second).getByRole('button', { name: '全部拒絕' }));
    await waitFor(() => expect(responded).toHaveLength(2));
    expect(responded[1]).toMatchObject({ namespace: ['tools:u2'], interrupt_id: 'int-2' });
  });

  it('重新整理後子代理的核准還掛著、委派卡接不回（#328）：只說「子代理」，不編名字，答得出去', async () => {
    setSeq(0);
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

    const panel = await findPanel('等待核准：write_file（子代理要的）');
    expect(within(panel).getByTestId('approval-asker').textContent).toBe('子代理要執行這個操作');
    fireEvent.click(within(panel).getByRole('button', { name: '全部核准' }));
    await waitFor(() => expect(responded).toHaveLength(1));
    expect(responded[0]).toMatchObject({ namespace: ['tools:gone'], interrupt_id: 'int-9' });
  });

  it('兩種中斷同時掛著時先來先處理，答掉核准那顆才輪到提問，各送各的形狀', async () => {
    setSeq(0);
    const { client, responded } = fakeClient([
      approvalFrame([{ name: 'write_file', allowed: ['approve', 'reject'] }], 'int-1'),
      questionFrame('q-1'),
    ]);
    render(<App client={client} />);

    // #408：同時只一個面板、先來先處理——核准先發，所以先畫核准；提問排在後面，進度數兩種一起。
    const approval = await findPanel('等待核准：write_file（1／2）');
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

/** 停在提問時按了停止之後（§4.3、#376 第 9 條）。 */
describe('停在提問時停止之後', () => {
  it('那張提問工具卡直接展開、列出題目與選項，標「已停止，請直接打字回覆」，不畫紅字', async () => {
    setSeq(0);
    const { client } = fakeClient(stoppedQuestionFrames());
    render(<App client={client} />);

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('已停止'));
    const card = screen.getByTestId('tool-entry');
    const trigger = within(card).getByRole('button', { name: /提問/ });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.textContent).toContain(STOPPED_QUESTION_TEXT);
    expect(within(card).getByText('哪一天？')).toBeTruthy();
    expect(within(card).getByText('週一：早上')).toBeTruthy();
    // 那句紅字是給模型看的英文；停止不是失敗（#276）。
    expect(within(card).queryByText(WITHDRAWN_TEXT)).toBeNull();
    expect(within(card).queryByText('失敗')).toBeNull();
  });

  it('輸入框回來了，提示字跟工具卡同一句', async () => {
    setSeq(0);
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

  it('沒連上、也不會自己接回時不講「連線中…」（#1865）；連上了就不看它', () => {
    expect(inputPlaceholder({ connected: false, stall: 'halted', stoppedOnQuestion: false })).toBe(
      HALTED_PLACEHOLDER,
    );
    expect(inputPlaceholder({ connected: false, stall: 'refused', stoppedOnQuestion: true })).toBe(
      REFUSED_PLACEHOLDER,
    );
    expect(inputPlaceholder({ connected: true, stall: 'halted', stoppedOnQuestion: false })).toBe(
      '說點什麼…',
    );
  });

  it('connectionStall 跟狀態列用同一組欄位判斷（#1865）', () => {
    const retrying = { wasConnected: true, offline: false } as const;
    // 永久拒絕：有那一句、不重試。
    expect(
      connectionStall({
        connected: false,
        refusal: THREAD_IS_SUBAGENT_TEXT,
        reconnecting: undefined,
      }),
    ).toBe('refused');
    // 看不懂的資料：有那一句、等人按。
    expect(
      connectionStall({
        connected: false,
        refusal: THREAD_PROTOCOL_ERROR_TEXT,
        reconnecting: retrying,
      }),
    ).toBe('halted');
    // thread 數滿了在重試、一般斷線、連上了：都不是。
    expect(
      connectionStall({
        connected: false,
        refusal: THREAD_AT_CAPACITY_TEXT,
        reconnecting: retrying,
      }),
    ).toBeUndefined();
    expect(
      connectionStall({ connected: false, refusal: undefined, reconnecting: retrying }),
    ).toBeUndefined();
    expect(
      connectionStall({ connected: true, refusal: undefined, reconnecting: undefined }),
    ).toBeUndefined();
  });
});

/**
 * 答完之後（§4.3）：答案列在那張提問工具卡上，transcript 不另插一行。
 */
describe('答完的問題列在提問工具卡上', () => {
  it('**逐題「問題 → 回答」**，而且「跳過」與選了什麼分得出來；沒有另一行紀錄', async () => {
    setSeq(0);
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

    await waitFor(
      () => expect(screen.queryByRole('region', { name: /問題要你回答/ })).toBeNull(),
      PANEL_WAIT,
    );
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
