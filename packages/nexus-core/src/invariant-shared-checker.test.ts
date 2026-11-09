/**
 * 執行期的配套入口用的是讀盤那一支（[#1597](https://github.com/DemianLi/nexus-agent/issues/1597) 驗收 E 的 core 那一側）：
 * `sessionInvariant` 要經 `createSessionRelationshipChecker` 判，自己另寫一份狀態機就紅。讀盤那一側在
 * `apps/harness/src/session-log-validation-shared-checker.test.ts`。
 */

import { describe, expect, it, vi } from 'vitest';

import { createInvariantRunner } from './invariants.js';
import { CORE_INVARIANT_PACKAGE, sessionInvariant } from './invariant.js';
import { SessionLog } from './session-log.js';
import { createSessionRelationshipChecker } from './session-relationships.js';

vi.mock('./session-relationships.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./session-relationships.js')>();
  const accepted: unknown[] = [];
  return {
    ...real,
    accepted,
    createSessionRelationshipChecker: vi.fn(() => {
      const checker = real.createSessionRelationshipChecker();
      return {
        accept: (event: Parameters<typeof checker.accept>[0]) => {
          accepted.push(event.seq);
          return checker.accept(event);
        },
      };
    }),
  };
});

describe('執行期與讀盤共用同一支關係檢查（#1597 E）', () => {
  it('sessionInvariant 每顆事件都交給 createSessionRelationshipChecker，違規照它回的訊息報', async () => {
    const { accepted } = (await import('./session-relationships.js')) as unknown as {
      accepted: number[];
    };
    const log = new SessionLog('shared');
    const messages: string[] = [];
    createInvariantRunner({
      log,
      companions: [
        {
          packageName: CORE_INVARIANT_PACKAGE,
          installer: sessionInvariant,
          origin: { id: 'core-invariant#0', name: 'core-invariant' },
        },
      ],
      onViolation: (error) => messages.push(error.message),
      warn: () => {},
    });
    log.append('turn/end', {});
    log.append('turn/start', { kind: 'message', text: '嗨' });
    expect(vi.mocked(createSessionRelationshipChecker)).toHaveBeenCalledTimes(1);
    expect(accepted).toEqual([0, 1]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('turn/end（seq 0）關了一個沒有開著的輪');
  });
});
