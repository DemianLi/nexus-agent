import { TRAJECTORY_PROJECTION, emptyConversation } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { elapsedText, runningTurnStart } from '@/lib/running-turn';
import { Script } from '@/test/conversation-frames';
import { digest, turn, view, withTrajectory } from '@/test/trajectory-fixtures';
import type { TrajectoryTurn, TrajectoryView } from '@nexus/wire';

const T0 = 1_700_000_000_000;
const stateWith = (trajectory: TrajectoryView) =>
  withTrajectory(emptyConversation(), new Script(), trajectory);
/** 還沒收尾的一輪：沒有 `end`、`durationMs`。 */
function running(index: number, overrides: Partial<TrajectoryTurn> = {}): TrajectoryTurn {
  const { end: _end, durationMs: _duration, ...rest } = turn(index, overrides);
  return rest;
}

describe('runningTurnStart：這一輪從 server 時鐘的哪一刻開始（#1308）', () => {
  it('沒有軌跡投影：答不出', () => {
    expect(runningTurnStart(emptyConversation())).toBeUndefined();
  });

  it('投影拋過（failed）：答不出', () => {
    const script = new Script();
    const state = withTrajectory(emptyConversation(), script, view([]));
    const failed = {
      ...state,
      projections: {
        ...state.projections,
        [TRAJECTORY_PROJECTION]: { ...state.projections[TRAJECTORY_PROJECTION]!, failed: true },
      },
    } as typeof state;
    expect(runningTurnStart(failed)).toBeUndefined();
  });

  it('最後一輪已經收尾（新一輪的投影還沒到）：答不出，不拿上一輪的', () => {
    expect(runningTurnStart(stateWith(view([turn(0), turn(1)])))).toBeUndefined();
  });

  it('最後一輪還沒收尾：它的 turn/start 時刻', () => {
    const state = stateWith(view([turn(0), running(1, { time: T0 + 5000 })]));
    expect(runningTurnStart(state)).toBe(T0 + 5000);
  });

  it('核准後的續接：從它接著的那一個邏輯輪起算（含等人的時間，同牆鐘）', () => {
    const state = stateWith(
      view([
        turn(0),
        turn(1, { time: T0 + 10_000, end: 'completed' }),
        running(2, { kind: 'resume', logical: false, time: T0 + 70_000 }),
      ]),
    );
    expect(runningTurnStart(state)).toBe(T0 + 10_000);
  });

  it('邏輯輪已經滑進摘要、續接還在窗口：照樣接得上', () => {
    const state = stateWith(
      view([running(5, { kind: 'resume', logical: false, time: T0 + 70_000 })], {
        digests: [digest(4, { time: T0 + 10_000 })],
      }),
    );
    expect(runningTurnStart(state)).toBe(T0 + 10_000);
  });

  it('看得到的只剩續接（它接著的那一輪已經滑出去）：答不出，不拿續接自己的時刻', () => {
    const state = stateWith(
      view([running(9, { kind: 'resume', logical: false, time: T0 + 70_000 })], {
        omitted: 9,
      }),
    );
    expect(runningTurnStart(state)).toBeUndefined();
  });
});

describe('elapsedText', () => {
  it.each([
    [-1500, '0 秒'],
    [0, '0 秒'],
    [999, '0 秒'],
    [12_400, '12 秒'],
    [59_999, '59 秒'],
    [60_000, '1 分 00 秒'],
    [185_000, '3 分 05 秒'],
    [3_599_000, '59 分 59 秒'],
    [3_720_000, '1 小時 02 分'],
  ])('%d ms → %s', (ms, text) => {
    expect(elapsedText(ms)).toBe(text);
  });
});
