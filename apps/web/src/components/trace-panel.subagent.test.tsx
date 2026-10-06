import type {
  ConversationState,
  RequestSnapshotsView,
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

import { RightSidebarToggle } from '@/components/right-sidebar';
import {
  SUBAGENT_CALLS_NO_DATA_TEXT,
  SUBAGENT_CALLS_NO_PULL_TEXT,
  SUBAGENT_CALLS_RELOAD_LABEL,
  SUBAGENT_CALLS_TITLE,
} from '@/components/trace-subagent';
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

/** root：一輪、一次呼叫、一顆派出子代理的工具（`subagent` 這顆）。 */
function scenario(
  runId: string | undefined,
  child?: { trajectory?: TrajectoryView; snapshots?: RequestSnapshotsView },
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
    expect(within(calls[0]!).getByTestId('trace-subagent-retry').textContent).toContain(
      '重試 1/3 · RATE_LIMIT · HTTP 429 · 等了',
    );
    expect(within(calls[0]!).getByTestId('trace-subagent-tool').textContent).toContain('ls');
    expect(within(calls[0]!).getByTestId('trace-subagent-tool').textContent).toContain('完成');
    // 沒有內文：子代理的訊息不在這條路上。
    expect(block.textContent).not.toContain('SYS-CANARY');
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
