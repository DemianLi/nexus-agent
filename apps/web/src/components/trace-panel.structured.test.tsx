import type { ConversationState, TrajectoryReply } from '@nexus/wire';
import { emptyConversation, reduceAll } from '@nexus/wire';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RightSidebarToggle } from '@/components/right-sidebar';
import {
  DIGEST_PAGE,
  TRACE_LEGACY_GROUP_TEXT,
  TRACE_MORE_DIGESTS_LABEL,
  TRACE_MORE_TURNS_LABEL,
  TURN_PAGE,
} from '@/components/trace-panel';
import { createConversationStore } from '@/lib/conversation-store';
import { LAYOUT_KEY_PREFIX } from '@/lib/right-sidebar';
import type { SidebarLayout } from '@/lib/right-sidebar';
import {
  TRACE_CALL_UNLOADED_TEXT,
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

function mount(state: ConversationState) {
  localStorage.setItem(LAYOUT_KEY_PREFIX + 't', JSON.stringify(open));
  return render(
    <WithRightSidebar sources={{ conversation: createConversationStore(state) }}>
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
    { digests: [digest(0), digest(1)], omitted: 4 },
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
    expect(heads[0]!.textContent).toContain('第 1 輪');
    expect(heads[0]!.textContent).toContain('人的訊息');
    expect(heads[0]!.textContent).toContain('2 次呼叫');
    expect(heads[0]!.textContent).toContain('耗時 2.5 秒');
    const limits = within(screen.getByTestId('trace-limits')).getAllByRole('listitem');
    expect(limits.map((item) => item.textContent)).toEqual(Object.values(TRACE_STRUCTURED_LIMITS));
    // 切輪那一條沒有了，決定只存本地那一條還在。
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
    expect(toolRow.textContent).toContain(`${clockText(1_700_000_100_000)} · 1.2 秒`);
    const retry = rows.find((row) => row.getAttribute('data-kind') === 'retry')!;
    expect(retry.textContent).toContain('重試 1/3');
    expect(retry.textContent).toContain('RATE_LIMIT · HTTP 429');
    expect(retry.textContent).toContain('等了 2.0 秒');
    const signal = rows.find((row) => row.getAttribute('data-kind') === 'signal')!;
    expect(signal.textContent).toContain('重複呼叫：ls 連續第 3 次');
    // 這兩種不是對話裡的一則，沒有地方可定位。
    expect(within(retry).queryByTestId('trace-locate')).toBeNull();
    expect(within(signal).queryByTestId('trace-locate')).toBeNull();
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
    expect(within(groups[1]!).getByTestId('trace-turn-head').textContent).toContain('第 6 輪');
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
