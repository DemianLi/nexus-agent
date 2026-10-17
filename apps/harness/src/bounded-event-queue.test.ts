import { describe, expect, it } from 'vitest';

import { BoundedQueue, DEFAULT_DOWNLINK_MAX_BYTES, frameBytes } from './bounded-event-queue.js';

/**
 * 下行訂閱者的位元組有界佇列（[#1504](https://github.com/DemianLi/nexus-agent/issues/1504) 第 3 步）的單元。
 * 照 `TerminalFollower`（dsh `terminal-controller/src/stream.ts`）的語意逐點釘：用 UTF-8 位元組計、`已排 + 這顆 > 上限` 才拒、
 * 拒了不收；多出的是補送（`seed`），照算位元組但不判上限。
 */

describe('frameBytes', () => {
  it('以 JSON.stringify 後的 UTF-8 位元組計：中文一字三位元組', () => {
    expect(frameBytes({ a: 'x' })).toBe(Buffer.byteLength('{"a":"x"}', 'utf8'));
    expect(frameBytes('中')).toBe(5); // "中" 加兩個引號
  });

  it('序列化不了就拋（呼叫端要接住）：BigInt、循環參照', () => {
    expect(() => frameBytes({ n: 1n })).toThrow(/BigInt/u);
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => frameBytes(loop)).toThrow(/circular/iu);
  });

  it('沒有東西可送的值算 0，不拋', () => {
    expect(frameBytes(undefined)).toBe(0);
  });

  it('預設上限是 2 MiB，照 dsh 的 maxBufferedBytes', () => {
    expect(DEFAULT_DOWNLINK_MAX_BYTES).toBe(2 * 1024 * 1024);
  });
});

describe('BoundedQueue', () => {
  it('先進先出，取走後長度減少', () => {
    const queue = new BoundedQueue<string>(100);
    expect(queue.push('a', 1)).toBe(true);
    expect(queue.push('b', 1)).toBe(true);
    expect(queue.length).toBe(2);
    expect(queue.shift()).toBe('a');
    expect(queue.shift()).toBe('b');
    expect(queue.length).toBe(0);
    expect(queue.shift()).toBeUndefined();
  });

  it('剛好等於上限收，多一個位元組就拒；拒了不收、佇列原樣', () => {
    const queue = new BoundedQueue<string>(10);
    expect(queue.push('a', 6)).toBe(true);
    expect(queue.push('b', 4)).toBe(true); // 6 + 4 = 10，剛好
    expect(queue.push('c', 1)).toBe(false); // 11
    expect(queue.length).toBe(2);
  });

  it('單顆就比上限大：拒', () => {
    const queue = new BoundedQueue<string>(10);
    expect(queue.push('big', 11)).toBe(false);
    expect(queue.length).toBe(0);
  });

  it('取走之後位元組還回去，之後又收得下', () => {
    const queue = new BoundedQueue<string>(10);
    queue.push('a', 10);
    expect(queue.push('b', 1)).toBe(false);
    queue.shift();
    expect(queue.push('b', 10)).toBe(true);
  });

  it('seed 照算位元組、不判上限；之後的 push 看得到它們', () => {
    const queue = new BoundedQueue<string>(10);
    queue.seed('long', 50);
    expect(queue.length).toBe(1);
    expect(queue.push('next', 1)).toBe(false);
    expect(queue.shift()).toBe('long');
    expect(queue.push('next', 1)).toBe(true);
  });

  it('clear 清空並歸零位元組', () => {
    const queue = new BoundedQueue<string>(10);
    queue.push('a', 10);
    queue.clear();
    expect(queue.length).toBe(0);
    expect(queue.push('b', 10)).toBe(true);
  });
});
