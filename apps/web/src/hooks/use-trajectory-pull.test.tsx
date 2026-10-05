import type { ConversationState } from '@nexus/wire';
import { emptyConversation } from '@nexus/wire';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  STALE_REFRESH_MAX,
  STALE_REFRESH_MS,
  useTrajectoryPull,
} from '@/hooks/use-trajectory-pull';
import type { PullAnchor, PullSnapshot, PulledTurn, TrajectoryPuller } from '@/lib/trajectory-pull';
import { Script } from '@/test/conversation-frames';
import { call, digest, tool, turn, view, withTrajectory } from '@/test/trajectory-fixtures';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** 只記下被叫了什麼的 puller；快照由測試擺。 */
function spyPuller(snapshot: Partial<PullSnapshot> = {}) {
  const full: PullSnapshot = {
    turns: new Map(),
    pending: new Set(),
    failed: new Map(),
    unsupported: false,
    ...snapshot,
  };
  const puller = {
    getSnapshot: vi.fn(() => full),
    subscribe: vi.fn(() => () => {}),
    pull: vi.fn((_anchor: PullAnchor) => Promise.resolve({ ok: true as const })),
    seed: vi.fn(),
    reset: vi.fn(),
    dispose: vi.fn(),
  } satisfies TrajectoryPuller;
  return puller;
}

const stateWith = (trajectory: ReturnType<typeof view>): ConversationState =>
  withTrajectory(emptyConversation(), new Script(), trajectory);

const withDigests = () =>
  stateWith(view([turn(4)], { digests: [digest(1), digest(2), digest(3)] }));

describe('useTrajectoryPull', () => {
  it('看得見：把窗口的輪收進快取，預拉最近兩個邏輯輪（新的在前）', () => {
    const puller = spyPuller();
    const state = withDigests();
    renderHook(() => useTrajectoryPull(puller, state, true));
    expect(puller.seed).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ seq: 400 })]),
    );
    expect(puller.pull.mock.calls).toEqual([[{ seq: 300 }], [{ seq: 200 }]]);
  });

  it('看不見、或沒有 puller：什麼都不做', () => {
    const puller = spyPuller();
    renderHook(() => useTrajectoryPull(puller, withDigests(), false));
    renderHook(() => useTrajectoryPull(undefined, withDigests(), true));
    expect(puller.seed).not.toHaveBeenCalled();
    expect(puller.pull).not.toHaveBeenCalled();
    expect(puller.reset).not.toHaveBeenCalled();
  });

  it('軌跡投影用不了（沒有、閘門擋下）：清掉快取，不拉', () => {
    const puller = spyPuller();
    renderHook(() => useTrajectoryPull(puller, emptyConversation(), true));
    expect(puller.reset).toHaveBeenCalledTimes(1);
    expect(puller.pull).not.toHaveBeenCalled();
  });

  it('同一份 view（參照不變）重畫：不重複預拉', () => {
    const puller = spyPuller();
    const state = withDigests();
    const { rerender } = renderHook(() => useTrajectoryPull(puller, state, true));
    rerender();
    rerender();
    expect(puller.pull).toHaveBeenCalledTimes(2);
  });

  describe('還會變的輪：推送往前走之後去抖重拉', () => {
    const open = (n: number): PulledTurn => ({
      turn: turn(n, { calls: [call(n, { tools: [tool('t', { status: 'running' })] })] }),
      final: false,
      through: 5,
    });

    it(`安靜 ${STALE_REFRESH_MS} 毫秒之後才重拉；中間又往前走就重新計時`, () => {
      const puller = spyPuller({
        turns: new Map([[200, open(2)]]),
        // 預拉的兩顆已經在途中，不干擾計數。
        pending: new Set(['seq:300']),
      });
      const first = withDigests();
      const { rerender } = renderHook(({ state }) => useTrajectoryPull(puller, state, true), {
        initialProps: { state: first },
      });
      puller.pull.mockClear();
      act(() => {
        vi.advanceTimersByTime(STALE_REFRESH_MS - 1);
      });
      expect(puller.pull).not.toHaveBeenCalled();
      rerender({
        state: stateWith(
          view([turn(4, { calls: [call(41)] })], { digests: [digest(1), digest(2), digest(3)] }),
        ),
      });
      puller.pull.mockClear();
      act(() => {
        vi.advanceTimersByTime(STALE_REFRESH_MS - 1);
      });
      expect(puller.pull).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(2);
      });
      expect(puller.pull).toHaveBeenCalledWith({ seq: 200 });
    });

    it(`一次最多 ${STALE_REFRESH_MAX} 個；已定案的不重拉`, () => {
      const digests = Array.from({ length: 6 }, (_, i) => digest(i + 1));
      const turns = new Map<number, PulledTurn>(
        digests.map((d) => [d.seq, d.index === 1 ? { ...open(1), final: true } : open(d.index)]),
      );
      const puller = spyPuller({ turns });
      renderHook(() => useTrajectoryPull(puller, stateWith(view([turn(7)], { digests })), true));
      puller.pull.mockClear();
      act(() => {
        vi.advanceTimersByTime(STALE_REFRESH_MS + 1);
      });
      expect(puller.pull.mock.calls.map(([anchor]) => anchor)).toEqual([
        { seq: 200 },
        { seq: 300 },
        { seq: 400 },
      ]);
    });

    it('卸載或看不見：計時器取消', () => {
      const puller = spyPuller({ turns: new Map([[200, open(2)]]) });
      const { unmount } = renderHook(() => useTrajectoryPull(puller, withDigests(), true));
      puller.pull.mockClear();
      unmount();
      act(() => {
        vi.advanceTimersByTime(STALE_REFRESH_MS * 3);
      });
      expect(puller.pull).not.toHaveBeenCalled();
    });
  });
});
