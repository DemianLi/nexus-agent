import { emptyConversation, reduceAll } from '@nexus/wire';
import type { AiEntry, ConversationEntry, ConversationState, ToolEntry } from '@nexus/wire';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ELAPSED_TICK_MS, StatusLine } from '@/components/status-line';
import { serverClock } from '@/lib/server-clock';
import { STOPPED_STATUS_TEXT, TIMED_OUT_STATUS_TEXT } from '@/lib/stop-cause';
import { THREAD_AT_CAPACITY_TEXT } from '@/lib/thread-capacity';
import { THREAD_IS_SUBAGENT_TEXT } from '@/lib/thread-subagent';
import type { Activity } from '@/components/ui/status-glyph';
import { Script } from '@/test/conversation-frames';
import { drawnPose, openingPose, stubGlyphEnvironment } from '@/test/glyph-env';
import { turn, view, withTrajectory } from '@/test/trajectory-fixtures';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  serverClock.reset();
});

const idle = emptyConversation();

describe('StatusLine 的連線那幾句（#593）', () => {
  it('連上過、中斷了：講正在重新連線，旁邊一顆「立刻重連」，按鈕不在 live region 裡', () => {
    const onReconnect = vi.fn();
    render(
      <StatusLine
        state={idle}
        connected={false}
        connectionError="network error"
        reconnecting={{ wasConnected: true, offline: false }}
        onReconnect={onReconnect}
      />,
    );
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('連線中斷，正在重新連線…');
    const button = screen.getByRole('button', { name: '立刻重連' });
    expect(status.contains(button)).toBe(false);
    fireEvent.click(button);
    expect(onReconnect).toHaveBeenCalledOnce();
  });

  it('從沒連上過：講連不上與原因', () => {
    render(
      <StatusLine
        state={idle}
        connected={false}
        connectionError="connection refused"
        reconnecting={{ wasConnected: false, offline: false }}
      />,
    );
    expect(screen.getByRole('status').textContent).toBe(
      '連不上 agent：connection refused。正在重試…',
    );
  });

  it.each([false, true])(
    '伺服器明說不收這條下行（#1478）：換成那一句，不接原文；重連鈕還在（連上過：%s）',
    (wasConnected) => {
      render(
        <StatusLine
          state={idle}
          connected={false}
          connectionError="下行被拒：上限 2／2，重啟 serve 才釋放"
          refusal={THREAD_AT_CAPACITY_TEXT}
          reconnecting={{ wasConnected, offline: false }}
          onReconnect={() => undefined}
        />,
      );
      expect(screen.getByRole('status').textContent).toBe(THREAD_AT_CAPACITY_TEXT);
      expect(screen.getByRole('button', { name: '立刻重連' })).toBeTruthy();
    },
  );

  it('伺服器說永遠不收（子代理的會話，#1708）：單獨講那一句，沒有「立刻重連」', () => {
    render(
      <StatusLine
        state={idle}
        connected={false}
        refusal={THREAD_IS_SUBAGENT_TEXT}
        onReconnect={() => undefined}
      />,
    );
    expect(screen.getByRole('status').textContent).toBe(THREAD_IS_SUBAGENT_TEXT);
    expect(screen.queryByRole('button', { name: '立刻重連' })).toBeNull();
  });

  it('瀏覽器離線排在不收前面：離線時那條下行根本沒送出去', () => {
    render(
      <StatusLine
        state={idle}
        connected={false}
        refusal={THREAD_AT_CAPACITY_TEXT}
        reconnecting={{ wasConnected: false, offline: true }}
      />,
    );
    expect(screen.getByRole('status').textContent).toBe('網路離線：恢復之後會自動重新連線');
  });

  it('瀏覽器離線：講恢復之後會自動重連', () => {
    render(
      <StatusLine
        state={idle}
        connected={false}
        reconnecting={{ wasConnected: true, offline: true }}
      />,
    );
    expect(screen.getByRole('status').textContent).toBe('網路離線：恢復之後會自動重新連線');
  });

  it('剛接回來：就緒那一格換成「已重新連線」', () => {
    render(<StatusLine state={idle} connected recovered />);
    expect(screen.getByRole('status').textContent).toBe('已重新連線');
  });

  it('剛接回來但正在跑：講執行中，不蓋掉', () => {
    const running: ConversationState = { ...idle, status: 'running' };
    render(<StatusLine state={running} connected recovered />);
    expect(screen.getByRole('status').textContent).toContain('執行中');
  });
});

