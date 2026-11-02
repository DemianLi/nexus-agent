import type { ConversationState, TrajectoryReply } from '@nexus/wire';
import { appendDecision, emptyConversation, reduceAll } from '@nexus/wire';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RightSidebarToggle } from '@/components/sidebar/right-sidebar';
import { TRACE_LOCATE_LABEL } from '@/components/trace/row';
import { TRACE_MORE_TURNS_LABEL, TURN_PAGE } from '@/components/trace/panel';
import {
  DIGEST_PAGE,
  ROW_PAGE,
  TRACE_MORE_ROWS_LABEL,
  TRACE_LEGACY_GROUP_TEXT,
  TRACE_MORE_DIGESTS_LABEL,
} from '@/components/trace/groups';
import { createConversationStore } from '@/lib/conversation-store';
import { LAYOUT_KEY_PREFIX } from '@/lib/right-sidebar';
import type { SidebarLayout } from '@/lib/right-sidebar';
import type { RightSidebarSources } from '@/lib/right-sidebar-api';
import {
  TRACE_CALL_UNLOADED_TEXT,
  TRACE_LOCATE_LOADING_TEXT,
  TRACE_HEADLINE,
  TRACE_LIMITS,
  TRACE_STRUCTURED_HEADLINE,
  TRACE_STRUCTURED_LIMITS,
} from '@/lib/trace-view';
import { clockText } from '@/lib/trajectory-view';
import { axeViolations } from '@/test/axe';
import { Script } from '@/test/conversation-frames';
import { memoryStorage, WithRightSidebar } from '@/test/right-sidebar';
import {
  call,
  decision,
  digest,
  tool,
  turn,
  view,
  withTrajectory,
} from '@/test/trajectory-fixtures';

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const open: SidebarLayout = { open: true, tabs: [{ kind: 'trace' }], active: 'trace' };

function mount(state: ConversationState, extra: Omit<RightSidebarSources, 'conversation'> = {}) {
  localStorage.setItem(LAYOUT_KEY_PREFIX + 't', JSON.stringify(open));
  return render(
    <WithRightSidebar sources={{ conversation: createConversationStore(state), ...extra }}>
      <RightSidebarToggle />
    </WithRightSidebar>,
  );
}

const reply = (seq: number, messageId: string, chars = 5): TrajectoryReply => ({
  seq,
  time: 1_700_000_000_000 + seq,
  messageId,
  textChars: chars,
  reasoningChars: 0,
  toolCalls: 0,
});

/** 兩輪，第一輪帶一次重試、一顆提醒、一個工具。 */
function conversation() {
  const script = new Script();
  const state = reduceAll(emptyConversation(), [
    script.running(),
    ...script.human('inbox:r1', '幫我看一下'),
    ...script.ai('a1', { reasoning: '先看' }),
    script.started('c1', 'ls', { path: '/' }),
    script.finished('c1', 'ok'),
    ...script.ai('a2', { text: '看完了' }),
    script.completed(),
    script.running(),
    ...script.human('inbox:r2', '再來一次'),
    ...script.ai('b1', { text: '好' }),
    script.completed(),
  ]);
  const trajectory = view(
    [
      turn(0, {
        end: 'completed',
        durationMs: 2500,
        calls: [
          call(5, {
            system: 8,
            header: 9,
            reply: reply(11, 'run-a1'),
            tools: [tool('c1', { time: 1_700_000_100_000, durationMs: 1234 })],
            retries: [
              {
                seq: 6,
                time: 1_700_000_050_000,
                retryId: 'r',
                retry: 1,
                maxRetries: 3,
                code: 'RATE_LIMIT',
                status: 429,
                waitedMs: 2000,
              },
            ],
          }),
          call(16, { model: undefined, usage: undefined, reply: reply(18, 'run-a2') }),
        ],
        decisions: [decision('reminder', 12, { tool: 'ls', count: 3 })],
      }),
      turn(1, { calls: [call(32, { reply: reply(34, 'run-b1') })] }),
    ],
    { digests: [digest(10), digest(11)], omitted: 4 },
  );
  return { script, state, trajectory };
}

const kinds = () => screen.getAllByTestId('trace-row').map((row) => row.getAttribute('data-kind'));

