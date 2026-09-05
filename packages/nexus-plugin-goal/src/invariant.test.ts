/**
 * goal 串的配套入口：**壞掉這件事有人講**。
 *
 * 與 `index.test.ts` 那組「折疊壞掉」不重複——那邊驗的是服務**從此拒絕回答**，這裡驗的
 * 是同一件事**被報出來**。兩個機制、兩條路，缺一半都有洞。
 */

import { describe, expect, it } from 'vitest';

import { createInvariantRunner, createRegistry, goalId, SessionLog } from '@nexus/core';
import type { GoalSnapshotChangeMeta, InvariantError, SessionEventMap } from '@nexus/core';

import {
  createGoalInvariantPlugin,
  GOAL_INVARIANT_PACKAGE,
  goalStreamInvariant,
} from './invariant.js';
import { renderGoalRoundPrompt } from './prompt.js';

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

/**
 * **這一組驗的是排程器排出來的東西，但它不需要排程器。**
 *
 * 判準寫在 `invariant.ts` 檔頭：只要 `kind: 'goal'` 這個詞彙存在，這條檢查就武裝。
 * 底下每一條都是**手寫**一顆 `turn/start` 進日誌——沒有任何排程器在場，而檢查照樣擋。
 */
describe('續行輪次的內容', () => {
  /** 這一顆若由排程器排出來會長的樣子。 */
  function round(round: number, overrides: Record<string, unknown> = {}) {
    return {
      kind: 'goal',
      text: renderGoalRoundPrompt(CREATE.goal, round),
      goalId: CREATE.goal.id,
      revision: 1,
      round,
      ...overrides,
    } as SessionEventMap['turn/start'];
  }

  it('文字對得上的一聲都不吭，而且推得動下一輪的準入', () => {
    const log = new SessionLog('goal-round');
    const violations = watch(log);
    log.append('goal/change', CREATE);
    log.append('turn/start', round(1));
    log.append('turn/end', {});
    // **第二輪是這一條的重點**：累積器沒跟著推進的話，`round === roundsStarted + 1`
    // 會在這裡報一個假違規。
    log.append('turn/start', round(2));
    expect(violations).toEqual([]);
  });

  it('文字差一個字就報出來——**逐字，不是「像」**', () => {
    const log = new SessionLog('goal-round');
    const violations = watch(log);
    log.append('goal/change', CREATE);
    log.append('turn/start', round(1, { text: `${renderGoalRoundPrompt(CREATE.goal, 1)} ` }));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/第 1 輪內容不是這個套件算出來的續行文字/u);
  });

  /**
   * 一顆帶著**別人的目標敘述**的輪次。這是這條檢查真正在擋的東西：日誌上四格身分全對，
   * 只有送進模型的那段話被換掉了。
   */
  it('身分全對但內容是另一個目標的，照樣報', () => {
    const log = new SessionLog('goal-round');
    const violations = watch(log);
    log.append('goal/change', CREATE);
    log.append(
      'turn/start',
      round(1, {
        text: renderGoalRoundPrompt({ ...CREATE.goal, objective: '做別的事' }, 1),
      }),
    );
    expect(violations).toHaveLength(1);
  });

  it('身分對不上的在折疊那一關就被擋——訊息說得出是哪一條', () => {
    const log = new SessionLog('goal-round');
    const violations = watch(log);
    log.append('goal/change', CREATE);
    log.append('turn/start', round(2));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/不是目前 active 目標的下一個準入輪次/u);
  });

  it('人打的與核准恢復不歸這條管', () => {
    const log = new SessionLog('goal-round');
    const violations = watch(log);
    log.append('goal/change', CREATE);
    log.append('turn/start', { kind: 'message', text: '動手' });
    log.append('turn/start', { kind: 'resume' });
    expect(violations).toEqual([]);
  });
});