/** 時間到停下和人按停止分開講（#1631）：讀收尾帶的原因，折疊走真的 `reduceAll`。 */
describe('StatusLine 停下的原因（#1631）', () => {
  const stoppedWith = (cause?: unknown) => {
    const script = new Script();
    return reduceAll(emptyConversation(), [script.running(), script.stopped(cause)]);
  };

  it.each([
    ['時鐘到點', { kind: 'hook', reason: 'turn-timeout' }, TIMED_OUT_STATUS_TEXT],
    ['人按了停止', { kind: 'user' }, STOPPED_STATUS_TEXT],
    [
      '別的插件停的（認不得的 hook）',
      { kind: 'hook', reason: 'someone-else' },
      STOPPED_STATUS_TEXT,
    ],
    ['舊 server 沒帶原因', undefined, STOPPED_STATUS_TEXT],
  ] as const)('%s', (_name, cause, text) => {
    render(<StatusLine state={stoppedWith(cause)} connected />);
    const status = screen.getByRole('status');
    expect(status.textContent).toBe(text);
    // 不是失敗（#276）：不用紅字。
    expect(status.className).not.toContain('text-destructive');
  });

  it('下一輪開跑之後不再講時間到', () => {
    const script = new Script();
    const state = reduceAll(emptyConversation(), [
      script.running(),
      script.stopped({ kind: 'hook', reason: 'turn-timeout' }),
      script.running(),
      script.completed(),
    ]);
    render(<StatusLine state={state} connected />);
    expect(screen.getByRole('status').textContent).toBe('就緒');
  });
});

