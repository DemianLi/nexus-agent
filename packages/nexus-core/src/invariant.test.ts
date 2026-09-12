/**
 * `@nexus/core` 的會話配套入口：turn 配對。
 *
 * 對應 [#101](https://github.com/DemianLi/nexus-agent/issues/101) 的驗收：合法序列不吵、
 * `turn/start` 疊在開著的輪上被抓到、`interrupt/raised` 落在輪外被抓到。
 *
 * **合法序列那幾條是照兩個生產者實際發的順序寫的**（`thread-pump.ts` 的 `#runOnce`、
 * `cli.ts` 的 `runTurn`），不是照型別想出來的——會在真流量上誤報的檢查比沒有檢查更糟。
 */

import { describe, expect, it } from 'vitest';

import { createInvariantRunner } from './invariants.js';
import type { InvariantCompanion, InvariantError } from './invariants.js';
import { createRegistry } from './registry.js';
import { goalId } from './goal.js';
import { SessionLog } from './session-log.js';
import { createCoreInvariantPlugin, CORE_INVARIANT_PACKAGE } from './invariant.js';
import { sessionInvariant } from './invariant.js';

/** 接上配套入口，回傳收到的違規。 */
function watch(log: SessionLog): InvariantError[] {
  const violations: InvariantError[] = [];
  const companion: InvariantCompanion = {
    packageName: CORE_INVARIANT_PACKAGE,
    installer: sessionInvariant,
    origin: { id: 'core-invariant#0', name: 'core-invariant' },
  };
  createInvariantRunner({
    log,
    companions: [companion],
    onViolation: (error) => violations.push(error),
    warn: (message) => {
      throw new Error(`不該有 warn：${message}`);
    },
  });
  return violations;
}

describe('合法序列不吵', () => {
  it('goal/change 不參與 turn 配對——輪內輪外都不吵', () => {
    // 這一條釘的是 `sessionInvariant` 的 `default` 分支：**後來加的事件種類歸它們自己的
    // 擁有者**。goal 的耐久串由 `@nexus/plugin-goal` 的配套入口檢，這裡多管一句就會在
    // 真流量上誤報。
    const log = new SessionLog('goal-不干擾');
    const violations = watch(log);
    const change = {
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
      createdAt: 1,
      updatedAt: 1,
    } as const;
    log.append('goal/change', change);
    log.append('turn/start', { kind: 'message', text: '走吧' });
    log.append('goal/change', {
      ...change,
      operation: 'pause',
      goal: { ...change.goal, revision: 2, phase: 'paused' },
      updatedAt: 2,
    });
    log.append('turn/end', {});
    expect(violations).toEqual([]);
  });

  it('CLI 那條：turn/start → turn/end', () => {
    const log = new SessionLog('cli');
    const violations = watch(log);

    log.append('turn/start', { kind: 'message', text: '嗨' });
    log.append('turn/end', {});

    expect(violations).toEqual([]);
  });

  it('核准那條：turn/start → interrupt/raised → turn/end → resume 的新一輪', () => {
    const log = new SessionLog('web');
    const violations = watch(log);

    log.append('turn/start', { kind: 'message', text: '刪檔' });
    log.append('interrupt/raised', { interruptId: 'i-1' });
    log.append('turn/end', {});
    log.append('turn/start', { kind: 'resume' });
    log.append('turn/end', {});

    expect(violations).toEqual([]);
  });

  it('失敗那條：turn/failed 收工，下一輪照樣開得起來', () => {
    const log = new SessionLog('cli');
    const violations = watch(log);

    log.append('turn/start', { kind: 'message', text: '嗨' });
    log.append('turn/failed', { message: '模型建不起來' });
    log.append('turn/start', { kind: 'message', text: '再試' });
    log.append('turn/end', {});

    expect(violations).toEqual([]);
  });

  it('一輪裡多顆中斷不算違規（pump 的 #translate 一次可以發好幾顆）', () => {
    const log = new SessionLog('web');
    const violations = watch(log);

    log.append('turn/start', { kind: 'message', text: '批次' });
    log.append('interrupt/raised', { interruptId: 'i-1' });
    log.append('interrupt/raised', { interruptId: 'i-2' });
    log.append('turn/end', {});

    expect(violations).toEqual([]);
  });

  it('日誌結尾還有一輪開著不算違規——那跟「跑到一半」分不出來', () => {
    const log = new SessionLog('cli');
    const violations = watch(log);

    log.append('turn/start', { kind: 'message', text: '跑很久' });

    expect(violations).toEqual([]);
  });
});

describe('三條關係', () => {
  it('turn/start 疊在開著的輪上', () => {
    const log = new SessionLog('cli');
    const violations = watch(log);

    log.append('turn/start', { kind: 'message', text: '第一輪' });
    log.append('turn/start', { kind: 'message', text: '第二輪' });

    expect(violations).toHaveLength(1);
    expect(violations[0]!.packageName).toBe('@nexus/core');
    expect(violations[0]!.message).toContain('上一輪還開著');
    expect(violations[0]!.message).toContain('seq 1');
  });

  it('turn/end 關了一個沒開的輪', () => {
    const log = new SessionLog('cli');
    const violations = watch(log);

    log.append('turn/end', {});

    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toContain('關了一個沒有開著的輪');
  });

  it('turn/failed 關了一個沒開的輪', () => {
    const log = new SessionLog('cli');
    const violations = watch(log);

    log.append('turn/start', { kind: 'resume' });
    log.append('turn/end', {});
    log.append('turn/failed', { message: '收尾時炸了' });

    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toContain('turn/failed');
  });

  it('interrupt/raised 落在任何開著的輪之外', () => {
    const log = new SessionLog('web');
    const violations = watch(log);

    log.append('interrupt/raised', { interruptId: 'i-1' });

    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toContain('落在任何開著的輪之外');
  });

  it('一次違規之後狀態照樣往前走，不會卡住不再報', () => {
    const log = new SessionLog('cli');
    const violations = watch(log);

    log.append('turn/start', { kind: 'resume' });
    log.append('turn/start', { kind: 'resume' });
    log.append('turn/end', {});
    log.append('turn/end', {});

    expect(violations).toHaveLength(2);
    expect(violations[1]!.message).toContain('關了一個沒有開著的輪');
  });
});

