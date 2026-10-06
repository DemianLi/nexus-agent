import type { ConversationState, TrajectoryReply, TrajectoryTurnOutcome } from '@nexus/wire';
import { emptyConversation, reduceAll } from '@nexus/wire';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RightSidebarToggle, useRightSidebar } from '@/components/sidebar/right-sidebar';
import { TRACE_REPLY_OLDER_TEXT, TRACE_REVEALED_TEXT } from '@/components/trace/trace-panel';
import {
  TRACE_PULL_FAILED_TEXT,
  TRACE_PULL_LABEL,
  TRACE_PULL_LOADING_TEXT,
  TRACE_PULL_RETRY_LABEL,
  TRACE_PULL_SUMMARY_ONLY_TEXT,
} from '@/components/trace/trace-pull-control';
import { createConversationStore } from '@/lib/conversation-store';
import { LAYOUT_KEY_PREFIX } from '@/lib/right-sidebar';
import type { SidebarLayout } from '@/lib/right-sidebar';
import { createTrajectoryPuller } from '@/lib/trajectory-pull';
import { Script } from '@/test/conversation-frames';
import { memoryStorage, WithRightSidebar } from '@/test/right-sidebar';
import { call, digest, turn, view, withTrajectory } from '@/test/trajectory-fixtures';

const scrolled: Element[] = [];

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  scrolled.length = 0;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const traceOpen: SidebarLayout = { open: true, tabs: [{ kind: 'trace' }], active: 'trace' };
const closed: SidebarLayout = { open: false, tabs: [], active: undefined };

const reply = (seq: number, messageId: string): TrajectoryReply => ({
  seq,
  time: 1_700_000_000_000 + seq,
  messageId,
  textChars: 5,
  reasoningChars: 0,
  toolCalls: 0,
});

/** 手動放行的假端點：每次呼叫記下查詢，回應由測試決定。 */
function fakeClient() {
  const queries: { seq?: number; messageId?: string }[] = [];
  const waiting: ((outcome: TrajectoryTurnOutcome) => void)[] = [];
  return {
    queries,
    waiting,
    client: {
      trajectoryTurn: vi.fn(
        (_threadId: string, query: { seq?: number; messageId?: string }) =>
          new Promise<TrajectoryTurnOutcome>((resolve) => {
            queries.push(query);
            waiting.push(resolve);
          }),
      ),
    },
  };
}

const okTurns = (...turns: ReturnType<typeof turn>[]): TrajectoryTurnOutcome => ({
  kind: 'ok',
  result: { turns, seq: 900 },
});

/**
 * 四輪（seq 100、200、300、400），推送只帶最後一輪的細節，前三輪是摘要（PR 2 之後的形狀）。
 * 每一輪的回覆都已載入在對話裡。
 */
function scenario() {
  const script = new Script();
  const frames = [];
  for (const n of [1, 2, 3, 4]) {
    frames.push(
      script.running(),
      ...script.human(`inbox:r${n}`, `第 ${n} 輪`),
      ...script.ai(`m${n}`, { text: `第 ${n} 輪的回覆` }),
      script.completed(),
    );
  }
  const state = reduceAll(emptyConversation(), frames);
  const trajectory = view([turn(4, { calls: [call(40, { reply: reply(42, 'run-m4') })] })], {
    digests: [digest(1), digest(2), digest(3)],
  });
  return withTrajectory(state, script, trajectory);
}

/** 第 n 輪完整的細節：一次呼叫、回覆是第 n 輪那一則。 */
const detail = (n: number) =>
  turn(n, { calls: [call(n * 10, { reply: reply(n * 10 + 2, `run-m${n}`) })] });

function Probe({ seq, messageId }: { seq?: number; messageId?: string }) {
  const api = useRightSidebar();
  return (
    <>
      <button type="button" onClick={() => api?.revealTurn(seq!)}>
        看這一輪
      </button>
      <button type="button" onClick={(event) => api?.revealReply(messageId!, event.currentTarget)}>
        這一輪的過程
      </button>
    </>
  );
}

function mount(
  state: ConversationState,
  client: ReturnType<typeof fakeClient>['client'],
  options: { layout?: SidebarLayout; probe?: { seq?: number; messageId?: string } } = {},
) {
  localStorage.setItem(LAYOUT_KEY_PREFIX + 't', JSON.stringify(options.layout ?? traceOpen));
  const puller = createTrajectoryPuller(client, 't');
  const utils = render(
    <WithRightSidebar
      sources={{ conversation: createConversationStore(state), trajectoryPull: puller }}
    >
      <RightSidebarToggle />
      {options.probe !== undefined && <Probe {...options.probe} />}
    </WithRightSidebar>,
  );
  return { puller, ...utils };
}

