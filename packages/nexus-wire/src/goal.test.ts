/**
 * 目標的 `custom` frame 怎麼折（[#897](https://github.com/DemianLi/nexus-agent/issues/897)）。
 *
 * 兩條路產出同一種 frame 的那一半在 `apps/harness/src/goal-wire.test.ts`；這裡只管折疊器：整份換掉、`null` 清掉、
 * 形狀不對整顆不收、往前翻頁不動它。
 */

import { describe, expect, it } from 'vitest';

import { emptyConversation, prependEntries, reduceAll } from './conversation.js';
import { GOAL } from './goal.js';
import type { WireGoal } from './goal.js';
import type { Event } from './protocol.js';

const goalFrame = (payload: unknown, name: string = GOAL): Event =>
  ({
    type: 'event',
    method: 'custom',
    params: { namespace: [], timestamp: 0, data: { name, payload } },
  }) as Event;

const fold = (...frames: Event[]) => reduceAll(emptyConversation(), frames).goal;

const ACTIVE: WireGoal = {
  id: 'goal-1',
  revision: 1,
  objective: '把 CI 修綠',
  phase: 'active',
  maxGoalRounds: 3,
  roundsStarted: 0,
  createdAt: 100,
  updatedAt: 100,
};
const BLOCKED: WireGoal = {
  ...ACTIVE,
  revision: 2,
  phase: 'blocked',
  blockedReason: { code: 'round-limit', message: '用完了。' },
};

describe('goal', () => {
  it('一顆都沒有是 null', () => {
    expect(fold()).toBeNull();
  });

  it('後到的整份取代先到的，null 清掉', () => {
    expect(fold(goalFrame({ goal: ACTIVE }))).toEqual(ACTIVE);
    expect(fold(goalFrame({ goal: ACTIVE }), goalFrame({ goal: BLOCKED }))).toEqual(BLOCKED);
    expect(fold(goalFrame({ goal: ACTIVE }), goalFrame({ goal: null }))).toBeNull();
  });

  it('blockedReason 剛好在 blocked 時有', () => {
    expect(
      fold(goalFrame({ goal: { ...ACTIVE, blockedReason: BLOCKED.blockedReason } })),
    ).toBeNull();
    const { blockedReason: _omit, ...bare } = BLOCKED;
    expect(fold(goalFrame({ goal: bare }))).toBeNull();
    expect(fold(goalFrame({ goal: { ...BLOCKED, blockedReason: { code: 'x' } } }))).toBeNull();
    expect(fold(goalFrame({ goal: { ...ACTIVE, phase: 'paused' } }))).toMatchObject({
      phase: 'paused',
    });
  });

  it('形狀不對整顆不收，留著前一份', () => {
    const bads: unknown[] = [
      {},
      { goal: 'x' },
      { goal: { ...ACTIVE, phase: 'running' } },
      { goal: { ...ACTIVE, revision: 0 } },
      { goal: { ...ACTIVE, maxGoalRounds: 1.5 } },
      { goal: { ...ACTIVE, roundsStarted: -1 } },
      { goal: { ...ACTIVE, createdAt: '1' } },
      { goal: { ...ACTIVE, id: '' } },
      { goal: { ...ACTIVE, objective: 1 } },
    ];
    for (const bad of bads) {
      expect(fold(goalFrame(bad))).toBeNull();
      expect(fold(goalFrame({ goal: ACTIVE }), goalFrame(bad))).toEqual(ACTIVE);
    }
  });

  it('多出來的欄位不收', () => {
    expect(fold(goalFrame({ goal: { ...ACTIVE, extra: 1 } }))).toEqual(ACTIVE);
  });

  it('別的名字不進來', () => {
    expect(fold(goalFrame({ goal: ACTIVE }, 'goal/change'))).toBeNull();
  });

  it('往前翻頁不動它', () => {
    const state = reduceAll(emptyConversation(), [goalFrame({ goal: ACTIVE })]);
    expect(prependEntries(state, emptyConversation()).goal).toEqual(ACTIVE);
  });
});
