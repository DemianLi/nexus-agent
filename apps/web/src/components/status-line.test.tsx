import { emptyConversation } from '@nexus/wire';
import type { ConversationState } from '@nexus/wire';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ELAPSED_TICK_MS, StatusLine } from '@/components/status-line';
import { serverClock } from '@/lib/server-clock';
import { Script } from '@/test/conversation-frames';
import { turn, view, withTrajectory } from '@/test/trajectory-fixtures';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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

  it('不是執行中（就緒、停在核准點）：不帶經過時間', () => {
    browserSkewed(0);
    const state = runningSince(SERVER_NOW - 42_000);
    render(<StatusLine state={{ ...state, status: 'idle' }} connected />);
    expect(screen.queryByTestId('running-elapsed')).toBeNull();
  });
});