const group = (seq: number) =>
  document.querySelector<HTMLElement>(`section[data-testid="trace-turn"][data-seq="${seq}"]`);
const digestRow = (seq: number) =>
  document.querySelector<HTMLElement>(`[data-testid="trace-digest"][data-seq="${seq}"]`);
const notice = () => document.querySelector('[data-testid="trace-reveal-notice"]');
const flush = () => act(async () => {});

describe('預拉（#1083）', () => {
  it('分頁看得見時：窗口前面最近兩個邏輯輪預先拉，新的在前；拉回來的是完整的一組、摘要少兩列', async () => {
    const { client, queries, waiting } = fakeClient();
    mount(scenario(), client);
    await flush();
    expect(queries).toEqual([{ seq: 300 }, { seq: 200 }]);
    expect(group(300)).toBeNull();
    await act(async () => {
      waiting[0]!(okTurns(detail(3)));
      waiting[1]!(okTurns(detail(2)));
    });
    expect(group(200)).not.toBeNull();
    expect(group(300)).not.toBeNull();
    expect(group(300)!.textContent).toContain('第 3 輪的回覆');
    // 第 1 輪還是摘要，在「更早的輪」區塊裡。
    expect(screen.getByTestId('trace-digests').textContent).toContain('更早的 1 輪');
  });

  it('分頁藏著（側邊欄關著）：一個請求都不送', async () => {
    const { client } = fakeClient();
    mount(scenario(), client, { layout: closed });
    await flush();
    expect(client.trajectoryTurn).not.toHaveBeenCalled();
  });

  it('預拉失敗：不自動重試，摘要照舊；不阻擋畫面', async () => {
    const { client, waiting } = fakeClient();
    mount(scenario(), client);
    await flush();
    await act(async () => {
      waiting[0]!({ kind: 'rejected', code: 'turn_not_found', message: '沒有那一輪' });
      waiting[1]!({ kind: 'rejected', code: 'turn_not_found', message: '沒有那一輪' });
    });
    expect(client.trajectoryTurn).toHaveBeenCalledTimes(2);
    expect(group(300)).toBeNull();
    expect(screen.getByTestId('trace-digests')).not.toBeNull();
  });
});

describe('子代理數', () => {
  it('摘要列與完整輪的標題：有派子代理才寫「N 個子代理」，沒有就不寫', async () => {
    const script = new Script();
    const state = withTrajectory(
      reduceAll(emptyConversation(), []),
      script,
      view([turn(3, { subagentCount: 2 }), turn(4)], {
        digests: [digest(1, { subagentCount: 3 }), digest(2)],
      }),
    );
    mount(state, fakeClient().client);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /更早的 2 輪/ }));
    expect(within(digestRow(100)!).getByTestId('trace-subagent-count').textContent).toBe(
      '3 個子代理',
    );
    expect(within(digestRow(200)!).queryByTestId('trace-subagent-count')).toBeNull();
    expect(within(group(300)!).getByTestId('trace-subagent-count').textContent).toBe('2 個子代理');
    expect(within(group(400)!).queryByTestId('trace-subagent-count')).toBeNull();
  });
});

