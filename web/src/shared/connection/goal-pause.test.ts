import { describe, expect, it } from 'vitest';

import { goalPauseFailureText } from '@/shared/connection/goal-pause';

describe('goalPauseFailureText（#1517）', () => {
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
