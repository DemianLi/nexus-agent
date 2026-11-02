import type { WireQueuedInput } from '@nexus/wire';
import { describe, expect, it, vi } from 'vitest';

import type { QueueUpdateRejected } from '@/hooks/use-conversation';

import { canSteerQueue, canSteerRows, steerAll } from './steer-queue';

const item = (id: string): WireQueuedInput => ({ id, text: id, source: { kind: 'user' } });
const rejected = (over: Partial<QueueUpdateRejected>): QueueUpdateRejected => ({
  gone: false,
  unavailable: false,
  message: 'x',
  ...over,
});

describe('canSteerRows／canSteerQueue（#710，照 dsh）', () => {
  it('只有連得上、這一輪跑著才能插話', () => {
    expect(canSteerRows(true, 'running')).toBe(true);
    expect(canSteerRows(false, 'running')).toBe(false);
    for (const status of ['idle', 'stopped', 'failed', 'awaiting-input'] as const) {
      expect(canSteerRows(true, status)).toBe(false);
    }
  });

  it('草稿空白、有排著的，那個手勢才是「全部改成插話」', () => {
    expect(canSteerQueue(true, 'running', '', 2)).toBe(true);
    expect(canSteerQueue(true, 'running', '   \n', 1)).toBe(true);
    expect(canSteerQueue(true, 'running', '有字', 2)).toBe(false);
    expect(canSteerQueue(true, 'running', '', 0)).toBe(false);
    expect(canSteerQueue(true, 'idle', '', 2)).toBe(false);
    expect(canSteerQueue(false, 'running', '', 2)).toBe(false);
  });
});

describe('steerAll', () => {
  it('照排的先後一件一件送，一件送完才送下一件', async () => {
    const order: string[] = [];
    const update = vi.fn(async (id: string) => {
      order.push(`start:${id}`);
      await Promise.resolve();
      order.push(`end:${id}`);
      return undefined;
    });
    expect(await steerAll([item('a'), item('b'), item('c')], update)).toEqual({ kind: 'done' });
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
    expect(update).toHaveBeenCalledWith('a', { kind: 'steer' });
  });

  it('不收了或那一件不在隊裡：靜靜停，後面的不送', async () => {
    for (const over of [{ unavailable: true }, { gone: true }]) {
      const update = vi.fn(async (id: string) => (id === 'b' ? rejected(over) : undefined));
      expect(await steerAll([item('a'), item('b'), item('c')], update)).toEqual({
        kind: 'stopped',
      });
      expect(update.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
    }
  });

  it('別的失敗：停下來，帶原因', async () => {
    const update = vi.fn(async () => rejected({ message: 'fetch failed' }));
    expect(await steerAll([item('a'), item('b')], update)).toEqual({
      kind: 'failed',
      message: 'fetch failed',
    });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('沒有排著的就什麼都不送', async () => {
    const update = vi.fn();
    expect(await steerAll([], update)).toEqual({ kind: 'done' });
    expect(update).not.toHaveBeenCalled();
  });
});