describe('摘要列的「載入這一輪的細節」', () => {
  async function opened() {
    const fake = fakeClient();
    const utils = mount(scenario(), fake.client);
    await flush();
    // 預拉的兩顆先放行成空結果，剩下第 1 輪留給按鈕。
    await act(async () => {
      fake.waiting[0]!(okTurns(detail(3)));
      fake.waiting[1]!(okTurns(detail(2)));
    });
    fireEvent.click(screen.getByRole('button', { name: /更早的 1 輪/ }));
    return { ...fake, ...utils };
  }

  it('按下去：進行中時鈕停用並講進度；拉回來就換成完整的一組', async () => {
    const { client, waiting, queries } = await opened();
    const row = digestRow(100)!;
    fireEvent.click(within(row).getByRole('button', { name: TRACE_PULL_LABEL }));
    await flush();
    expect(queries.at(-1)).toEqual({ seq: 100 });
    expect(within(row).getByRole('button', { name: TRACE_PULL_LOADING_TEXT })).toHaveProperty(
      'disabled',
      true,
    );
    expect(client.trajectoryTurn).toHaveBeenCalledTimes(3);
    await act(async () => {
      waiting.at(-1)!(okTurns(detail(1)));
    });
    expect(group(100)).not.toBeNull();
    expect(screen.queryByTestId('trace-digests')).toBeNull();
  });

  it('失敗：把伺服器給的原因原樣說出來（不加前綴詞以外的東西），給重試；重試成功就好', async () => {
    const { waiting } = await opened();
    const row = digestRow(100)!;
    fireEvent.click(within(row).getByRole('button', { name: TRACE_PULL_LABEL }));
    await flush();
    await act(async () => {
      waiting.at(-1)!({ kind: 'rejected', code: 'invalid_argument', message: '錨點不對' });
    });
    expect(within(row).getByTestId('trace-pull-failed').textContent).toBe(
      `${TRACE_PULL_FAILED_TEXT}錨點不對`,
    );
    fireEvent.click(within(row).getByRole('button', { name: TRACE_PULL_RETRY_LABEL }));
    await flush();
    await act(async () => {
      waiting.at(-1)!(okTurns(detail(1)));
    });
    expect(group(100)).not.toBeNull();
  });

  it('沒有拉取（沒給 trajectoryPull）：摘要列沒有載入鈕', async () => {
    localStorage.setItem(LAYOUT_KEY_PREFIX + 't', JSON.stringify(traceOpen));
    render(
      <WithRightSidebar sources={{ conversation: createConversationStore(scenario()) }}>
        <RightSidebarToggle />
      </WithRightSidebar>,
    );
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /更早的 3 輪/ }));
    expect(screen.queryByRole('button', { name: TRACE_PULL_LABEL })).toBeNull();
  });
});

describe('中間那一輪拉回來：後面還沒拉的摘要補成「只有摘要」的組', () => {
  it('順序是完整輪 → 只有摘要的組（有載入鈕；預拉失敗過的講原因、給重試）→ 窗口那一輪', async () => {
    const fake = fakeClient();
    mount(scenario(), fake.client, { probe: { seq: 100 } });
    await flush();
    // 預拉：300 回來是空的（不算失敗，也沒拉到東西）、200 被拒絕。再用「看這一輪」去拉第 1 輪。
    await act(async () => {
      fake.waiting[0]!(okTurns());
      fake.waiting[1]!({ kind: 'rejected', code: 'turn_not_found', message: '日誌裡沒有' });
    });
    fireEvent.click(screen.getByRole('button', { name: '看這一輪' }));
    await flush();
    await act(async () => {
      fake.waiting.at(-1)!(okTurns(detail(1)));
    });
    // 沒歸進任何一輪的對話條目（legacy 組）沒有 `data-seq`，不算在內。
    const seqs = [...document.querySelectorAll('section[data-testid="trace-turn"][data-seq]')].map(
      (s) => s.getAttribute('data-seq'),
    );
    expect(seqs).toEqual(['100', '200', '300', '400']);
    const failed = group(200)!;
    expect(failed.textContent).toContain(TRACE_PULL_SUMMARY_ONLY_TEXT);
    expect(failed.textContent).toContain(`${TRACE_PULL_FAILED_TEXT}日誌裡沒有`);
    expect(within(failed).getByRole('button', { name: TRACE_PULL_RETRY_LABEL })).not.toBeNull();
    const idle = group(300)!;
    expect(idle.textContent).toContain(TRACE_PULL_SUMMARY_ONLY_TEXT);
    expect(within(idle).getByRole('button', { name: TRACE_PULL_LABEL })).not.toBeNull();
    expect(group(100)!.textContent).not.toContain(TRACE_PULL_SUMMARY_ONLY_TEXT);
    // 按只有摘要的那一組的鈕：照一般的拉。
    const before = fake.queries.length;
    fireEvent.click(within(idle).getByRole('button', { name: TRACE_PULL_LABEL }));
    await flush();
    expect(fake.queries.slice(before)).toEqual([{ seq: 300 }]);
    await act(async () => {
      fake.waiting.at(-1)!(okTurns(detail(3)));
    });
    expect(group(300)!.textContent).not.toContain(TRACE_PULL_SUMMARY_ONLY_TEXT);
    expect(group(300)!.textContent).toContain('第 3 輪的回覆');
  });
});

