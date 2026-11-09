/**
 * {@link RunSuspension} 的判定：停在等待點、都在 `idle` 卻沒人問、補記拋錯、收回放掉在 `idle` 等的。
 *
 * 經 harness 的線一路跑的見 `apps/harness/src/human-input-wire.test.ts`；這裡量的是那條路上不好造出來的情形。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  HumanInputWithdrawn,
  isHumanInputWithdrawn,
  waitClockOf,
  HUMAN_INPUT_CONFIG_KEY,
} from '../human-input.js';
import {
  delegationOf,
  RunSuspension,
  type CallPermit,
  type CallSlot,
  type Delegation,
} from './suspension.js';

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** 起跑一顆呼叫，回它的位子。 */
function started(suspension: RunSuspension, callId: string): CallSlot {
  const slot = suspension.slot(callId, [`tools:${callId}`]);
  slot.enter();
  return slot;
}

/** 假的併發名額：記下還與取，`acquire` 要測試自己放行。 */
function fakePermit(): CallPermit & { readonly log: string[]; grant(granted: boolean): void } {
  const log: string[] = [];
  const grants: ((granted: boolean) => void)[] = [];
  return {
    log,
    release: () => log.push('release'),
    acquire: () => {
      log.push('acquire');
      return new Promise((grant) => grants.push(grant));
    },
    grant: (granted) => grants.shift()?.(granted),
  };
}

