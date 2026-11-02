/**
 * 收尾順序的一致性測試（[#1636](https://github.com/DemianLi/nexus-agent/issues/1636)，Q3 (a)）：插件規範〈收尾順序〉靠的是
 * vendor Cordis 的這兩種行為，上游哪天改了，這裡先紅。
 *
 * - **同一個 effect 裡**收集的多個 disposer：倒序、前一個收完才跑下一個（`vendor/cordis/src/fiber.ts` 的 `effect`，
 *   `task.then(dispose)` 串起來）。有順序要求的收尾就放這裡。
 * - **兄弟 effect**：同時開跑（`_unload` 的 `Promise.all`；上游同一件事的斷言在 `tests/service-dispose.spec.ts`）。
 *   誰先開始不釘，只釘「兩個都開始了，才有一個結束」。
 *
 * 照 dsh `docs/cordis-primer.md`〈Practical Rules〉：「If teardown order matters, keep the related work in one effect」。
 */

import { setImmediate } from 'node:timers/promises';

import { Context } from '@nexus/cordis';
import { describe, expect, it } from 'vitest';

/** 一個從外面 resolve 的 promise（sdk 的 tsconfig lib 沒有 `Promise.withResolvers`）。 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

describe('收尾順序（#1636）', () => {
  it('同一個 effect 裡：倒序，後登記的收完才跑先登記的', async () => {
    const root = new Context();
    const timeline: string[] = [];
    const second = deferred();
    await root.plugin((ctx) => {
      ctx.effect(function* () {
        yield async () => {
          timeline.push('first start');
          await Promise.resolve();
          timeline.push('first end');
        };
        yield async () => {
          timeline.push('second start');
          await second.promise;
          timeline.push('second end');
        };
      });
    });
    const task = root.fiber.dispose();
    await setImmediate();
    const during = [...timeline];
    second.resolve();
    await task;
    expect(during).toEqual(['second start']);
    expect(timeline).toEqual(['second start', 'second end', 'first start', 'first end']);
  });

  it('兄弟 effect：同時開跑，不等對方收完', async () => {
    const root = new Context();
    const timeline: string[] = [];
    const gates = [deferred(), deferred()] as const;
    await root.plugin((ctx) => {
      for (const [index, gate] of gates.entries()) {
        ctx.effect(() => async () => {
          timeline.push(`${String(index)} start`);
          await gate.promise;
          timeline.push(`${String(index)} end`);
        });
      }
    });
    const task = root.fiber.dispose();
    await setImmediate();
    const during = [...timeline].sort();
    for (const gate of gates) gate.resolve();
    await task;
    expect(during).toEqual(['0 start', '1 start']);
    expect(timeline).toHaveLength(4);
  });
});