describe('「看這一輪」落在摘要：先拉再定位', () => {
  it('拉的時候在上面講「正在載入」；拉回來之後捲到完整的那一組、標示、焦點在標題', async () => {
    const fake = fakeClient();
    mount(scenario(), fake.client, { probe: { seq: 100 } });
    await flush();
    await act(async () => {
      fake.waiting[0]!({ kind: 'rejected', code: 'turn_not_found', message: 'x' });
      fake.waiting[1]!({ kind: 'rejected', code: 'turn_not_found', message: 'x' });
    });
    fireEvent.click(screen.getByRole('button', { name: '看這一輪' }));
    await flush();
    expect(fake.queries.at(-1)).toEqual({ seq: 100 });
    expect(notice()?.textContent).toBe(TRACE_PULL_LOADING_TEXT);
    // 還沒拉回來之前不捲到摘要列。
    expect(scrolled.filter((el) => el.matches('[data-testid="trace-digest"]'))).toHaveLength(0);
    await act(async () => {
      fake.waiting.at(-1)!(okTurns(detail(1)));
    });
    const target = group(100)!;
    expect(scrolled).toContain(target);
    expect(document.activeElement).toBe(target.querySelector('[data-reveal-target]'));
    expect(target.hasAttribute('data-revealed')).toBe(true);
    expect(notice()).toBeNull();
    expect(
      document.querySelector('[data-testid="right-sidebar-panel-trace"] [role=status]')
        ?.textContent,
    ).toBe(TRACE_REVEALED_TEXT);
  });

  it('拉失敗：講原因，再退回老辦法（捲到摘要列標示），不是靜靜沒反應', async () => {
    const fake = fakeClient();
    mount(scenario(), fake.client, { probe: { seq: 100 } });
    await flush();
    await act(async () => {
      fake.waiting[0]!({ kind: 'rejected', code: 'turn_not_found', message: 'x' });
      fake.waiting[1]!({ kind: 'rejected', code: 'turn_not_found', message: 'x' });
    });
    fireEvent.click(screen.getByRole('button', { name: '看這一輪' }));
    await flush();
    await act(async () => {
      fake.waiting.at(-1)!({
        kind: 'rejected',
        code: 'not_supported',
        message: '這個會話沒有軌跡',
      });
    });
    expect(notice()?.textContent).toBe(`${TRACE_PULL_FAILED_TEXT}這個會話沒有軌跡`);
    const row = digestRow(100)!;
    expect(row).not.toBeNull();
    expect(scrolled).toContain(row);
  });
});

describe('回覆底下的「這一輪的過程」落在摘要：用訊息 id 拉', () => {
  it('歸不進任何輪的回覆：先講載入中、用 messageId 拉；拉回來就捲到那一輪', async () => {
    const fake = fakeClient();
    mount(scenario(), fake.client, { layout: closed, probe: { messageId: 'run-m2' } });
    await flush();
    fireEvent.click(screen.getByRole('button', { name: '這一輪的過程' }));
    await flush();
    // 打開之後預拉也會送（300、200）；訊息 id 的那顆用它自己的錨點。
    const at = fake.queries.findIndex((query) => query.messageId === 'run-m2');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(notice()?.textContent).toBe(TRACE_PULL_LOADING_TEXT);
    await act(async () => {
      fake.waiting[at]!(okTurns(detail(2)));
    });
    const target = group(200)!;
    expect(scrolled).toContain(target);
    expect(target.hasAttribute('data-revealed')).toBe(true);
    expect(notice()).toBeNull();
  });

  it('伺服器說沒有那一輪：講原本那句（軌跡窗口之前），不把「找不到」當成失敗原因', async () => {
    const fake = fakeClient();
    mount(scenario(), fake.client, { layout: closed, probe: { messageId: 'run-gone' } });
    await flush();
    fireEvent.click(screen.getByRole('button', { name: '這一輪的過程' }));
    await flush();
    await act(async () => {
      fake.waiting[fake.queries.findIndex((query) => query.messageId !== undefined)]!({
        kind: 'rejected',
        code: 'turn_not_found',
        message: '日誌裡沒有',
      });
    });
    expect(notice()?.textContent).toBe(TRACE_REPLY_OLDER_TEXT);
  });

  it('連線出問題：原本那句後面帶上原因', async () => {
    const fake = fakeClient();
    mount(scenario(), fake.client, { layout: closed, probe: { messageId: 'run-gone' } });
    await flush();
    fireEvent.click(screen.getByRole('button', { name: '這一輪的過程' }));
    await flush();
    await act(async () => {
      fake.waiting[fake.queries.findIndex((query) => query.messageId !== undefined)]!({
        kind: 'rejected',
        code: 'invalid_argument',
        message: '錨點不對',
      });
    });
    expect(notice()?.textContent).toBe(
      `${TRACE_REPLY_OLDER_TEXT}（${TRACE_PULL_FAILED_TEXT}錨點不對）`,
    );
  });
});
