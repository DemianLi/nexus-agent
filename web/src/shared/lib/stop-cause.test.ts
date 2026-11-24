// @vitest-environment node
import { TURN_TIMEOUT_REASON as WIRE_TURN_TIMEOUT_REASON } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { TURN_TIMEOUT_REASON, stoppedByTurnClock } from '@/shared/lib/stop-cause';

/**
 * 時鐘到點的那個字串是 harness 寫的（#1624）：web 不相依 harness，抄一份，這裡跟 wire 的值比；wire 的值跟 harness 一致
 * 由 harness 的 `wire-harness-facts.test.ts` 釘住。harness 改了字，那一格先紅，不會變成畫面靜靜退回「已停止」。
 */
describe('stop-cause（#1631）', () => {
  it('跟 harness 的 `TURN_TIMEOUT_REASON` 是同一個字', () => {
    expect(WIRE_TURN_TIMEOUT_REASON).toBe(TURN_TIMEOUT_REASON);
  });

  it.each([
    [{ kind: 'hook', reason: 'turn-timeout' }, true],
    [{ kind: 'hook', reason: 'someone-else' }, false],
    [{ kind: 'user' }, false],
    [{ kind: 'parent' }, false],
    [undefined, false],
  ] as const)('%o → %s', (cause, expected) => {
    expect(stoppedByTurnClock(cause)).toBe(expected);
  });
});
