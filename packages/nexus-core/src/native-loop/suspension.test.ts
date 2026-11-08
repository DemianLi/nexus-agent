/**
 * {@link RunSuspension} 的判定：停在等待點、都在 `idle` 卻沒人問、補記拋錯、收回放掉在 `idle` 等的。
 *
 * 經 harness 的線一路跑的見 `apps/harness/src/human-input-wire.test.ts`；這裡量的是那條路上造不出來的兩種情形。
 */

import { describe, expect, it, vi } from 'vitest';

import { isHumanInputWithdrawn } from '../human-input.js';
import { RunSuspension } from './suspension.js';

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('RunSuspension', () => {
  it('都在 idle、沒有一顆在問：判成錯誤，交給 onStuck，在 idle 等的以同一個錯拒絕，不停在等待點', async () => {
    const onPark = vi.fn();
    const onStuck = vi.fn();
    const suspension = new RunSuspension(onPark, onStuck);
    suspension.enter();
    const waiting = suspension.serviceFor('c1', ['tools:c1']).idle(new Promise<never>(() => {}));
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
    suspension.enter();
    suspension.enter();
    void suspension.serviceFor('c1', ['tools:c1']).ask({ q: 1 });
    void suspension.serviceFor('c2', ['tools:c2']).idle(new Promise<never>(() => {}));
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
    suspension.enter();
    suspension.enter();
    void suspension.serviceFor('c1', ['tools:c1']).ask('q');
    await tick();
    await tick();
    expect(onPark).not.toHaveBeenCalled();

    suspension.exit();
    await tick();
    expect(onPark).toHaveBeenCalledTimes(1);
    expect(onStuck).not.toHaveBeenCalled();
  });

  it('接回的 listener 拋錯：那次提問以同一個錯拒絕，不懸著', async () => {
    const suspension = new RunSuspension(
      () => {},
      () => {},
    );
    suspension.enter();
    const service = suspension.serviceFor('c1', ['tools:c1']);
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
    suspension.enter();
    suspension.enter();
    const order: string[] = [];
    const first = suspension.serviceFor('c1', ['tools:c1']);
    const second = suspension.serviceFor('c2', ['tools:c2']);
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
    suspension.enter();
    suspension.enter();
    const asked = suspension
      .serviceFor('c1', ['tools:c1'])
      .ask('q')
      .catch((error: unknown) => error);
    const idled = suspension
      .serviceFor('c2', ['tools:c2'])
      .idle(new Promise<never>(() => {}))
      .catch((error: unknown) => error);
    await tick();
    suspension.withdraw();

    expect(isHumanInputWithdrawn(await asked)).toBe(true);
    expect(isHumanInputWithdrawn(await idled)).toBe(true);
    await expect(suspension.serviceFor('c3', ['tools:c3']).ask('q')).rejects.toSatisfy(
      isHumanInputWithdrawn,
    );
  });
});
