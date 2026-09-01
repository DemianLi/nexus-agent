/**
 * goal 域走**真的通道**：註冊表 → `sessions` 接線 → 服務 → 會話日誌。
 *
 * 刻意不直接 `new GoalService(...)`：這個套件宣稱自己是一個 plugin，而「掛上去之後真的
 * 拿得到一份綁對日誌的服務」正是那個宣稱裡最容易靜靜壞掉的一段。
 */

import { describe, expect, it } from 'vitest';

import { createRegistry, createSessionRunner, goalId, SessionLog } from '@nexus/core';
import type { GoalChangeMeta, GoalRef } from '@nexus/core';

import { createGoalPlugin, GoalError } from './index.js';
import type { GoalPlugin, GoalPluginOptions, GoalService } from './index.js';

/** 掛一次、接一份日誌，回手上要用的每一個東西。 */
function attach(options: GoalPluginOptions = {}): {
  plugin: GoalPlugin;
  log: SessionLog;
  service: GoalService;
  detach: () => void;
  tick: (to: number) => void;
} {
  let clock = 100;
  let serial = 0;
  const plugin = createGoalPlugin({
    now: () => clock,
    newGoalId: () => `goal-${(serial += 1)}`,
    ...options,
  });
  const registry = createRegistry();
  const exit = registry.enter({ id: 'goal#0', name: 'goal' });
  plugin.apply(registry);
  exit();
  const log = new SessionLog('goal');
  const detach = createSessionRunner({
    address: { kind: 'root' },
    log,
    installers: registry.sessions.installers(),
    warn: (message) => {
      throw new Error(`不該有 warn：${message}`);
    },
  });
  const service = plugin.serviceFor(log);
  if (service === undefined) throw new Error('接線之後應該找得到服務');
  return {
    plugin,
    log,
    service,
    detach,
    tick: (to) => {
      clock = to;
    },
  };
}

/** 目前這一份的 CAS 身分。 */
function refOf(service: GoalService): GoalRef {
  const view = service.get();
  if (view === undefined) throw new Error('現在沒有目前的目標');
  return { id: view.id, revision: view.revision };
}

describe('掛載', () => {
  it('只碰 sessions 與 commands 兩個通道，別的一格都不動', () => {
    // **`commands` 這一格翻面了。** 上一張 PR 這裡是 `toEqual([])`，守的是「域不裝任何
    // 人打得到的東西」。`/goal` 落地之後那條線換了主詞：要守的變成「它只多掛一個命令」
    // ——工具、middleware 與配套入口仍然一格都不碰，因為命令不進模型，掛了 `/goal` 的
    // agent 與沒掛的在模型眼裡一模一樣。這一條是那句話的守衛。
    const registry = createRegistry();
    const exit = registry.enter({ id: 'goal#0', name: 'goal' });
    createGoalPlugin().apply(registry);
    exit();
    expect(registry.sessions.installers()).toHaveLength(1);
    expect(registry.commands.list().map((entry) => entry.name)).toEqual(['goal']);
    expect(registry.tools.effective(undefined).size).toBe(0);
    expect(registry.middleware.list()).toEqual([]);
    expect(registry.invariants.companions()).toEqual([]);
  });

  it('接線之前找不到服務，收線之後也找不到', () => {
    const plugin = createGoalPlugin();
    const registry = createRegistry();
    const exit = registry.enter({ id: 'goal#0', name: 'goal' });
    plugin.apply(registry);
    exit();
    const log = new SessionLog('goal');
    expect(plugin.serviceFor(log)).toBeUndefined();
    expect(plugin.attached()).toEqual([]);

    const detach = createSessionRunner({
      address: { kind: 'root' },
      log,
      installers: registry.sessions.installers(),
    });
    expect(plugin.serviceFor(log)).toBeDefined();
    expect(plugin.attached()).toHaveLength(1);

    detach();
    expect(plugin.serviceFor(log)).toBeUndefined();
    expect(plugin.attached()).toEqual([]);
  });

  it('一份日誌一個服務——兩份日誌的目標互不相干', () => {
    const plugin = createGoalPlugin();
    const registry = createRegistry();
    const exit = registry.enter({ id: 'goal#0', name: 'goal' });
    plugin.apply(registry);
    exit();
    const first = new SessionLog('a');
    const second = new SessionLog('b');
    createSessionRunner({
      address: { kind: 'root' },
      log: first,
      installers: registry.sessions.installers(),
    });
    createSessionRunner({
      address: { kind: 'root' },
      log: second,
      installers: registry.sessions.installers(),
    });

    plugin.serviceFor(first)?.create({ objective: '第一份的目標' });
    expect(plugin.serviceFor(first)?.get()?.objective).toBe('第一份的目標');
    expect(plugin.serviceFor(second)?.get()).toBeUndefined();
    expect(plugin.attached()).toHaveLength(2);
  });
});

