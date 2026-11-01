import type {
  ConversationState,
  RequestSnapshotsView,
  TrajectoryTurn,
  TrajectoryTurnOutcome,
  TrajectoryView,
} from '@nexus/wire';
import {
  REQUEST_SNAPSHOTS_PROJECTION,
  REQUEST_SNAPSHOTS_VERSION,
  TRAJECTORY_PROJECTION,
  TRAJECTORY_VERSION,
  emptyConversation,
  reduceAll,
} from '@nexus/wire';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useRightSidebar } from '@/components/sidebar/right-sidebar-context';
import { RightSidebarToggle } from '@/components/sidebar/right-sidebar';
import {
  SUBAGENT_CALLS_NO_DATA_TEXT,
  SUBAGENT_CALLS_NO_PULL_TEXT,
  SUBAGENT_CALLS_RELOAD_LABEL,
  SUBAGENT_CALLS_TITLE,
} from '@/components/trace/subagent';
import { TRACE_PULL_LABEL, TRACE_PULL_RETRY_LABEL } from '@/components/trace/pull-control';
import { createConversationStore } from '@/lib/conversation-store';
import { LAYOUT_KEY_PREFIX } from '@/lib/right-sidebar';
import type { SidebarLayout } from '@/lib/right-sidebar';
import { createTrajectoryPuller } from '@/lib/trajectory-pull';
import { Script } from '@/test/conversation-frames';
import { memoryStorage, WithRightSidebar } from '@/test/right-sidebar';
import {
  call,
  digest,
  projectionFrame,
  tool,
  turn,
  view,
  withTrajectory,
} from '@/test/trajectory-fixtures';

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  // jsdom 沒有 `scrollIntoView`：拉完交焦點前會先捲過去（#2009），不補就丟錯。
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const open: SidebarLayout = { open: true, tabs: [{ kind: 'trace' }], active: 'trace' };
const flush = () => act(async () => {});

const link = (runId: string) => ({
  childId: `t/${runId}`,
  runId,
  mode: 'one-shot' as const,
  catalogSeq: 7,
});

/** root：一輪、一次呼叫、一顆派出子代理的工具（`subagent` 這顆）；`laterTurns` 接在這一輪之後。 */
function scenario(
  runId: string | undefined,
  child?: {
    trajectory?: TrajectoryView;
    snapshots?: RequestSnapshotsView;
    laterTurns?: readonly TrajectoryTurn[];
    parentTurn?: Partial<TrajectoryTurn>;
  },
) {
  const script = new Script();
  let state: ConversationState = reduceAll(emptyConversation(), [
    script.running(),
    ...script.human('inbox:r1', '派個子代理'),
    ...script.ai('a1', { text: '好' }),
    script.started('c1', 'subagent', { prompt: '去做' }),
    script.finished('c1', '完成'),
    script.completed(),
  ]);
  state = withTrajectory(
    state,
    script,
    view([
      turn(0, {
        ...child?.parentTurn,
        calls: [
          call(5, {
            tools: [
              tool('c1', {
                name: 'subagent',
                ...(runId === undefined ? {} : { subagent: link(runId) }),
              }),
            ],
          }),
        ],
      }),
      ...(child?.laterTurns ?? []),
    ]),
  );
  if (runId !== undefined && child?.trajectory !== undefined) {
    state = reduceAll(state, [
      projectionFrame(script, TRAJECTORY_PROJECTION, TRAJECTORY_VERSION, child.trajectory, {
        session: runId,
      }),
    ]);
  }
  if (runId !== undefined && child?.snapshots !== undefined) {
    state = reduceAll(state, [
      projectionFrame(
        script,
        REQUEST_SNAPSHOTS_PROJECTION,
        REQUEST_SNAPSHOTS_VERSION,
        child.snapshots,
        { session: runId },
      ),
    ]);
  }
  return state;
}

