/**
 * 合併器本體（[#1071](https://github.com/DemianLi/nexus-agent/issues/1071)）。計時器換成假的，逐條釘死視窗的行為；
 * 走產品路徑的在 `projection-coalesce-wire.test.ts`。
 */

import type { CustomFrameData } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import type { CoalescerTimers } from './projection-coalescer.js';
import { ProjectionCoalescer } from './projection-coalescer.js';

/** 手動撥時間的計時器。 */
function fakeTimers() {
  let now = 0;
  let nextId = 0;
  const live = new Map<number, { at: number; callback: () => void }>();
  const timers: CoalescerTimers = {
    set: (callback, ms) => {
      const id = nextId++;
      live.set(id, { at: now + ms, callback });
      return id;
    },
    clear: (handle) => {
      live.delete(handle as number);
    },
  };
  return {
    timers,
    pending: () => live.size,
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...live]) {
        if (timer.at <= now) {
          live.delete(id);
          timer.callback();
        }
      }
    },
  };
}

const frame = (key: string, n: number): CustomFrameData =>
  ({ name: 'projection', payload: { key, version: 1, view: { n } } }) as unknown as CustomFrameData;
const views = (sent: readonly CustomFrameData[]) =>
  sent.map((data) => {
    const { key, view } = (data as unknown as { payload: { key: string; view: { n: number } } })
      .payload;
    return `${key}:${view.n}`;
  });

function setup(flushMs = 100) {
  const clock = fakeTimers();
  const sent: CustomFrameData[] = [];
  const coalescer = new ProjectionCoalescer((data) => sent.push(data), flushMs, clock.timers);
  return { clock, sent, coalescer };
}

describe('ProjectionCoalescer', () => {
  it('一陣連續的變更只在視窗到的時候送一顆，送的是那一刻最新的值', () => {
    const { clock, sent, coalescer } = setup();
    coalescer.offer('a', frame('a', 1));
    coalescer.offer('a', frame('a', 2));
    coalescer.offer('a', frame('a', 3));
    expect(sent).toEqual([]);
    clock.advance(99);
    expect(sent).toEqual([]);
    clock.advance(1);
    expect(views(sent)).toEqual(['a:3']);
  });

  it('視窗送完之後再來的變更另開一個視窗', () => {
    const { clock, sent, coalescer } = setup();
    coalescer.offer('a', frame('a', 1));
    clock.advance(100);
    coalescer.offer('a', frame('a', 2));
    coalescer.offer('a', frame('a', 3));
    clock.advance(100);
    expect(views(sent)).toEqual(['a:1', 'a:3']);
  });

  it('不同單元互不相干：各自一個視窗、各送各的最新值', () => {
    const { clock, sent, coalescer } = setup();
    coalescer.offer('a', frame('a', 1));
    coalescer.offer('b', frame('b', 1));
    coalescer.offer('a', frame('a', 2));
    coalescer.offer('b', frame('b', 2));
    clock.advance(100);
    expect(views(sent)).toEqual(['a:2', 'b:2']);
  });

  it('flush：待送的當場全送，視窗作廢，計時器之後不再多送', () => {
    const { clock, sent, coalescer } = setup();
    coalescer.offer('a', frame('a', 1));
    coalescer.offer('b', frame('b', 1));
    coalescer.offer('a', frame('a', 2));
    coalescer.flush();
    expect(views(sent)).toEqual(['a:2', 'b:1']);
    expect(clock.pending()).toBe(0);
    clock.advance(1000);
    expect(views(sent)).toEqual(['a:2', 'b:1']);
    // flush 之後新的變更照常開新視窗。
    coalescer.offer('a', frame('a', 3));
    clock.advance(100);
    expect(views(sent)).toEqual(['a:2', 'b:1', 'a:3']);
  });

  it('不合併的變更（輪外）當場送，並作廢同一個單元排著的視窗與舊值：先後不倒', () => {
    const { clock, sent, coalescer } = setup();
    coalescer.offer('a', frame('a', 1));
    coalescer.offer('b', frame('b', 1));
    coalescer.offer('a', frame('a', 2), false);
    expect(views(sent)).toEqual(['a:2']);
    clock.advance(100);
    // 舊的 a:1 不會倒過來蓋掉 a:2；沒被影響的 b 照常送。
    expect(views(sent)).toEqual(['a:2', 'b:1']);
  });

  it('flushMs 為 0：不合併，每次當場送', () => {
    const { clock, sent, coalescer } = setup(0);
    coalescer.offer('a', frame('a', 1));
    coalescer.offer('a', frame('a', 2));
    expect(views(sent)).toEqual(['a:1', 'a:2']);
    expect(clock.pending()).toBe(0);
  });

  it('dispose：待送的丟掉、視窗作廢，之後什麼都不送', () => {
    const { clock, sent, coalescer } = setup();
    coalescer.offer('a', frame('a', 1));
    coalescer.dispose();
    expect(clock.pending()).toBe(0);
    clock.advance(1000);
    expect(sent).toEqual([]);
  });
});