describe('create', () => {
  it('寫一顆 goal/change 進日誌，並回一份已授權的視圖', () => {
    const { service, log } = attach();
    const view = service.create({ objective: '把 goal 域做完' });
    expect(view).toEqual({
      id: 'goal-1',
      revision: 1,
      objective: '把 goal 域做完',
      phase: 'active',
      maxGoalRounds: 256,
      roundsStarted: 0,
      createdAt: 100,
      updatedAt: 100,
      activation: 'armed',
    });
    expect(log.events.map((event) => event.type)).toEqual(['goal/change']);
    expect((log.events[0]?.data as GoalChangeMeta).operation).toBe('create');
  });

  it('沒指定上限就用預設的 256，指定了就用指定的', () => {
    expect(attach().service.create({ objective: 'a' }).maxGoalRounds).toBe(256);
    expect(attach().service.create({ objective: 'a', maxGoalRounds: 4 }).maxGoalRounds).toBe(4);
    expect(
      attach({ defaultMaxGoalRounds: 12 }).service.create({ objective: 'a' }).maxGoalRounds,
    ).toBe(12);
  });

  it('敘述空的、上限不合法——各自的錯誤碼', () => {
    const { service } = attach();
    expect(() => service.create({ objective: '   ' })).toThrow(
      expect.objectContaining({ code: 'GOAL_INVALID_OBJECTIVE' }),
    );
    expect(() => service.create({ objective: 'a', maxGoalRounds: 0 })).toThrow(
      expect.objectContaining({ code: 'GOAL_INVALID_MAX_ROUNDS' }),
    );
    // 一筆都沒進日誌——被拒的變更不留痕跡。
    expect(attach().log.length).toBe(0);
  });

  it('敘述前後空白會被正規化掉', () => {
    expect(attach().service.create({ objective: '  收邊  ' }).objective).toBe('收邊');
  });

  it('上一個還沒完成就不准建下一個，完成掉的可以被取代', () => {
    const { service } = attach();
    service.create({ objective: '第一個' });
    expect(() => service.create({ objective: '第二個' })).toThrow(
      expect.objectContaining({ code: 'GOAL_ALREADY_EXISTS' }),
    );
    service.complete(refOf(service));
    expect(service.create({ objective: '第二個' }).id).toBe('goal-2');
  });

  it('建服務時的預設上限自己也驗', () => {
    expect(() => attach({ defaultMaxGoalRounds: -1 })).toThrow(
      expect.objectContaining({ code: 'GOAL_INVALID_MAX_ROUNDS' }),
    );
  });
});

describe('CAS', () => {
  it('帶舊修訂號的變更被拒，錯誤碼是 GOAL_STALE_REVISION', () => {
    const { service } = attach();
    const stale = { id: service.create({ objective: 'a' }).id, revision: 1 };
    service.pause(stale);
    expect(() => service.pause(stale)).toThrow(
      expect.objectContaining({ code: 'GOAL_STALE_REVISION' }),
    );
  });

  it('錯誤訊息帶得出目前是哪一號——但那是給人看的，不是給客戶端解析的', () => {
    const { service } = attach();
    const view = service.create({ objective: 'a' });
    expect(() => service.clear({ id: view.id, revision: 9 })).toThrow(/過期了/u);
  });

  it('沒有目前目標時的變更是 GOAL_NOT_FOUND', () => {
    const { service } = attach();
    expect(() => service.pause({ id: goalId('goal-1'), revision: 1 })).toThrow(
      expect.objectContaining({ code: 'GOAL_NOT_FOUND' }),
    );
  });
});

