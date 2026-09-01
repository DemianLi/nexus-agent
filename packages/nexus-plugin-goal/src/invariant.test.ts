/**
 * goal 串的配套入口：**壞掉這件事有人講**。
 *
 * 與 `index.test.ts` 那組「折疊壞掉」不重複——那邊驗的是服務**從此拒絕回答**，這裡驗的
 * 是同一件事**被報出來**。兩個機制、兩條路，缺一半都有洞。
 */

import { describe, expect, it } from 'vitest';

import { createInvariantRunner, createRegistry, goalId, SessionLog } from '@nexus/core';
import type { GoalSnapshotChangeMeta, InvariantError } from '@nexus/core';

import {
  createGoalInvariantPlugin,
  GOAL_INVARIANT_PACKAGE,
  goalStreamInvariant,
} from './invariant.js';

/** 接上配套入口，回收到的違規。 */
function watch(log: SessionLog): InvariantError[] {
  const violations: InvariantError[] = [];
  createInvariantRunner({
    log,
    companions: [
      {
        packageName: GOAL_INVARIANT_PACKAGE,
        installer: goalStreamInvariant,
        origin: { id: 'goal-invariant#0', name: 'goal-invariant' },
      },
    ],
    onViolation: (error) => violations.push(error),
    warn: (message) => {
      throw new Error(`不該有 warn：${message}`);
    },
  });
  return violations;
}

const CREATE: GoalSnapshotChangeMeta = {
  kind: 'goal/change',
  version: 1,
  operation: 'create',
  goal: {
    id: goalId('goal-1'),
    revision: 1,
    objective: '把它做完',
    phase: 'active',
    maxGoalRounds: 8,
  },
  roundsStarted: 0,
  createdAt: 10,
  updatedAt: 10,
};

const PAUSE: GoalSnapshotChangeMeta = {
  kind: 'goal/change',
  version: 1,
  operation: 'pause',
  goal: { ...CREATE.goal, revision: 2, phase: 'paused' },
  roundsStarted: 0,
  createdAt: 10,
  updatedAt: 11,
};

describe('註冊', () => {
  it('認領自己的 package 名，一個就好', () => {
    const registry = createRegistry();
    const plugin = createGoalInvariantPlugin();
    const exit = registry.enter({ id: `${plugin.name}#0`, name: plugin.name });
    plugin.apply(registry);
    exit();
    const companions = registry.invariants.companions();
    expect(companions).toHaveLength(1);
    expect(companions[0]?.packageName).toBe('@nexus/plugin-goal');
  });
});

describe('檢查', () => {
  it('合法的串一聲都不吭，別種事件也不管', () => {
    const log = new SessionLog('goal-invariant');
    const violations = watch(log);
    log.append('turn/start', { kind: 'resume' });
    log.append('goal/change', CREATE);
    log.append('turn/end', {});
    log.append('goal/change', PAUSE);
    expect(violations).toEqual([]);
  });

  it('接不上的那一筆被報出來，訊息帶得出是哪一顆事件、破了哪一條', () => {
    const log = new SessionLog('goal-invariant');
    const violations = watch(log);
    log.append('goal/change', CREATE);
    log.append('goal/change', { ...PAUSE, goal: { ...PAUSE.goal, revision: 9 } });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.packageName).toBe('@nexus/plugin-goal');
    expect(violations[0]?.message).toMatch(/會話事件 1 破壞了耐久 goal 串/u);
    expect(violations[0]?.message).toMatch(/推進剛好一個修訂號/u);
  });

  it('報過之後不採用那一筆，也不停下來——後面的照樣驗', () => {
    // 停下來的話，中段一次違規會讓後面全部失明；採用了的話，後面每一筆都會跟著錯位，
    // 一個壞掉的事件變成一串假違規。
    const log = new SessionLog('goal-invariant');
    const violations = watch(log);
    log.append('goal/change', CREATE);
    log.append('goal/change', { ...PAUSE, updatedAt: 1 });
    // 上面那筆沒被採用，所以這一筆（真正接得上 create 的那一筆）是合法的。
    log.append('goal/change', PAUSE);
    expect(violations).toHaveLength(1);
  });

  it('安裝當下就把日誌裡已經有的重播一遍——接得晚不等於檢得少', () => {
    const log = new SessionLog('goal-invariant');
    log.append('goal/change', CREATE);
    log.append('goal/change', { ...PAUSE, createdAt: 9 });
    const violations = watch(log);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/沒有保住目前的計數與時間戳/u);
  });
});