function fakeClient() {
  const queries: { seq?: number; messageId?: string; runId?: string }[] = [];
  const waiting: ((outcome: TrajectoryTurnOutcome) => void)[] = [];
  const signals: AbortSignal[] = [];
  return {
    queries,
    signals,
    waiting,
    client: {
      trajectoryTurn: vi.fn(
        (
          _threadId: string,
          query: { seq?: number; messageId?: string; runId?: string },
          signal?: AbortSignal,
        ) =>
          new Promise<TrajectoryTurnOutcome>((resolve) => {
            queries.push(query);
            if (signal !== undefined) signals.push(signal);
            waiting.push(resolve);
          }),
      ),
    },
  };
}

function mount(state: ConversationState, client?: ReturnType<typeof fakeClient>['client']) {
  localStorage.setItem(LAYOUT_KEY_PREFIX + 't', JSON.stringify(open));
  const puller = client === undefined ? undefined : createTrajectoryPuller(client, 't');
  return render(
    <WithRightSidebar
      sources={{
        conversation: createConversationStore(state),
        ...(puller === undefined ? {} : { trajectoryPull: puller }),
      }}
    >
      <RightSidebarToggle />
    </WithRightSidebar>,
  );
}

/** 成本分頁「看這一輪」按下去的事：用探針直接叫 `revealTurn`。 */
function RevealProbe({ seq }: { seq: number }) {
  const api = useRightSidebar();
  return (
    <button type="button" onClick={() => api?.revealTurn(seq)}>
      看這一輪
    </button>
  );
}

/** 展開子代理那顆工具列、再展開它底下的區塊。 */
async function expandSubagent() {
  await flush();
  const row = document.querySelector<HTMLElement>('[data-testid="trace-row"][data-kind="tool"]')!;
  const head = row.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
  if (head !== null) fireEvent.click(head);
  const block = screen.getByTestId('trace-subagent-block');
  const toggle = within(block).queryByRole('button', { name: new RegExp(SUBAGENT_CALLS_TITLE) });
  if (toggle !== null && toggle.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle);
  await flush();
  return block;
}

const childTurn = (n: number) =>
  turn(n, {
    seq: n * 10,
    calls: [
      call(n * 100 + 1, {
        tools: [tool(`k${n}`, { name: 'ls', durationMs: 8 })],
        retries: [
          {
            seq: 3,
            time: 1_700_000_000_000,
            retryId: 'r',
            retry: 1,
            maxRetries: 3,
            code: 'RATE_LIMIT',
            status: 429,
            waitedMs: 2000,
          },
        ],
      }),
      call(n * 100 + 2, { outcome: 'error' }),
    ],
  });