describe('相位與授權', () => {
  it('六種操作各走一次，相位與授權都對得上', () => {
    const { service, tick } = attach();
    expect(service.create({ objective: '走一輪' }).activation).toBe('armed');

    tick(101);
    const paused = service.pause(refOf(service));
    expect([paused.phase, paused.activation]).toEqual(['paused', 'disarmed']);

    tick(102);
    const resumed = service.resume(refOf(service));
    expect([resumed.phase, resumed.activation]).toEqual(['active', 'armed']);

    tick(103);
    const blocked = service.block(refOf(service), { code: 'needs-info', message: '缺資訊' });
    expect([blocked.phase, blocked.activation]).toEqual(['blocked', 'disarmed']);
    expect(blocked.blockedReason).toEqual({ code: 'needs-info', message: '缺資訊' });

    tick(104);
    const edited = service.edit(refOf(service), { objective: '換一個說法' });
    // edit 不碰授權，也不碰相位與理由。
    expect([edited.phase, edited.activation, edited.objective]).toEqual([
      'blocked',
      'disarmed',
      '換一個說法',
    ]);
    expect(edited.blockedReason).toEqual({ code: 'needs-info', message: '缺資訊' });

    tick(105);
    const done = service.complete(refOf(service));
    expect([done.phase, done.activation]).toEqual(['complete', 'disarmed']);
    // 完成之後理由不再帶著——它只在 blocked 時存在。
    expect(done.blockedReason).toBeUndefined();

    const tombstone = service.clear({ id: done.id, revision: done.revision });
    expect(tombstone).toEqual({ id: done.id, revision: done.revision + 1 });
    expect(service.get()).toBeUndefined();
    expect(service.disarm()).toBeUndefined();
  });

  it('被拒的相位轉換各報各的', () => {
    const { service } = attach();
    service.create({ objective: 'a' });
    // 已經 active 而且已授權，resume 沒有意義。
    expect(() => service.resume(refOf(service))).toThrow(
      expect.objectContaining({ code: 'GOAL_INVALID_TRANSITION' }),
    );
    service.complete(refOf(service));
    expect(() => service.pause(refOf(service))).toThrow(/相位是 "complete"，pause 不了/u);
    expect(() => service.block(refOf(service), { code: 'x', message: 'y' })).toThrow(
      /相位是 "complete"，block 不了/u,
    );
    expect(() => service.complete(refOf(service))).toThrow(
      expect.objectContaining({ code: 'GOAL_INVALID_TRANSITION' }),
    );
  });

  it('disarm 收回授權但不動耐久狀態，之後 resume 收得回來', () => {
    const { service, log } = attach();
    const created = service.create({ objective: 'a' });
    const disarmed = service.disarm();
    expect(disarmed?.activation).toBe('disarmed');
    expect(disarmed?.revision).toBe(created.revision);
    // 日誌沒有多一筆——授權不是耐久狀態。
    expect(log.length).toBe(1);
    expect(service.resume(refOf(service)).activation).toBe('armed');
  });

  it('edit 兩格都沒給是 GOAL_INVALID_EDIT，block 的理由不合格是 GOAL_INVALID_BLOCK_REASON', () => {
    const { service } = attach();
    service.create({ objective: 'a' });
    expect(() => service.edit(refOf(service), {})).toThrow(
      expect.objectContaining({ code: 'GOAL_INVALID_EDIT' }),
    );
    expect(() => service.block(refOf(service), { code: 'Needs Info', message: 'x' })).toThrow(
      expect.objectContaining({ code: 'GOAL_INVALID_BLOCK_REASON' }),
    );
  });

  it('別人寫的 goal/change 會把授權打回 disarmed', () => {
    // 「別人」在這一版還不存在（沒有工具、沒有驅動器），但這條邊是 dsh 的語意，
    // 而它一旦被拿掉，未來多一個生產者的那天沒有人會發現授權跟著別人的變更飄了。
    const { service, log } = attach();
    const view = service.create({ objective: 'a' });
    expect(service.get()?.activation).toBe('armed');
    log.append('goal/change', {
      kind: 'goal/change',
      version: 1,
      operation: 'pause',
      goal: {
        id: view.id,
        revision: 2,
        objective: view.objective,
        phase: 'paused',
        maxGoalRounds: view.maxGoalRounds,
      },
      roundsStarted: 0,
      createdAt: 100,
      updatedAt: 101,
    });
    expect(service.get()?.activation).toBe('disarmed');
  });

  it('時鐘往回跳也不讓 updatedAt 倒退', () => {
    const { service, tick } = attach();
    service.create({ objective: 'a' });
    tick(50);
    expect(service.pause(refOf(service)).updatedAt).toBe(100);
  });
});

