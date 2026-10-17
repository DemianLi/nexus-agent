import type { WireGoal } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import {
  GOAL_PHASE_TEXT,
  goalBarView,
  goalPauseFailureText,
  PROMPT_REJECTED_TEXT,
} from '@/lib/goal-bar';

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

  it('`prompt-rejected`（封存擋下續行）換成中文，並講出下一步 `/goal resume`；別的碼照 server 的話', () => {
    const rejected = goalBarView(
      goal({
        phase: 'blocked',
        blockedReason: {
          code: 'prompt-rejected',
          message: 'Goal round was rejected before entering its step.',
        },
      }),
    );
    expect(rejected?.blockedReason).toBe(PROMPT_REJECTED_TEXT);
    expect(PROMPT_REJECTED_TEXT).toContain('/goal resume');
    expect(rejected?.label).toContain('取消封存後請輸入 /goal resume');
    expect(
      goalBarView(goal({ phase: 'blocked', blockedReason: { code: 'other', message: '別的理由' } }))
        ?.blockedReason,
    ).toBe('別的理由');
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

describe('暫停（#1517）', () => {
  it('只有 active 給暫停鈕，不看輪數與別的欄位；paused、blocked 不給', () => {
    expect(goalBarView(goal())?.pausable).toBe(true);
    expect(goalBarView(goal({ roundsStarted: 3 }))?.pausable).toBe(true);
    expect(goalBarView(goal({ phase: 'paused' }))?.pausable).toBe(false);
    expect(
      goalBarView(goal({ phase: 'blocked', blockedReason: { code: 'x', message: '卡住了' } }))
        ?.pausable,
    ).toBe(false);
  });

  const state = { id: 'g1', revision: 2, phase: 'paused' as const };

  it('收下了回 undefined：列等下行翻成 paused，不搶先改', () => {
    expect(goalPauseFailureText({ kind: 'ok', result: { ok: true, value: { goal: state } } })).toBe(
      undefined,
    );
  });

  it('業務失敗各自講一句：過期、已經不在進行（依現在的相位）、沒有目標', () => {
    expect(
      goalPauseFailureText({
        kind: 'ok',
        result: {
          ok: false,
          error: { code: 'goal-stale', current: { ...state, phase: 'active' } },
        },
      }),
    ).toBe('目標剛被改過，這次沒有暫停。請看過現在的目標再決定。');
    expect(
      goalPauseFailureText({
        kind: 'ok',
        result: { ok: false, error: { code: 'goal-not-active', phase: 'paused' } },
      }),
    ).toBe('目標已經暫停了。');
    expect(
      goalPauseFailureText({
        kind: 'ok',
        result: { ok: false, error: { code: 'goal-not-active', phase: 'complete' } },
      }),
    ).toBe('目標已經完成了。');
    expect(
      goalPauseFailureText({
        kind: 'ok',
        result: { ok: false, error: { code: 'goal-not-found' } },
      }),
    ).toBe('這條對話已經沒有目標了。');
  });

  it('這條線收不了：not_supported 講伺服器不支援，其餘照 server 的原話', () => {
    expect(
      goalPauseFailureText({ kind: 'rejected', code: 'not_supported', message: 'not supported' }),
    ).toBe('這台伺服器不支援暫停目標。');
    expect(goalPauseFailureText({ kind: 'rejected', message: '連線中斷' })).toBe('連線中斷');
  });
});