/**
 * 工具事件的 `callId` 配對（[#264](https://github.com/DemianLi/nexus-agent/issues/264)）。合法序列
 * 照圍堵實際發的順序寫：呼叫在前、結果在後；被中斷的那次 resume 之後以同一個 `callId` 再記一顆。
 */
describe('tool/call ↔ tool/result 配對', () => {
  const callOf = (callId: string) => ({ callId, name: 'probe', arguments: '{}' });

  it('一對一對、併發交錯都不吵', () => {
    const log = new SessionLog('tools');
    const violations = watch(log);
    log.append('tool/call', callOf('a'));
    log.append('tool/call', callOf('b'));
    log.append('tool/result', { callId: 'b', isError: false });
    log.append('tool/result', { callId: 'a', isError: true });
    expect(violations).toEqual([]);
  });

  it('被中斷的那次：同一個 callId 兩顆呼叫、一顆結果，不吵', () => {
    const log = new SessionLog('web');
    const violations = watch(log);
    log.append('turn/start', { kind: 'message', text: '刪檔' });
    log.append('tool/call', callOf('a'));
    log.append('interrupt/raised', { interruptId: 'i-1' });
    log.append('turn/end', {});
    log.append('turn/start', { kind: 'resume' });
    log.append('tool/call', callOf('a'));
    log.append('tool/result', { callId: 'a', isError: false });
    log.append('turn/end', {});
    expect(violations).toEqual([]);
  });

  it('結果前面沒有呼叫 → 報', () => {
    const log = new SessionLog('tools');
    const violations = watch(log);
    log.append('tool/result', { callId: 'ghost', isError: false });
    expect(violations.map((error) => error.message)).toEqual([
      expect.stringContaining('callId "ghost" 前面沒有還沒配到的 tool/call'),
    ]);
  });

  it('同一顆呼叫配第二次 → 報', () => {
    const log = new SessionLog('tools');
    const violations = watch(log);
    log.append('tool/call', callOf('a'));
    log.append('tool/result', { callId: 'a', isError: false });
    log.append('tool/result', { callId: 'a', isError: false });
    expect(violations).toHaveLength(1);
  });

  it('上一個行程中斷的那次：續接之後重記一顆再落定，不吵', () => {
    const earlier = new SessionLog('web');
    earlier.append('tool/call', callOf('a'));
    const resumed = new SessionLog('web', { seed: earlier.events });
    const violations = watch(resumed);
    resumed.append('tool/call', callOf('a'));
    resumed.append('tool/result', { callId: 'a', isError: false });
    expect(violations).toEqual([]);
  });

  it('**end-seed 之前的呼叫不替之後的結果背書**', () => {
    const earlier = new SessionLog('web');
    earlier.append('tool/call', callOf('a'));
    const resumed = new SessionLog('web', { seed: earlier.events });
    const violations = watch(resumed);
    resumed.append('tool/result', { callId: 'a', isError: false });
    expect(violations).toHaveLength(1);
  });
});

describe('plugin', () => {
  it('掛上去就認領 @nexus/core 這個名字', () => {
    const registry = createRegistry();
    const exit = registry.enter({ id: 'core-invariant#0', name: 'core-invariant' });
    createCoreInvariantPlugin().apply(registry);
    exit();

    const companions = registry.invariants.companions();
    expect(companions).toHaveLength(1);
    expect(companions[0]!.packageName).toBe('@nexus/core');
  });
});

/**
 * 續接：**seed 結尾那一輪開著，是上一個行程跑到一半，不是這個行程的違規**
 * （[#251](https://github.com/DemianLi/nexus-agent/issues/251) 的門 A）。
 */
describe('在 `session/end-seed` 重設', () => {
  it('上一個行程當在輪中，續接之後的第一顆 `turn/start` 不吵', () => {
    const earlier = new SessionLog('cli');
    earlier.append('turn/start', { kind: 'message', text: '跑到一半' });
    const resumed = new SessionLog('cli', { seed: earlier.events });
    const violations = watch(resumed);
    resumed.append('turn/start', { kind: 'message', text: '接著來' });
    resumed.append('turn/end', {});
    expect(violations).toEqual([]);
  });

  /** 反例：拿掉 end-seed 那一格重設的話就是這個樣子——同一串事件不經 seed。 */
  it('反例：同一串事件不經 seed，第二顆 `turn/start` 照樣報', () => {
    const log = new SessionLog('cli');
    const violations = watch(log);
    log.append('turn/start', { kind: 'message', text: '跑到一半' });
    log.append('turn/start', { kind: 'message', text: '接著來' });
    expect(violations.map((error) => error.message)).toEqual([
      expect.stringContaining('turn/start（seq 1）來的時候上一輪還開著'),
    ]);
  });

  it('重設不放過這個行程自己的違規：end-seed 之後的輪照樣要配對', () => {
    const resumed = new SessionLog('cli', { seed: [] });
    const violations = watch(resumed);
    resumed.append('turn/start', { kind: 'message', text: '一' });
    resumed.append('turn/start', { kind: 'message', text: '二' });
    expect(violations).toHaveLength(1);
  });
});