describe('折疊壞掉', () => {
  it('第一次重放失敗之後，讀與變更一律拒絕，而且丟的不是 GoalError', () => {
    const { service, log } = attach();
    service.create({ objective: 'a' });
    // 只有轉型騙得過型別；真流量上這是另一個生產者寫壞了才會發生的事。
    log.append('goal/change', {
      kind: 'goal/change',
      version: 1,
      operation: 'pause',
      goal: {
        id: goalId('goal-1'),
        revision: 9,
        objective: 'a',
        phase: 'paused',
        maxGoalRounds: 256,
      },
      roundsStarted: 0,
      createdAt: 100,
      updatedAt: 101,
    } as unknown as GoalChangeMeta);

    // **不是 GoalError**：可預期的拒絕與「這個會話的 goal 串壞了」是兩件事。
    expect(() => service.get()).toThrow(/goal 重放在會話事件 1 失敗/u);
    expect(() => service.get()).not.toThrow(GoalError);
    expect(() => service.create({ objective: 'b' })).toThrow(/goal 重放在會話事件 1 失敗/u);
    expect(() => service.pause({ id: goalId('goal-1'), revision: 1 })).toThrow(/重放/u);
  });

  it('壞掉之後不再往前折——後面來的事件不會蓋掉第一次的理由', () => {
    const { service, log } = attach();
    service.create({ objective: 'a' });
    const bad = {
      kind: 'goal/change',
      version: 1,
      operation: 'pause',
      goal: {
        id: goalId('goal-1'),
        revision: 9,
        objective: 'a',
        phase: 'paused',
        maxGoalRounds: 256,
      },
      roundsStarted: 0,
      createdAt: 100,
      updatedAt: 101,
    } as unknown as GoalChangeMeta;
    log.append('goal/change', bad);
    log.append('goal/change', bad);
    expect(() => service.get()).toThrow(/會話事件 1 失敗/u);
  });
});

describe('接上一份已經有內容的日誌', () => {
  it('安裝當下先重播，折出來的跟一路看著它長大一樣', () => {
    const first = attach();
    first.service.create({ objective: '先建起來的' });
    first.tick(101);
    first.service.pause(refOf(first.service));

    // 同一份日誌，接第二個 plugin 上去——它沒看過前面那兩筆，只能靠重播。
    const later = createGoalPlugin();
    const registry = createRegistry();
    const exit = registry.enter({ id: 'goal#1', name: 'goal' });
    later.apply(registry);
    exit();
    createSessionRunner({
      address: { kind: 'root' },
      log: first.log,
      installers: registry.sessions.installers(),
    });

    const view = later.serviceFor(first.log)?.get();
    expect(view?.phase).toBe('paused');
    expect(view?.revision).toBe(2);
    // **授權不重播**：它是 process 內的東西，重放一段歷史不該讓誰自己動起來。
    expect(view?.activation).toBe('disarmed');
  });
});

describe('roundsStarted', () => {
  it('走完整個生命週期都是 0——絆索在 fold.test.ts，這裡釘的是視圖那一面', () => {
    const { service, tick } = attach();
    service.create({ objective: 'a', maxGoalRounds: 1 });
    tick(101);
    service.pause(refOf(service));
    tick(102);
    // maxGoalRounds 是 1，而輪次是 0——所以「預算用完」這條在服務這側走不到。
    expect(service.resume(refOf(service)).roundsStarted).toBe(0);
  });
});
