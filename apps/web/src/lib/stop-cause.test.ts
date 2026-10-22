// @vitest-environment node
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { TURN_TIMEOUT_REASON, stoppedByTurnClock } from '@/lib/stop-cause';

/**
 * 時鐘到點的那個字串是 harness 寫的（#1624）：web 不相依 harness，抄一份，這裡讀 harness 的原始碼把兩份釘在一起。
 * harness 改了字，這一格先紅，不會變成畫面靜靜退回「已停止」。
 */
describe('stop-cause（#1631）', () => {
  it('跟 harness 的 `TURN_TIMEOUT_REASON` 是同一個字', () => {
    const source = readFileSync(
      new URL('../../../../apps/harness/src/settings/turn-timeout.ts', import.meta.url),
      'utf8',
    );
    const match = /export const TURN_TIMEOUT_REASON = '([^']*)';/.exec(source);
    expect(match?.[1]).toBe(TURN_TIMEOUT_REASON);
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