describe('觀測分頁：結構化模式', () => {
  it('輪的標題、模型呼叫段落、重試、重複呼叫提醒照順序出現，限制換成結構化的那一組', async () => {
    const { script, state, trajectory } = conversation();
    mount(withTrajectory(state, script, trajectory));
    await act(async () => {});
    expect(screen.getByTestId('trace-headline').textContent).toBe(TRACE_STRUCTURED_HEADLINE);
    // 提醒（seq 12）發生在第一次呼叫（5）之後、第二次呼叫（16）之前。
    expect(kinds()).toEqual([
      'input',
      'call',
      'retry',
      'thinking',
      'tool',
      'signal',
      'call',
      'reply',
      'input',
      'call',
      'reply',
    ]);
    const heads = screen.getAllByTestId('trace-turn-head');
    expect(heads).toHaveLength(2);
    // 省略 4 輪、兩份摘要，所以窗口裡第一輪是第 7 輪。
    expect(heads[0]!.textContent).toContain('第 7 輪');
    expect(heads[0]!.textContent).toContain('人的訊息');
    expect(heads[0]!.textContent).toContain('2 次呼叫');
    expect(heads[0]!.textContent).toContain('耗時 2.5 秒');
    const limits = within(screen.getByTestId('trace-limits')).getAllByRole('listitem');
    expect(limits.map((item) => item.textContent)).toEqual(Object.values(TRACE_STRUCTURED_LIMITS));
    // 切輪那一條沒有了；決定那一條換成「核准結局來自軌跡」。
    expect(limits.map((item) => item.getAttribute('data-limit'))).toEqual([
      'decisions',
      'loaded',
      'absent',
    ]);
  });

  it('工具列帶投影的時刻與耗時；重試列帶原因碼、狀態與等了多久；提醒寫出工具與次數', async () => {
    const { script, state, trajectory } = conversation();
    mount(withTrajectory(state, script, trajectory));
    await act(async () => {});
    const rows = screen.getAllByTestId('trace-row');
    const toolRow = rows.find((row) => row.getAttribute('data-kind') === 'tool')!;
    // 時刻收在展開區（#1690 T3）：先打開那一列。
    fireEvent.click(within(toolRow).getAllByRole('button')[0]!);
    expect(toolRow.textContent).toContain(`${clockText(1_700_000_100_000)} · 1.2 秒`);
    const retry = rows.find((row) => row.getAttribute('data-kind') === 'retry')!;
    expect(retry.textContent).toContain('重試 1/3');
    // 原因走失敗碼的一句話（#1449），原碼留在 `data-failure-code` 與 `title`。
    expect(retry.textContent).toContain('被限流 · HTTP 429');
    expect(retry.textContent).not.toContain('RATE_LIMIT');
    const code = retry.querySelector('[data-failure-code]')!;
    expect(code.getAttribute('data-failure-code')).toBe('RATE_LIMIT');
    expect(code.getAttribute('title')).toBe('RATE_LIMIT');
    expect(retry.textContent).toContain('等了 2.0 秒');
    const signal = rows.find((row) => row.getAttribute('data-kind') === 'signal')!;
    expect(signal.textContent).toContain('重複呼叫：ls 連續第 3 次');
    // 這兩種不是對話裡的一則，沒有地方可定位。
    expect(within(retry).queryByTestId('trace-locate')).toBeNull();
    expect(within(signal).queryByTestId('trace-locate')).toBeNull();
  });

  it('核准：停下來的那一列照軌跡的結局說，本地的決定列不重複；被政策擋下的工具卡帶白話說明', async () => {
    const script = new Script();
    const asked = reduceAll(emptyConversation(), [
      script.running(),
      ...script.human('inbox:r1', '幫我改'),
      ...script.ai('a', { text: '改' }),
      script.started('c1', 'edit_file', { file_path: 'a.md' }),
      script.approval('int-1', 'edit_file'),
    ]);
    const state = reduceAll(appendDecision(asked, 'int-1', 'approve'), [
      script.finished('c1', '已改'),
      ...script.ai('b', { text: '再試' }),
      script.started('c2', 'bash', { command: 'ls' }),
      script.failed('c2', '政策不允許', 'APPROVAL_POLICY_NEVER'),
      script.started('c3', 'ls', {}),
      script.failed('c3', '中止', 'ABORTED'),
      ...script.ai('c', { text: '好' }),
      script.completed(),
    ]);
    const trajectory = view([
      turn(0, {
        end: 'completed',
        calls: [call(5, { reply: reply(11, 'run-a') }), call(20, { reply: reply(22, 'run-b') })],
        decisions: [
          decision('interrupt', 10, {
            id: 'int-1',
            approval: { tool: 'edit_file', outcome: 'allowed-once', decidedAt: 1_700_000_013_000 },
          }),
        ],
      }),
    ]);
    mount(withTrajectory(state, script, trajectory));
    await act(async () => {});
    expect(kinds()).not.toContain('decision');
    const signal = screen
      .getAllByTestId('trace-row')
      .find((row) => row.getAttribute('data-kind') === 'signal')!;
    expect(signal.textContent).toContain('核准 edit_file：允許一次（等了 13.0 秒）');
    const chips = screen.getAllByTestId('trace-code-text');
    expect(chips.map((chip) => chip.textContent)).toEqual(['核准政策一律不允許']);
    // 沒有對應句子的碼只顯示碼本身。
    expect(screen.getAllByTestId('trace-error-code').map((c) => c.textContent)).toEqual([
      'APPROVAL_POLICY_NEVER',
      'ABORTED',
    ]);
  });

  it('核准：回覆看不懂（#2040）的中斷列寫沒有有效回覆，工具列說沒有執行，不說人拒絕了', async () => {
    const script = new Script();
    const state = reduceAll(emptyConversation(), [
      script.running(),
      ...script.human('inbox:r1', '幫我跑'),
      ...script.ai('a', { text: '跑' }),
      script.started('c1', 'bash', { command: 'ls' }),
      script.approval('int-1', 'bash'),
      script.failed('c1', '收到的核准回覆看不懂', 'APPROVAL_INVALID_REPLY'),
      ...script.ai('b', { text: '沒跑' }),
      script.completed(),
    ]);
    const trajectory = view([
      turn(0, {
        end: 'completed',
        calls: [call(5, { reply: reply(11, 'run-a') })],
        decisions: [
          decision('interrupt', 10, {
            id: 'int-1',
            approval: { tool: 'bash', outcome: 'unavailable', decidedAt: 1_700_000_013_000 },
          }),
        ],
      }),
    ]);
    mount(withTrajectory(state, script, trajectory));
    await act(async () => {});
    const signal = screen
      .getAllByTestId('trace-row')
      .find((row) => row.getAttribute('data-kind') === 'signal')!;
    expect(signal.textContent).toContain('核准 bash：沒有有效回覆（等了 13.0 秒）');
    expect(screen.getAllByTestId('trace-code-text').map((chip) => chip.textContent)).toEqual([
      '回覆看不懂，沒有執行',
    ]);
    expect(document.body.textContent).not.toContain('人拒絕了');
  });

  it('工具的磁碟空間滿（FS_NO_SPACE，#2242）：碼旁邊寫中文那一句', async () => {
    const script = new Script();
    const state = reduceAll(emptyConversation(), [
      script.running(),
      ...script.human('inbox:r1', '寫檔'),
      ...script.ai('a', { text: '寫' }),
      script.started('c1', 'write_file', { file_path: '/a.txt' }),
      script.failed('c1', '寫不進去', 'FS_NO_SPACE'),
      ...script.ai('b', { text: '沒寫成' }),
      script.completed(),
    ]);
    const trajectory = view([
      turn(0, { end: 'completed', calls: [call(5, { reply: reply(11, 'run-a') })] }),
    ]);
    mount(withTrajectory(state, script, trajectory));
    await act(async () => {});
    expect(screen.getByTestId('trace-error-code').textContent).toBe('FS_NO_SPACE');
    expect(screen.getByTestId('trace-code-text').textContent).toBe('主機的儲存空間滿了');
  });

  it('呼叫段落展開：缺席的欄位寫「—」不寫 0；指到已被擠掉的快照寫「已不保留」', async () => {
    const { script, state, trajectory } = conversation();
    mount(
      withTrajectory(state, script, trajectory, {
        system: [],
        header: [],
      }),
    );
    await act(async () => {});
    const callRows = screen
      .getAllByTestId('trace-row')
      .filter((row) => row.getAttribute('data-kind') === 'call');
    // 第二次呼叫沒記模型與用量。
    fireEvent.click(within(callRows[1]!).getByRole('button', { name: /^模型呼叫 #2/ }));
    const second = within(callRows[1]!).getByTestId('trace-call-details').textContent!;
    expect(second).toContain('模型—');
    expect(second).toContain('輸入 token—');
    expect(second).toContain('輸出 token—');
    expect(second).not.toMatch(/token0/);
    expect(second).toContain('系統提示詞—');
    // 第一次呼叫指向的兩份快照都不在現有的快照裡。
    fireEvent.click(within(callRows[0]!).getByRole('button', { name: /^模型呼叫 #1/ }));
    const first = within(callRows[0]!).getByTestId('trace-call-details').textContent!;
    expect(first).toContain('系統提示詞已不保留');
    expect(first).toContain('設定與工具清單已不保留');
    expect(first).toContain('輸入 token10');
  });

  it('投影有、條目沒載入的呼叫：說明內文不在載入的對話裡', async () => {
    const script = new Script();
    const state = reduceAll(emptyConversation(), [script.running(), script.completed()]);
    const trajectory = view([turn(0, { calls: [call(5, { reply: reply(11, 'run-x') })] })]);
    mount(withTrajectory(state, script, trajectory));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: /^模型呼叫 #1/ }));
    expect(screen.getByTestId('trace-call-unloaded').textContent).toBe(TRACE_CALL_UNLOADED_TEXT);
  });

  it('單輪上限摺掉的部分講明白：計數仍包含它們', async () => {
    const script = new Script();
    const state = reduceAll(emptyConversation(), [script.running(), script.completed()]);
    const trajectory = view([
      turn(0, {
        callCount: 40,
        toolCount: 12,
        calls: [call(100)],
        elided: { calls: 39, tools: 9, inputs: 0, decisions: 0 },
      }),
    ]);
    mount(withTrajectory(state, script, trajectory));
    await act(async () => {});
    const note = screen.getByTestId('trace-elided').textContent!;
    expect(note).toContain('另有 39 次呼叫已摺掉');
    expect(note).toContain('9 個工具已摺掉');
    expect(note).toContain('仍包含它們');
    expect(screen.getByTestId('trace-turn-head').textContent).toContain('40 次呼叫');
  });

  it('窗口外的輪：只有摘要、沒有定位鈕，摺起來；再更早的只講數量', async () => {
    const { script, state, trajectory } = conversation();
    mount(withTrajectory(state, script, trajectory));
    await act(async () => {});
    const block = screen.getByTestId('trace-digests');
    expect(block.textContent).toContain('更早的 6 輪（只有摘要）');
    fireEvent.click(within(block).getByRole('button', { name: /更早的 6 輪/ }));
    expect(within(block).getAllByTestId('trace-digest')).toHaveLength(2);
    expect(within(block).getByTestId('trace-omitted').textContent).toContain('再更早的 4 輪');
    expect(within(block).queryByTestId('trace-locate')).toBeNull();
  });

  it('摘要與輪的列數有上限：只畫最新的一段，其餘按「顯示更早的」才出來', async () => {
    const script = new Script();
    const state = reduceAll(emptyConversation(), [script.running(), script.completed()]);
    const digests = Array.from({ length: DIGEST_PAGE + 5 }, (_, i) => digest(i));
    const turns = Array.from({ length: TURN_PAGE + 3 }, (_, i) =>
      turn(DIGEST_PAGE + 5 + i, { calls: [call(i * 10 + 5)] }),
    );
    mount(withTrajectory(state, script, view(turns, { digests })));
    await act(async () => {});
    expect(screen.getAllByTestId('trace-turn')).toHaveLength(TURN_PAGE);
    fireEvent.click(screen.getByTestId('trace-more-turns'));
    expect(screen.getAllByTestId('trace-turn')).toHaveLength(TURN_PAGE + 3);
    expect(screen.queryByTestId('trace-more-turns')).toBeNull();
    const block = screen.getByTestId('trace-digests');
    fireEvent.click(within(block).getByRole('button', { name: /更早的/ }));
    expect(within(block).getAllByTestId('trace-digest')).toHaveLength(DIGEST_PAGE);
    expect(
      within(block).getByRole('button', { name: new RegExp(TRACE_MORE_DIGESTS_LABEL) }),
    ).toBeTruthy();
    fireEvent.click(screen.getByTestId('trace-more-digests'));
    expect(within(block).getAllByTestId('trace-digest')).toHaveLength(DIGEST_PAGE + 5);
    expect(TRACE_MORE_TURNS_LABEL).toBeTruthy();
  });

  it('一組裡的列數有上限：一輪幾百次呼叫只畫最新的一段，其餘按「顯示更早的列」才出來', async () => {
    const script = new Script();
    const total = ROW_PAGE + 50;
    const state = reduceAll(emptyConversation(), [
      script.running(),
      ...script.human('inbox:r1', '做很多事'),
      ...Array.from({ length: total }, (_, i) => [
        script.started(`c${i}`, 'ls', { path: `/${i}` }),
        script.finished(`c${i}`, 'ok'),
      ]).flat(),
      script.completed(),
    ]);
    // 沒有投影：整份是一組第 0 版的組，列數 = 1 句話 + total 顆工具。
    mount(state);
    await act(async () => {});
    expect(screen.getAllByTestId('trace-row')).toHaveLength(ROW_PAGE);
    // 畫的是最新的一段：最後一顆工具在，那句人話（最舊）不在。
    expect(screen.queryByText(/做很多事/)).toBeNull();
    const more = screen.getByTestId('trace-more-rows');
    expect(more.textContent).toContain(TRACE_MORE_ROWS_LABEL);
    expect(more.textContent).toContain('還有 51 列');
    fireEvent.click(more);
    expect(screen.getAllByTestId('trace-row')).toHaveLength(total + 1);
    expect(screen.queryByTestId('trace-more-rows')).toBeNull();
    expect(screen.getByText(/做很多事/)).toBeTruthy();
    // 要畫兩次 200 多列：本機約 1.2 秒、CI 的機器慢四倍（跑過 5.2 秒、撞預設的 5 秒逾時），
    // 所以這顆單獨放寬；列數是要驗的東西，不能為了快而縮小。
  }, 30_000);

  it('窗口之前的已載入對話：沒有標題、標明「沒有結構資料」', async () => {
    const script = new Script();
    const state = reduceAll(emptyConversation(), [
      script.running(),
      ...script.human('history-0', '很久以前'),
      ...script.ai('history-3', { text: '舊回覆' }),
      script.completed(),
      script.running(),
      ...script.human('inbox:r1', '新的'),
      ...script.ai('a1', { text: '好' }),
      script.completed(),
    ]);
    const trajectory = view([turn(5, { calls: [call(5, { reply: reply(11, 'run-a1') })] })]);
    mount(withTrajectory(state, script, trajectory));
    await act(async () => {});
    const groups = screen.getAllByTestId('trace-turn');
    expect(groups).toHaveLength(2);
    expect(within(groups[0]!).getByTestId('trace-legacy-group').textContent).toBe(
      TRACE_LEGACY_GROUP_TEXT,
    );
    expect(within(groups[0]!).queryByTestId('trace-turn-head')).toBeNull();
    expect(within(groups[1]!).getByTestId('trace-turn-head').textContent).toContain('第 1 輪');
  });

  it('沒有投影：整個是第 0 版，標語與四條限制都在，沒有標題與段落', async () => {
    const { state } = conversation();
    mount(state);
    await act(async () => {});
    expect(screen.getByTestId('trace-headline').textContent).toBe(TRACE_HEADLINE);
    const limits = within(screen.getByTestId('trace-limits')).getAllByRole('listitem');
    expect(limits.map((item) => item.textContent)).toEqual(Object.values(TRACE_LIMITS));
    expect(screen.queryByTestId('trace-turn-head')).toBeNull();
    expect(screen.queryByTestId('trace-legacy-group')).toBeNull();
    expect(kinds()).not.toContain('call');
  });

  it('串流中投影整份換掉：分頁跟著更新，沒變的列不重畫', async () => {
    const { script, state, trajectory } = conversation();
    const store = createConversationStore(withTrajectory(state, script, trajectory));
    localStorage.setItem(LAYOUT_KEY_PREFIX + 't', JSON.stringify(open));
    render(
      <WithRightSidebar sources={{ conversation: store }}>
        <RightSidebarToggle />
      </WithRightSidebar>,
    );
    await act(async () => {});
    expect(screen.getAllByTestId('trace-turn')).toHaveLength(2);
    const before = screen.getAllByTestId('trace-row')[0];
    // 一顆新的投影 frame：第二輪多一次呼叫。
    const next = withTrajectory(store.getSnapshot(), script, {
      ...trajectory,
      turns: [
        trajectory.turns[0]!,
        turn(1, { calls: [call(32, { reply: reply(34, 'run-b1') }), call(40)] }),
      ],
    });
    await act(async () => {
      store.set(next);
    });
    const calls = screen
      .getAllByTestId('trace-row')
      .filter((row) => row.getAttribute('data-kind') === 'call');
    expect(calls).toHaveLength(4);
    // 第一列是同一個 DOM 節點：memo 擋住了，沒有被拆掉重建。
    expect(screen.getAllByTestId('trace-row')[0]).toBe(before);
  });

  it('axe：結構化的分頁沒有違規', async () => {
    const { script, state, trajectory } = conversation();
    mount(withTrajectory(state, script, trajectory));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: /更早的 6 輪/ }));
    expect(await axeViolations(document.body)).toEqual([]);
  });
});

describe('觀測分頁：目標還沒載入時先載到那一輪再定位（#1601 `N1356`）', () => {
  const scrollIntoView = vi.fn();
  beforeEach(() => {
    scrollIntoView.mockClear();
    Element.prototype.scrollIntoView = scrollIntoView;
  });

  /** 投影有第 3 輪（`seq` 300）的一次呼叫，條目還沒載入；載入之後那則回覆在對話裡。 */
  function unloaded() {
    const script = new Script();
    const trajectory = view([turn(3, { calls: [call(5, { reply: reply(311, 'run-x') })] })]);
    const before = withTrajectory(
      reduceAll(emptyConversation(), [script.running(), script.completed()]),
      script,
      trajectory,
    );
    const after = withTrajectory(
      reduceAll(emptyConversation(), [
        script.running(),
        ...script.ai('x', { text: '較早的回覆' }),
        script.completed(),
      ]),
      script,
      trajectory,
    );
    return { before, after };
  }

  const callRow = () =>
    screen.getAllByTestId('trace-row').find((row) => row.getAttribute('data-kind') === 'call')!;

  it('內文沒載入的呼叫也有定位鈕：按下去先載到那一輪，畫出來之後捲到那一則並標示', async () => {
    const { before, after } = unloaded();
    const store = createConversationStore(before);
    const target = after.entries.find((entry) => entry.kind === 'ai')!.id;
    let item: HTMLElement | undefined;
    const loadThrough = vi.fn(async (_seq: number) => {
      // 對話區跟著畫出那一格：替身直接放一格，同 `panel.test.tsx` 的定位測試。
      store.set(after);
      item = document.createElement('div');
      item.setAttribute('data-slot', 'message-scroller-item');
      item.setAttribute('data-message-id', target);
      document.body.append(item);
    });
    localStorage.setItem(LAYOUT_KEY_PREFIX + 't', JSON.stringify(open));
    render(
      <WithRightSidebar sources={{ conversation: store, loadThrough }}>
        <RightSidebarToggle />
      </WithRightSidebar>,
    );
    await act(async () => {});
    const button = within(callRow()).getByRole('button', {
      name: new RegExp(TRACE_LOCATE_LABEL),
    });
    fireEvent.click(button);
    expect(screen.getByRole('status').textContent).toBe(TRACE_LOCATE_LOADING_TEXT);
    await act(async () => {});
    expect(loadThrough).toHaveBeenCalledWith(300);
    expect(item?.hasAttribute('data-located')).toBe(true);
    expect(scrollIntoView.mock.contexts).toContain(item);
    expect(screen.queryByTestId('trace-missing')).toBeNull();
  });

  it('載完了還是沒有那一則（伺服器拿不到、或沒有進展就停）：在那一列底下講原因', async () => {
    const { before } = unloaded();
    const loadThrough = vi.fn(async () => {});
    mount(before, { loadThrough });
    await act(async () => {});
    fireEvent.click(
      within(callRow()).getByRole('button', { name: new RegExp(TRACE_LOCATE_LABEL) }),
    );
    await act(async () => {});
    expect(loadThrough).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('trace-missing')).toBeTruthy();
  });

  it('沒給 `loadThrough`：維持原樣，內文沒載入的呼叫不畫定位鈕', async () => {
    const { before } = unloaded();
    mount(before);
    await act(async () => {});
    expect(
      within(callRow()).queryByRole('button', { name: new RegExp(TRACE_LOCATE_LABEL) }),
    ).toBeNull();
  });
});
