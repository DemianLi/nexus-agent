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
});