describe('RunSuspension', () => {
  it('都在 idle、沒有一顆在問：判成錯誤，交給 onStuck，在 idle 等的以 HumanInputWithdrawn 拒絕，不停在等待點', async () => {
    const onPark = vi.fn();
    const onStuck = vi.fn();
    const suspension = new RunSuspension(onPark, onStuck);
    const waiting = started(suspension, 'c1').service.idle(new Promise<never>(() => {}));
    const outcome = waiting.then(
      () => 'resolved',
      (error: unknown) => error,
    );
    await tick();
    await tick();

    expect(onPark).not.toHaveBeenCalled();
    expect(onStuck).toHaveBeenCalledTimes(1);
    const error = onStuck.mock.calls[0]?.[0] as Error;
    expect(error.message).toContain('沒有一顆在問人');
    expect(await outcome).toBeInstanceOf(HumanInputWithdrawn);
    expect(suspension.withdrawn).toBe(true);
  });

  it('判成卡死：onWithdraw 登記的先叫，再交出錯誤；叫過一次就退掉', async () => {
    const order: string[] = [];
    const suspension = new RunSuspension(vi.fn(), () => order.push('stuck'));
    suspension.onWithdraw(() => order.push('settled'));
    const unsubscribed = vi.fn();
    suspension.onWithdraw(unsubscribed)();
    started(suspension, 'c1')
      .service.idle(new Promise<never>(() => {}))
      .catch(() => order.push('idle rejected'));
    await tick();
    await tick();

    expect(order).toEqual(['settled', 'stuck', 'idle rejected']);
    expect(unsubscribed).not.toHaveBeenCalled();
    suspension.withdraw();
    expect(order).toEqual(['settled', 'stuck', 'idle rejected']);
  });

  it('收回：onWithdraw 登記的先叫，再拒絕還沒答的提問', async () => {
    const order: string[] = [];
    const suspension = new RunSuspension(vi.fn(), vi.fn());
    suspension.onWithdraw(() => order.push('settled'));
    started(suspension, 'c1')
      .service.ask('q')
      .catch((error: unknown) =>
        order.push(error instanceof HumanInputWithdrawn ? 'ask withdrawn' : 'other'),
      );
    await tick();

    suspension.withdraw();
    await tick();
    expect(order).toEqual(['settled', 'ask withdrawn']);
  });

  it('一顆在問、一顆在 idle：停在等待點，不判成錯誤', async () => {
    const onPark = vi.fn();
    const onStuck = vi.fn();
    const suspension = new RunSuspension(onPark, onStuck);
    void started(suspension, 'c1').service.ask({ q: 1 });
    void started(suspension, 'c2').service.idle(new Promise<never>(() => {}));
    await tick();
    await tick();

    expect(onStuck).not.toHaveBeenCalled();
    expect(onPark).toHaveBeenCalledTimes(1);
    expect(onPark.mock.calls[0]?.[0]).toMatchObject([{ callId: 'c1', value: { q: 1 } }]);
  });

  it('還有一顆在跑：不停、不判錯；它收完之後才停', async () => {
    const onPark = vi.fn();
    const onStuck = vi.fn();
    const suspension = new RunSuspension(onPark, onStuck);
    void started(suspension, 'c1').service.ask('q');
    const running = started(suspension, 'c2');
    await tick();
    await tick();
    expect(onPark).not.toHaveBeenCalled();

    running.exit();
    await tick();
    expect(onPark).toHaveBeenCalledTimes(1);
    expect(onStuck).not.toHaveBeenCalled();
  });

  it('接回的 listener 拋錯：那次提問以同一個錯拒絕，不懸著', async () => {
    const suspension = new RunSuspension(
      () => {},
      () => {},
    );
    const { service } = started(suspension, 'c1');
    const failure = new Error('日誌拒收');
    service.onResumed(() => {
      throw failure;
    });
    const asked = service.ask('q').then(
      () => 'resolved',
      (error: unknown) => error,
    );
    await tick();
    suspension.resume({ [suspension.pending[0]!.id]: 'A' });

    expect(await asked).toBe(failure);
    expect(suspension.pending).toEqual([]);
  });

  it('接回：還掛著的每一顆都叫 listener（答到的、沒答到的），全部叫完才交回答覆；沒答到的照舊掛著', async () => {
    const suspension = new RunSuspension(
      () => {},
      () => {},
    );
    const order: string[] = [];
    const first = started(suspension, 'c1').service;
    const second = started(suspension, 'c2').service;
    first.onResumed(() => order.push('c1 resumed'));
    second.onResumed(() => order.push('c2 resumed'));
    const asked = first.ask('q1').then((answer) => order.push(`c1 got ${String(answer)}`));
    void second.ask('q2');
    await tick();
    const [one, two] = suspension.pending;
    suspension.resume({ [one!.id]: 'A' });
    await asked;

    expect(order).toEqual(['c1 resumed', 'c2 resumed', 'c1 got A']);
    expect(suspension.pending.map((ask) => ask.id)).toEqual([two!.id]);
  });

  it('收回：問的當場拒絕；之後還在 idle 等、等的事又不會再動的，下一拍也以 HumanInputWithdrawn 拒絕', async () => {
    const suspension = new RunSuspension(
      () => {},
      () => {},
    );
    const asked = started(suspension, 'c1')
      .service.ask('q')
      .catch((error: unknown) => error);
    const idled = started(suspension, 'c2')
      .service.idle(new Promise<never>(() => {}))
      .catch((error: unknown) => error);
    await tick();
    suspension.withdraw();

    expect(isHumanInputWithdrawn(await asked)).toBe(true);
    expect(isHumanInputWithdrawn(await idled)).toBe(true);
    await expect(started(suspension, 'c3').service.ask('q')).rejects.toSatisfy(
      isHumanInputWithdrawn,
    );
  });

  it('呼叫在提問還沒落定時就收完（外層先收掉它）：那次提問拒絕、不再掛著；之後的呼叫照常停在等待點', async () => {
    const onPark = vi.fn();
    const suspension = new RunSuspension(onPark, () => {});
    const first = started(suspension, 'c1');
    const asked = first.service.ask('q1').catch((error: unknown) => error);
    const idling = started(suspension, 'c2');
    const idled = idling.service
      .idle(new Promise<never>(() => {}))
      .catch((error: unknown) => error);
    const running = started(suspension, 'c3');
    first.exit();
    idling.exit();

    expect(isHumanInputWithdrawn(await asked)).toBe(true);
    expect(isHumanInputWithdrawn(await idled)).toBe(true);
    expect(suspension.pending).toEqual([]);
    await expect(first.service.ask('again')).rejects.toSatisfy(isHumanInputWithdrawn);
    running.exit();
    await tick();
    expect(onPark).not.toHaveBeenCalled();

    void started(suspension, 'c4').service.ask('q4');
    await tick();
    await tick();
    expect(onPark).toHaveBeenCalledTimes(1);
    expect(onPark.mock.calls[0]?.[0]).toMatchObject([{ callId: 'c4', value: 'q4' }]);
  });

  it('這一批的中止舉起時（兄弟失敗），停在提問上、不理中止的那顆也不會停在等待點：提問以中止的原因拒絕，之後的提問與 idle 當場拒絕', async () => {
    const onPark = vi.fn();
    const suspension = new RunSuspension(onPark, () => {});
    const step = new AbortController();
    const asking = suspension.slot('q1', ['tools:q1'], step.signal);
    asking.enter();
    const failing = suspension.slot('b1', ['tools:b1'], step.signal);
    failing.enter();
    const asked = asking.service.ask('q').catch((error: unknown) => error);
    // 同 `runBounded`：失敗那顆先收完（這一拍數到 0、一顆在問），之後才舉起這一批的中止。
    failing.exit();
    step.abort();

    expect(await asked).toBe(step.signal.reason);
    expect(step.signal.reason).toMatchObject({ name: 'AbortError' });
    await expect(asking.service.ask('again')).rejects.toBe(step.signal.reason);
    await expect(asking.service.idle(new Promise<never>(() => {}))).rejects.toBe(
      step.signal.reason,
    );
    await tick();
    await tick();
    expect(onPark).not.toHaveBeenCalled();
    expect(suspension.pending).toEqual([]);
  });

  it('收回之後才開始等的 idle：當場拒絕，不留著等', async () => {
    const suspension = new RunSuspension(
      () => {},
      () => {},
    );
    const late = started(suspension, 'c1');
    suspension.withdraw();
    await tick();
    const outcome = late.service.idle(new Promise<never>(() => {})).then(
      () => 'resolved',
      (error: unknown) => error,
    );
    const first = await Promise.race([outcome, tick().then(() => 'pending')]);

    expect(isHumanInputWithdrawn(first)).toBe(true);
  });

  it('接回時一顆答覆都沒帶：當場拋，什麼都沒動；之後帶著答覆照常接回', async () => {
    const suspension = new RunSuspension(
      () => {},
      () => {},
    );
    const { service } = started(suspension, 'c1');
    const resumed = vi.fn();
    service.onResumed(resumed);
    const asked = service.ask('q');
    await tick();
    const [ask] = suspension.pending;

    expect(() => suspension.resume({})).toThrow('沒有帶任何一顆答覆');
    expect(resumed).not.toHaveBeenCalled();
    expect(suspension.pending.map((pending) => pending.id)).toEqual([ask!.id]);
    suspension.resume({ [ask!.id]: 'A' });
    expect(await asked).toBe('A');
  });

  describe('併發名額', () => {
    it('ask 上等時還回名額；答了先取回名額，拿到才交回答覆；時鐘只在取回之後才停', async () => {
      const suspension = new RunSuspension(
        () => {},
        () => {},
      );
      const permit = fakePermit();
      const slot = suspension.slot('c1', ['tools:c1'], undefined, permit);
      slot.enter();
      const clock = waitClockOf({ configurable: { [HUMAN_INPUT_CONFIG_KEY]: slot.service } })!;
      const states: boolean[] = [];
      clock.onWaiting((waiting) => states.push(waiting));
      let answer: unknown = 'pending';
      void slot.service.ask('q').then((value) => (answer = value));
      await tick();
      expect(permit.log).toEqual(['release']);
      expect(states).toEqual([true]);

      suspension.resume({ [suspension.pending[0]!.id]: 'A' });
      await tick();
      expect(permit.log).toEqual(['release', 'acquire']);
      expect(answer).toBe('pending');
      expect(states).toEqual([true]);

      permit.grant(true);
      await tick();
      expect(answer).toBe('A');
      expect(states).toEqual([true, false]);
    });

    it('排隊取回名額的那顆算在跑：同一批另一顆還在問，也不停在等待點；它收完才停', async () => {
      const onPark = vi.fn();
      const suspension = new RunSuspension(onPark, () => {});
      const permit = fakePermit();
      const first = suspension.slot('c1', ['tools:c1'], undefined, permit);
      first.enter();
      void first.service.ask('q1');
      void started(suspension, 'c2').service.ask('q2');
      await tick();
      await tick();
      expect(onPark).toHaveBeenCalledTimes(1);

      const [one] = suspension.pending;
      suspension.resume({ [one!.id]: 'A' });
      await tick();
      await tick();
      expect(permit.log).toEqual(['release', 'acquire']);
      expect(onPark).toHaveBeenCalledTimes(1);

      permit.grant(true);
      await tick();
      first.exit();
      await tick();
      expect(onPark).toHaveBeenCalledTimes(2);
      expect(onPark.mock.calls[1]?.[0]).toMatchObject([{ callId: 'c2', value: 'q2' }]);
    });

    it('取回時這一批不再發名額（拿到 false）：照樣交回答覆，不懸著', async () => {
      const suspension = new RunSuspension(
        () => {},
        () => {},
      );
      const permit = fakePermit();
      const slot = suspension.slot('c1', ['tools:c1'], undefined, permit);
      slot.enter();
      const asked = slot.service.ask('q');
      await tick();
      suspension.resume({ [suspension.pending[0]!.id]: 'A' });
      await tick();
      permit.grant(false);

      expect(await asked).toBe('A');
    });

    it('等的期間被拒絕（收回、這一批中止）：不去取名額，直接以那個錯交回', async () => {
      const suspension = new RunSuspension(
        () => {},
        () => {},
      );
      const step = new AbortController();
      const withdrawn = fakePermit();
      const halted = fakePermit();
      const first = suspension.slot('c1', ['tools:c1'], step.signal, halted);
      first.enter();
      const aborted = first.service.ask('q1').catch((error: unknown) => error);
      step.abort();
      expect(await aborted).toBe(step.signal.reason);
      expect(halted.log).toEqual(['release']);

      const second = suspension.slot('c2', ['tools:c2'], undefined, withdrawn);
      second.enter();
      const asked = second.service.ask('q2').catch((error: unknown) => error);
      await tick();
      suspension.withdraw();
      expect(isHumanInputWithdrawn(await asked)).toBe(true);
      expect(withdrawn.log).toEqual(['release']);
    });
  });

  describe('委派：前景子代理在 root 那顆 task 呼叫底下開自己的呼叫', () => {
    /** root 起跑一顆 task，回它與它的委派。 */
    function delegating(
      suspension: RunSuspension,
      callId = 'task',
    ): {
      readonly slot: CallSlot;
      readonly delegation: Delegation;
    } {
      const slot = started(suspension, callId);
      const delegation = delegationOf(slot.service);
      if (delegation === undefined) throw new Error('slot 的服務沒有委派');
      return { slot, delegation };
    }

    /** 子代理起跑一批工具：子代理本身在等這一批，它的呼叫各自起跑。 */
    function childBatch(
      delegation: Delegation,
      callIds: readonly string[],
    ): { readonly slots: CallSlot[]; readonly done: () => void } {
      let finish!: () => void;
      void delegation.away(new Promise<void>((resolve) => (finish = resolve)));
      const slots = callIds.map((id) => {
        const slot = delegation.slot(id, ['tools:task', `tools:${id}`]);
        slot.enter();
        return slot;
      });
      return { slots, done: () => finish() };
    }

    it('子代理還在叫模型、root 的另一顆在問：不停在等待點', async () => {
      const onPark = vi.fn();
      const suspension = new RunSuspension(onPark, vi.fn());
      delegating(suspension);
      void started(suspension, 'x').service.ask('q');
      await tick();
      await tick();
      expect(onPark).not.toHaveBeenCalled();
    });

    it('子代理還在叫模型、root 的另一顆在 idle：不判成卡死', async () => {
      const onStuck = vi.fn();
      const suspension = new RunSuspension(vi.fn(), onStuck);
      delegating(suspension);
      void started(suspension, 'x').service.idle(new Promise<never>(() => {}));
      await tick();
      await tick();
      expect(onStuck).not.toHaveBeenCalled();
    });

    it('子代理那一批都在問：停在等待點，提問帶子代理那顆呼叫的巢狀命名空間', async () => {
      const onPark = vi.fn();
      const suspension = new RunSuspension(onPark, vi.fn());
      const { delegation } = delegating(suspension);
      const { slots } = childBatch(delegation, ['c1']);
      void slots[0]!.service.ask('q');
      await tick();
      await tick();
      expect(onPark).toHaveBeenCalledTimes(1);
      expect(onPark.mock.calls[0]?.[0]).toMatchObject([
        { callId: 'c1', value: 'q', namespace: ['tools:task', 'tools:c1'] },
      ]);
    });

    it('子代理那一批一顆在問、一顆還在跑：不停；跑的那顆收完才停', async () => {
      const onPark = vi.fn();
      const suspension = new RunSuspension(onPark, vi.fn());
      const { delegation } = delegating(suspension);
      const { slots } = childBatch(delegation, ['c1', 'c2']);
      void slots[0]!.service.ask('q');
      await tick();
      await tick();
      expect(onPark).not.toHaveBeenCalled();
      slots[1]!.exit();
      await tick();
      await tick();
      expect(onPark).toHaveBeenCalledTimes(1);
    });

    it('子代理那一批都在 idle、沒有一顆在問，root 也沒別的在跑：判成卡死', async () => {
      const onStuck = vi.fn();
      const suspension = new RunSuspension(vi.fn(), onStuck);
      const { delegation } = delegating(suspension);
      const { slots } = childBatch(delegation, ['c1']);
      void slots[0]!.service.idle(new Promise<never>(() => {})).catch(() => undefined);
      await tick();
      await tick();
      expect(onStuck).toHaveBeenCalledTimes(1);
    });

    it('接回子代理那顆：子代理接著跑，root 另一顆再問也不停；子代理那一批收完、回去叫模型時照舊算在跑', async () => {
      const onPark = vi.fn();
      const suspension = new RunSuspension(onPark, vi.fn());
      const { delegation } = delegating(suspension);
      const { slots, done } = childBatch(delegation, ['c1']);
      const asked = slots[0]!.service.ask('q');
      await tick();
      await tick();
      expect(onPark).toHaveBeenCalledTimes(1);
      const id = suspension.pending[0]!.id;
      suspension.resume({ [id]: 'A' });
      expect(await asked).toBe('A');
      slots[0]!.exit();
      done();
      await tick();
      void started(suspension, 'x').service.ask('q2');
      await tick();
      await tick();
      expect(onPark).toHaveBeenCalledTimes(1);
    });

    it('delegationOf：RunSuspension 發的服務開得出委派，別的服務沒有', () => {
      const suspension = new RunSuspension(vi.fn(), vi.fn());
      expect(delegationOf(started(suspension, 'c').service)).toBeDefined();
      expect(
        delegationOf({ ask: vi.fn(), idle: vi.fn(), onResumed: vi.fn() } as never),
      ).toBeUndefined();
    });
  });
});
