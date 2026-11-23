/**
 * 續行授權的變化通知（[#1575](https://github.com/DemianLi/nexus-agent/issues/1575) N0376，dsh `setActivation`，`goal/src/index.ts:495-515`）。
 *
 * 只在授權值真的變了才通知；監聽登記在日誌上、**不經 `serviceFor`**（不觸發 lazy 重播，#1486）。
 */

import { describe, expect, it } from 'vitest';

import { SessionLog } from '@nexus/core';
import type { GoalActivationChange } from '@nexus/goal';

import { createGoalCore, goalConfigSchema } from './index.js';
import type { GoalCore } from './index.js';

function core(): GoalCore {
  let serial = 0;
  return createGoalCore(goalConfigSchema.parse({}), {
    now: () => 100,
    newGoalId: () => `goal-${(serial += 1)}`,
  });
}

function watch(goals: GoalCore, log: SessionLog): GoalActivationChange[] {
  const changes: GoalActivationChange[] = [];
  goals.onActivationChanged(log, (change) => void changes.push(change));
  return changes;
}

describe('授權變了才通知', () => {
  it('create → armed、pause → disarmed、resume → armed，都帶目前的 id 與修訂', () => {
    const goals = core();
    const log = new SessionLog('goal');
    const changes = watch(goals, log);
    const service = goals.serviceFor(log);
    const created = service.create({ objective: '把 CI 修綠' });
    const paused = service.pause({ id: created.id, revision: created.revision });
    const resumed = service.resume({ id: paused.id, revision: paused.revision });
    expect(changes).toEqual([
      { goal: { id: created.id, revision: created.revision, activation: 'armed' } },
      { goal: { id: paused.id, revision: paused.revision, activation: 'disarmed' } },
      { goal: { id: resumed.id, revision: resumed.revision, activation: 'armed' } },
    ]);
  });

  it('連續兩次 disarm 只通知一次；授權沒變的修訂（edit）不通知', () => {
    const goals = core();
    const log = new SessionLog('goal');
    const changes = watch(goals, log);
    const service = goals.serviceFor(log);
    const created = service.create({ objective: '把 CI 修綠' });
    service.edit({ id: created.id, revision: created.revision }, { maxGoalRounds: 9 });
    expect(changes).toHaveLength(1);
    service.disarm();
    service.disarm();
    expect(changes.map((change) => change.goal?.activation)).toEqual(['armed', 'disarmed']);
  });

  it('目標被清掉：授權跟著收回，通知不帶 goal（沒有目前目標）', () => {
    const goals = core();
    const log = new SessionLog('goal');
    const changes = watch(goals, log);
    const service = goals.serviceFor(log);
    const created = service.create({ objective: '把 CI 修綠' });
    service.clear({ id: created.id, revision: created.revision });
    expect(changes.at(-1)).toEqual({});
  });

  it('完成目標：授權收回，帶完成後的修訂', () => {
    const goals = core();
    const log = new SessionLog('goal');
    const changes = watch(goals, log);
    const service = goals.serviceFor(log);
    const created = service.create({ objective: '把 CI 修綠' });
    const done = service.complete({ id: created.id, revision: created.revision });
    expect(changes.at(-1)).toEqual({
      goal: { id: done.id, revision: done.revision, activation: 'disarmed' },
    });
  });
});

describe('訂閱不建服務', () => {
  it('訂了之後 existingFor 仍是 undefined；服務之後才建也照樣通知', () => {
    const goals = core();
    const log = new SessionLog('goal');
    const changes = watch(goals, log);
    expect(goals.existingFor(log)).toBeUndefined();
    goals.serviceFor(log).create({ objective: '把 CI 修綠' });
    expect(changes).toHaveLength(1);
  });

  it('取消訂閱之後不再通知', () => {
    const goals = core();
    const log = new SessionLog('goal');
    const changes: GoalActivationChange[] = [];
    const stop = goals.onActivationChanged(log, (change) => void changes.push(change));
    const service = goals.serviceFor(log);
    const created = service.create({ objective: '把 CI 修綠' });
    stop();
    service.pause({ id: created.id, revision: created.revision });
    expect(changes).toHaveLength(1);
  });

  it('兩次掛載（列重載）各掛各的：訂在舊核心上的聽不到新核心上同一份日誌的變化', () => {
    const first = core();
    const second = core();
    const log = new SessionLog('goal');
    const onFirst = watch(first, log);
    const onSecond = watch(second, log);
    first.serviceFor(log).create({ objective: '舊的' });
    expect(onFirst).toHaveLength(1);
    expect(onSecond).toHaveLength(0);
  });

  it('監聽拋錯不影響日誌的 append，也不餓死後面的監聽', () => {
    const goals = core();
    const log = new SessionLog('goal');
    goals.onActivationChanged(log, () => {
      throw new Error('壞掉的監聽');
    });
    const later = watch(goals, log);
    const service = goals.serviceFor(log);
    expect(() => service.create({ objective: '把 CI 修綠' })).not.toThrow();
    expect(service.get()?.activation).toBe('armed');
    expect(later).toHaveLength(1);
  });
});
