import type { WireGoal } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { GOAL_PHASE_TEXT, goalBarView } from '@/lib/goal-bar';

const goal = (patch: Partial<WireGoal> = {}): WireGoal => ({
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

describe('goalBarView（#945）', () => {
  it('`null` 與 `complete` 不畫；其餘三個相位都畫', () => {
    expect(goalBarView(null)).toBeUndefined();
    expect(goalBarView(goal({ phase: 'complete' }))).toBeUndefined();
    for (const phase of ['active', 'paused', 'blocked'] as const) {
      expect(goalBarView(goal({ phase }))?.phase).toBe(GOAL_PHASE_TEXT[phase]);
    }
  });

  it('階段字不說謊：`active` 是持久相位，不寫「進行中」「正在跑」', () => {
    for (const text of Object.values(GOAL_PHASE_TEXT)) {
      expect(text).not.toMatch(/進行中|正在跑|執行中/);
    }
    expect(goalBarView(goal())?.phase).toBe('目標：未完成');
  });

  it('輪數：開始過才寫「第 N／M 輪」，`roundsStarted === 0` 不寫', () => {
    expect(goalBarView(goal({ roundsStarted: 0 }))?.rounds).toBeUndefined();
    expect(goalBarView(goal({ roundsStarted: 3, maxGoalRounds: 10 }))?.rounds).toBe('第 3／10 輪');
  });

  it('`blocked` 才帶理由；別的相位就算帶著也不畫', () => {
    const reason = { code: 'no-progress', message: '連續兩輪沒有進展' };
    expect(goalBarView(goal({ phase: 'blocked', blockedReason: reason }))?.blockedReason).toBe(
      '連續兩輪沒有進展',
    );
    expect(goalBarView(goal({ phase: 'blocked' }))?.blockedReason).toBeUndefined();
    expect(goalBarView(goal({ phase: 'paused', blockedReason: reason }))?.blockedReason).toBe(
      undefined,
    );
  });

  it('無障礙名稱帶階段、目標全文、輪數與理由', () => {
    const view = goalBarView(
      goal({
        phase: 'blocked',
        objective: '很長的目標內容',
        roundsStarted: 2,
        blockedReason: { code: 'x', message: '卡住了' },
      }),
    );
    expect(view?.label).toBe('目標：受阻，很長的目標內容，第 2／256 輪，卡住了');
  });
});
