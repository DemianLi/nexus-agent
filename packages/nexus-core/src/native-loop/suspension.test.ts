/**
 * {@link RunSuspension} 的判定：停在等待點、都在 `idle` 卻沒人問、補記拋錯、收回放掉在 `idle` 等的。
 *
 * 經 harness 的線一路跑的見 `apps/harness/src/human-input-wire.test.ts`；這裡量的是那條路上不好造出來的情形。
 */

import { describe, expect, it, vi } from 'vitest';

import { isHumanInputWithdrawn } from '../human-input.js';
import { RunSuspension, type CallSlot } from './suspension.js';

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** 起跑一顆呼叫，回它的位子。 */
function started(suspension: RunSuspension, callId: string): CallSlot {
  const slot = suspension.slot(callId, [`tools:${callId}`]);
  slot.enter();
  return slot;
}

describe('RunSuspension', () => {
  it('都在 idle、沒有一顆在問：判成錯誤，交給 onStuck，在 idle 等的以同一個錯拒絕，不停在等待點', async () => {
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
    expect(await outcome).toBe(error);
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
});
