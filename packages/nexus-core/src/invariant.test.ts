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