describe('StatusLine 執行中的經過時間（#1308）', () => {
  /** server 時鐘上的「現在」，整秒（標頭只到秒）。 */
  const SERVER_NOW = Date.UTC(2026, 9, 10, 3, 0, 0);

  /** 一輪還沒收尾、在 server 時鐘的 `start` 開始。 */
  function runningSince(start: number): ConversationState {
    const { end: _end, durationMs: _duration, ...open } = turn(1, { time: start });
    const state = withTrajectory(emptyConversation(), new Script(), view([turn(0), open]));
    return { ...state, status: 'running' };
  }

  /** 瀏覽器的時鐘差 `skew`（正的是快）；harness 回了一個帶 `Date` 的回應。 */
  function browserSkewed(skew: number) {
    const browserNow = SERVER_NOW + skew;
    vi.useFakeTimers({ now: browserNow });
    serverClock.observe(new Date(SERVER_NOW).toUTCString(), browserNow - 20, browserNow + 20);
  }

  it.each([
    ['瀏覽器慢 5 分鐘', -5 * 60_000],
    ['瀏覽器快 5 分鐘', 5 * 60_000],
    ['兩邊同一個時鐘', 0],
  ])('%s：從 server 記的開始時刻算起，顯示照樣對，每秒跳', (_, skew) => {
    browserSkewed(skew);
    render(<StatusLine state={runningSince(SERVER_NOW - 42_000)} connected />);
    expect(screen.getByTestId('running-elapsed').textContent).toBe('42 秒');
    act(() => vi.advanceTimersByTime(ELAPSED_TICK_MS));
    expect(screen.getByTestId('running-elapsed').textContent).toBe('43 秒');
    act(() => vi.advanceTimersByTime(ELAPSED_TICK_MS * 20));
    expect(screen.getByTestId('running-elapsed').textContent).toBe('1 分 03 秒');
  });

  it('經過時間不在 role="status" 的可讀範圍裡：在 live region 外面，而且 aria-hidden', () => {
    browserSkewed(0);
    render(<StatusLine state={runningSince(SERVER_NOW - 42_000)} connected />);
    const status = screen.getByRole('status');
    const elapsed = screen.getByTestId('running-elapsed');
    expect(status.textContent).toBe('執行中…');
    expect(status.contains(elapsed)).toBe(false);
    expect(elapsed.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(elapsed.className).toContain('tabular-nums');
  });

  it('還沒有時鐘樣本：不顯示，不拿瀏覽器的時鐘硬算', () => {
    vi.useFakeTimers({ now: SERVER_NOW });
    render(<StatusLine state={runningSince(SERVER_NOW - 42_000)} connected />);
    expect(screen.queryByTestId('running-elapsed')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('執行中…');
  });

  it('沒有軌跡投影、或最後一輪已經收尾：不顯示', () => {
    browserSkewed(0);
    const { rerender } = render(<StatusLine state={{ ...idle, status: 'running' }} connected />);
    expect(screen.queryByTestId('running-elapsed')).toBeNull();
    const ended = withTrajectory(emptyConversation(), new Script(), view([turn(0)]));
    rerender(<StatusLine state={{ ...ended, status: 'running' }} connected />);
    expect(screen.queryByTestId('running-elapsed')).toBeNull();
  });

  it('未滿 1 秒不畫（照 SG）：「0 秒」講的是還沒發生的事；滿 1 秒才出現', () => {
    browserSkewed(0);
    // 一筆樣本的估計取區間中點（`server-clock.ts`）：標頭秒級，server 的「現在」估成 SERVER_NOW + 500，所以這裡經過約 0.5 秒。
    render(<StatusLine state={runningSince(SERVER_NOW)} connected />);
    expect(screen.queryByTestId('running-elapsed')).toBeNull();
    act(() => vi.advanceTimersByTime(ELAPSED_TICK_MS));
    expect(screen.getByTestId('running-elapsed').textContent).toBe('1 秒');
  });

  it('不是執行中（就緒、停在核准點）：不帶經過時間', () => {
    browserSkewed(0);
    const state = runningSince(SERVER_NOW - 42_000);
    render(<StatusLine state={{ ...state, status: 'idle' }} connected />);
    expect(screen.queryByTestId('running-elapsed')).toBeNull();
  });
});

describe('StatusLine 執行中那一列換成 SG 的 TurnStatus（#1684）', () => {
  const root = { kind: 'root' } as const;
  const tool = (name: string): ToolEntry => ({
    kind: 'tool',
    id: `tool-${name}`,
    callId: `call_${name}`,
    name,
    input: '{}',
    status: 'running',
    attribution: root,
  });
  const writing: AiEntry = {
    kind: 'ai',
    id: 'ai-1',
    text: '找到了',
    streaming: true,
    attribution: root,
  };
  const runningWith = (entries: readonly ConversationEntry[]): ConversationState => ({
    ...idle,
    status: 'running',
    entries,
  });
  /** 每種 activity 一個本輪的樣子（判法見 `lib/turn-activity.ts`）。 */
  const STATES: readonly (readonly [Activity, ConversationState])[] = [
    ['searching', runningWith([tool('grep')])],
    ['running', runningWith([tool('execute')])],
    ['writing', runningWith([writing])],
  ];

  it('jsdom 沒有 matchMedia／IntersectionObserver：不拋錯、不畫 glyph，字照樣是「執行中…」', () => {
    const { container } = render(<StatusLine state={{ ...idle, status: 'running' }} connected />);
    expect(container.querySelector('[data-slot="status-glyph"]')).toBeNull();
    expect(container.querySelector('[data-slot="turn-status"]')).not.toBeNull();
    expect(screen.getByRole('status').textContent).toBe('執行中…');
  });

  it('量具自檢：三種 activity 的起始姿勢彼此不同，也跟預設的 thinking 不同', () => {
    const poses = [...STATES.map(([activity]) => activity), 'thinking' as const].map((a) =>
      JSON.stringify(openingPose(a)),
    );
    expect(new Set(poses).size).toBe(4);
  });

  it.each(STATES)('activity 有接上：%s 畫的是它自己的起始姿勢', (activity, state) => {
    stubGlyphEnvironment();
    const { container } = render(<StatusLine state={state} connected />);
    expect(drawnPose(container)).toEqual(openingPose(activity));
  });

  it('字固定是「執行中…」：activity 換了，live region 的字不變', () => {
    stubGlyphEnvironment();
    const { container, rerender } = render(<StatusLine state={STATES[0]![1]} connected />);
    const before = screen.getByRole('status').textContent;
    const poseBefore = drawnPose(container);
    rerender(<StatusLine state={STATES[2]![1]} connected />);
    expect(drawnPose(container)).not.toEqual(poseBefore);
    expect([before, screen.getByRole('status').textContent]).toEqual(['執行中…', '執行中…']);
  });

  it('只有一個 live region，包著 TurnStatus；glyph 在裡面但 aria-hidden', () => {
    stubGlyphEnvironment();
    const { container } = render(<StatusLine state={STATES[1]![1]} connected />);
    const regions = container.querySelectorAll('[role="status"]');
    expect(regions).toHaveLength(1);
    expect(regions[0]!.querySelector('[data-slot="turn-status"]')).not.toBeNull();
    expect(
      regions[0]!.querySelector('[data-slot="status-glyph"]')?.getAttribute('aria-hidden'),
    ).toBe('true');
  });

  it('沒有 SG 的英文（tokens、8s 這種時間）；沒有新增可聚焦的元素', () => {
    stubGlyphEnvironment();
    const { container } = render(<StatusLine state={STATES[1]![1]} connected />);
    expect(container.textContent).not.toMatch(/tokens|\d+s\b/);
    expect(container.querySelectorAll('button, a[href], input, [tabindex]')).toHaveLength(0);
  });
});