describe('觀測分頁：子代理自己的呼叫結構', () => {
  it('派出子代理的那顆工具底下有區塊；沒派子代理的工具沒有', async () => {
    mount(scenario(undefined));
    await flush();
    const row = document.querySelector<HTMLElement>('[data-testid="trace-row"][data-kind="tool"]')!;
    fireEvent.click(row.querySelector('button')!);
    expect(screen.queryByTestId('trace-subagent-block')).toBeNull();
  });

  it('推送的最新一輪直接畫：逐次呼叫、重試、工具（只有結構），第一輪標「交付的任務」', async () => {
    mount(scenario('bg-1', { trajectory: view([childTurn(1)]) }));
    const block = await expandSubagent();
    const calls = within(block).getAllByTestId('trace-subagent-call');
    expect(calls).toHaveLength(2);
    expect(within(block).getByTestId('trace-subagent-turn').textContent).toContain('交付的任務');
    // 原因走失敗碼的一句話（#1449），原碼留在 `data-failure-code` 與 `title`。
    const retry = within(calls[0]!).getByTestId('trace-subagent-retry');
    expect(retry.textContent).toContain('重試 1/3 · 被限流 · HTTP 429 · 等了');
    const code = retry.querySelector('[data-failure-code]')!;
    expect(code.getAttribute('data-failure-code')).toBe('RATE_LIMIT');
    expect(code.getAttribute('title')).toBe('RATE_LIMIT');
    expect(within(calls[0]!).getByTestId('trace-subagent-tool').textContent).toContain('ls');
    expect(within(calls[0]!).getByTestId('trace-subagent-tool').textContent).toContain('完成');
    // 沒有內文：子代理的訊息不在這條路上。
    expect(block.textContent).not.toContain('SYS-CANARY');
  });

  it('一輪收成 SG StepGroup 的一行計數，預設打開；收起來呼叫列就不在（#1690 T7）', async () => {
    mount(scenario('bg-1', { trajectory: view([childTurn(1)]) }));
    const block = await expandSubagent();
    const summary = within(block).getByRole('button', { name: '2 次呼叫，1 個工具' });
    expect(summary.getAttribute('aria-expanded')).toBe('true');
    expect(within(block).getAllByTestId('trace-subagent-call')).toHaveLength(2);
    fireEvent.click(summary);
    expect(within(block).queryAllByTestId('trace-subagent-call')).toHaveLength(0);
  });

  it('計數帶失敗與執行中；只有一步的輪不包群組，直接畫那一列', async () => {
    mount(
      scenario('bg-1', {
        trajectory: view([
          turn(1, {
            seq: 10,
            calls: [
              call(101, {
                tools: [
                  tool('k1', { name: 'grep', status: 'error' }),
                  tool('k2', { name: 'ls', status: 'running' }),
                ],
              }),
            ],
          }),
          turn(2, { seq: 20, calls: [call(201)] }),
        ]),
      }),
    );
    const block = await expandSubagent();
    const [first, second] = within(block).getAllByTestId('trace-subagent-turn');
    expect(
      within(first!).getByRole('button', { name: '1 次呼叫，2 個工具（1 個失敗），執行中' }),
    ).toBeTruthy();
    expect(second!.querySelector('[data-slot="step-group"]')).toBeNull();
    expect(within(second!).getAllByTestId('trace-subagent-call')).toHaveLength(1);
  });

  it('子代理自己的快照：呼叫列的系統提示詞與設定讀它自己的 request-snapshots', async () => {
    const snapshots: RequestSnapshotsView = {
      system: [{ seq: 8, time: 1, reason: 'initial', text: '子代理系統提示', chars: 7 }],
      header: [],
    };
    mount(
      scenario('bg-1', {
        trajectory: view([turn(1, { calls: [call(5, { system: 8 })] })]),
        snapshots,
      }),
    );
    const block = await expandSubagent();
    fireEvent.click(within(block).getByRole('button', { name: /^模型呼叫 #1/ }));
    expect(within(block).getByTestId('trace-call-details').textContent).toContain('7 字元');
  });

  it('沒有這個子代理的軌跡（沒宣告 children、或重整後）：說沒有資料，不拋錯', async () => {
    mount(scenario('bg-1'));
    const block = await expandSubagent();
    expect(within(block).getByTestId('trace-subagent-nodata').textContent).toBe(
      SUBAGENT_CALLS_NO_DATA_TEXT,
    );
  });

  it('更早的輪是摘要：展開才拉（帶 runId 與 seq），拉回來換成逐呼叫結構', async () => {
    const { client, queries, waiting } = fakeClient();
    mount(
      scenario('bg-1', {
        trajectory: view([childTurn(3)], { digests: [digest(1, { seq: 10 })] }),
      }),
      client,
    );
    const block = await expandSubagent();
    expect(client.trajectoryTurn).not.toHaveBeenCalled();
    fireEvent.click(within(block).getByRole('button', { name: /拉|載入|看/ }));
    expect(queries).toEqual([{ runId: 'bg-1', seq: 10 }]);
    await act(async () => {
      waiting[0]!({ kind: 'ok', result: { turns: [childTurn(1)], seq: 99 } });
    });
    expect(within(block).queryByTestId('trace-subagent-digest')).toBeNull();
    expect(within(block).getAllByTestId('trace-subagent-turn')).toHaveLength(2);
  });

  describe('前景子代理的呼叫被時鐘切斷（#2240）', () => {
    const clock = { kind: 'hook', reason: 'turn-timeout' } as const;
    const foreground = view([
      turn(0, { seq: 5, kind: 'run', end: undefined, calls: [call(6, { outcome: 'aborted' })] }),
    ]);

    async function outcomeShown(parent: Parameters<typeof scenario>[1]) {
      mount(scenario('tools:u1', parent));
      const block = await expandSubagent();
      const label = within(block).getByText(/已中止/);
      return [label.textContent, label.className.includes('text-destructive')];
    }

    it('父輪時鐘到點：講時間到，不用紅字', async () => {
      expect(
        await outcomeShown({
          trajectory: foreground,
          parentTurn: { end: 'aborted', endCause: clock },
        }),
      ).toEqual(['超過時間上限，已中止', false]);
    });

    it('時鐘切在核准之後的續接段：看整組最後一段', async () => {
      expect(
        await outcomeShown({
          trajectory: foreground,
          parentTurn: { end: 'interrupted' },
          laterTurns: [turn(1, { seq: 40, logical: false, end: 'aborted', endCause: clock })],
        }),
      ).toEqual(['超過時間上限，已中止', false]);
    });

    it.each([
      ['人按的', { end: 'aborted', endCause: { kind: 'user' } }],
      ['別的 hook', { end: 'aborted', endCause: { kind: 'hook', reason: 'some-other-hook' } }],
      ['沒帶原因', { end: 'aborted' }],
    ] as const)('父輪是%s：維持「已中止」', async (_name, parentTurn) => {
      expect(await outcomeShown({ trajectory: foreground, parentTurn })).toEqual(['已中止', true]);
    });

    it('背景子代理不借父輪的原因：它自己沒帶就維持「已中止」', async () => {
      expect(
        await outcomeShown({
          trajectory: view([
            turn(0, { seq: 5, end: 'aborted', calls: [call(6, { outcome: 'aborted' })] }),
          ]),
          parentTurn: { end: 'aborted', endCause: clock },
        }),
      ).toEqual(['已中止', true]);
    });

    it('拉回來的那一段也一樣', async () => {
      const { client, waiting } = fakeClient();
      mount(
        scenario('tools:u1', {
          trajectory: view([], { digests: [digest(0, { seq: 5, kind: 'run', end: undefined })] }),
          parentTurn: { end: 'aborted', endCause: clock },
        }),
        client,
      );
      const block = await expandSubagent();
      await act(async () => {
        waiting[0]!({
          kind: 'ok',
          result: {
            turns: [
              turn(0, {
                seq: 5,
                kind: 'run',
                end: undefined,
                calls: [call(6, { outcome: 'aborted' })],
              }),
            ],
            seq: 9,
          },
        });
      });
      expect(within(block).getByText(/已中止/).textContent).toBe('超過時間上限，已中止');
    });
  });

  it('前景子代理整段只有一份摘要：展開就自己拉，拉回來的是「一段執行」，可重新載入', async () => {
    const { client, queries, waiting } = fakeClient();
    mount(
      scenario('tools:u1', {
        trajectory: view([], { digests: [digest(0, { seq: 5, kind: 'run', end: undefined })] }),
      }),
      client,
    );
    const block = await expandSubagent();
    expect(queries).toEqual([{ runId: 'tools:u1', seq: 5 }]);
    await act(async () => {
      waiting[0]!({
        kind: 'ok',
        result: {
          turns: [turn(0, { seq: 5, kind: 'run', end: undefined, calls: [call(6)] })],
          seq: 9,
        },
      });
    });
    expect(within(block).getByTestId('trace-subagent-turn').textContent).toContain('一段執行');
    // 前景 run 沒有輪的邊界：不畫耗時與結束狀態。
    expect(within(block).getByTestId('trace-subagent-turn').textContent).not.toContain('進行中');
    fireEvent.click(within(block).getByRole('button', { name: SUBAGENT_CALLS_RELOAD_LABEL }));
    expect(queries).toEqual([
      { runId: 'tools:u1', seq: 5 },
      { runId: 'tools:u1', seq: 5 },
    ]);
  });

  describe('重新載入的焦點（#2135）', () => {
    async function pulledBlock() {
      const { client, waiting } = fakeClient();
      mount(
        scenario('bg-1', {
          trajectory: view([childTurn(3)], { digests: [digest(1, { seq: 10 })] }),
        }),
        client,
      );
      const block = await expandSubagent();
      fireEvent.click(within(block).getByRole('button', { name: /拉|載入|看/ }));
      await act(async () => {
        waiting[0]!({ kind: 'ok', result: { turns: [childTurn(1)], seq: 99 } });
      });
      const button = within(block).getByRole('button', { name: SUBAGENT_CALLS_RELOAD_LABEL });
      button.focus();
      fireEvent.click(button);
      return { block, button, waiting };
    }

    it('讀取中焦點留在鈕上，看得見的字就是報讀名稱，再按不會多拉一次', async () => {
      const { block, button, waiting } = await pulledBlock();
      expect(button.isConnected).toBe(true);
      expect(document.activeElement).toBe(button);
      expect(button.getAttribute('aria-disabled')).toBe('true');
      expect(within(block).getByRole('button', { name: SUBAGENT_CALLS_RELOAD_LABEL })).toBe(button);
      expect(button.textContent).toBe(SUBAGENT_CALLS_RELOAD_LABEL);
      fireEvent.click(button);
      expect(waiting).toHaveLength(2);
    });

    it('讀完落在拉回來那一輪的標題', async () => {
      const { block, waiting } = await pulledBlock();
      await act(async () => {
        waiting[1]!({ kind: 'ok', result: { turns: [childTurn(1)], seq: 99 } });
      });
      const pulled = within(block).getAllByTestId('trace-subagent-turn')[0]!;
      expect(document.activeElement).toBe(pulled.querySelector('[data-subagent-turn-head]'));
    });

    it('失敗落在重試，拉回來過的內容留著', async () => {
      const { block, button, waiting } = await pulledBlock();
      await act(async () => {
        waiting[1]!({ kind: 'rejected', code: 'SUBAGENT_NOT_FOUND', message: '找不到這個子代理' });
      });
      const retry = within(block).getByRole('button', { name: TRACE_PULL_RETRY_LABEL });
      expect(retry).toBe(button);
      expect(document.activeElement).toBe(retry);
      expect(block.textContent).toContain('找不到這個子代理');
      expect(within(block).getAllByTestId('trace-subagent-turn')).toHaveLength(2);
    });
  });

  it('拉取失敗：顯示伺服器的原因，可重試', async () => {
    const { client, waiting } = fakeClient();
    mount(
      scenario('bg-1', {
        trajectory: view([childTurn(3)], { digests: [digest(1, { seq: 10 })] }),
      }),
      client,
    );
    const block = await expandSubagent();
    fireEvent.click(within(block).getByRole('button', { name: /拉|載入|看/ }));
    await act(async () => {
      waiting[0]!({ kind: 'rejected', code: 'SUBAGENT_NOT_FOUND', message: '找不到這個子代理' });
    });
    expect(block.textContent).toContain('找不到這個子代理');
  });

  it('鍵盤按「載入這一輪的細節」（#2009）：讀取中焦點留在同一顆鈕上、再按不會再拉；拉回來落在拉回來那一輪的標題', async () => {
    const { client, queries, waiting } = fakeClient();
    mount(
      scenario('bg-1', {
        trajectory: view([childTurn(3)], { digests: [digest(1, { seq: 10 })] }),
      }),
      client,
    );
    const block = await expandSubagent();
    const button = within(block).getByRole('button', { name: TRACE_PULL_LABEL });
    button.focus();
    fireEvent.click(button);
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.textContent).toBe(TRACE_PULL_LABEL);
    expect(within(block).getByRole('button', { name: TRACE_PULL_LABEL })).toBe(button);
    fireEvent.click(button);
    expect(queries).toHaveLength(1);
    await act(async () => {
      waiting[0]!({ kind: 'ok', result: { turns: [childTurn(1)], seq: 99 } });
    });
    const pulled = within(block).getAllByTestId('trace-subagent-turn')[0]!;
    expect(pulled.getAttribute('data-seq')).toBe('10');
    expect(document.activeElement).toBe(pulled.querySelector('[data-subagent-turn-head]'));
  });

  it('鍵盤按下去失敗（#2009）：焦點留在同一顆鈕上，它改成「重試」', async () => {
    const { client, waiting } = fakeClient();
    mount(
      scenario('bg-1', {
        trajectory: view([childTurn(3)], { digests: [digest(1, { seq: 10 })] }),
      }),
      client,
    );
    const block = await expandSubagent();
    const button = within(block).getByRole('button', { name: TRACE_PULL_LABEL });
    button.focus();
    fireEvent.click(button);
    await act(async () => {
      waiting[0]!({ kind: 'rejected', code: 'SUBAGENT_NOT_FOUND', message: '找不到這個子代理' });
    });
    expect(within(block).getByRole('button', { name: TRACE_PULL_RETRY_LABEL })).toBe(button);
    expect(document.activeElement).toBe(button);
  });

  it('前景子代理一展開就自己拉（#2009）：焦點停到讀取中的鈕上，拉回來就交到那一輪的標題', async () => {
    const { client, waiting } = fakeClient();
    mount(
      scenario('tools:u1', {
        trajectory: view([], { digests: [digest(0, { seq: 5, kind: 'run', end: undefined })] }),
      }),
      client,
    );
    const block = await expandSubagent();
    const button = within(block).getByRole('button', { name: TRACE_PULL_LABEL });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    button.focus();
    await act(async () => {
      waiting[0]!({
        kind: 'ok',
        result: {
          turns: [turn(0, { seq: 5, kind: 'run', end: undefined, calls: [call(6)] })],
          seq: 9,
        },
      });
    });
    expect(document.activeElement).toBe(
      within(block).getByTestId('trace-subagent-turn').querySelector('[data-subagent-turn-head]'),
    );
  });

  it('主對話與子代理有同樣 seq 的輪：「看這一輪」落在主對話那一份（#2136）', async () => {
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    localStorage.setItem(LAYOUT_KEY_PREFIX + 't', JSON.stringify(open));
    render(
      <WithRightSidebar
        sources={{
          conversation: createConversationStore(
            scenario('bg-1', {
              trajectory: view([childTurn(3)]),
              laterTurns: [turn(1, { seq: 30, calls: [call(40)] })],
            }),
          ),
        }}
      >
        <RightSidebarToggle />
        <RevealProbe seq={30} />
      </WithRightSidebar>,
    );
    await expandSubagent();
    const nested = screen.getByTestId('trace-subagent-turn');
    expect(nested.getAttribute('data-seq')).toBe('30');
    fireEvent.click(screen.getByRole('button', { name: '看這一輪' }));
    await flush();
    const main = document.querySelector<HTMLElement>(
      'section[data-testid="trace-turn"][data-seq="30"]',
    )!;
    expect(document.activeElement).toBe(main.querySelector('[data-reveal-target]'));
    expect(scrolled).toContain(main);
    expect(scrolled).not.toContain(nested);
  });

  it('分頁關掉（卸載）時，還在飛的拉取被取消', async () => {
    const { client, signals } = fakeClient();
    const { unmount } = mount(
      scenario('bg-1', {
        trajectory: view([childTurn(3)], { digests: [digest(1, { seq: 10 })] }),
      }),
      client,
    );
    const block = await expandSubagent();
    fireEvent.click(within(block).getByRole('button', { name: /拉|載入|看/ }));
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);
    unmount();
    expect(signals[0]!.aborted).toBe(true);
  });

  it('沒掛拉取通道：摘要照舊並說明', async () => {
    mount(
      scenario('bg-1', {
        trajectory: view([childTurn(3)], { digests: [digest(1, { seq: 10 })] }),
      }),
    );
    const block = await expandSubagent();
    expect(block.textContent).toContain(SUBAGENT_CALLS_NO_PULL_TEXT);
  });
});
