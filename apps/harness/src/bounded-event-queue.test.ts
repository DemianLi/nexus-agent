import { describe, expect, it } from 'vitest';

import {
  BoundedQueue,
  DEFAULT_DOWNLINK_MAX_BYTES,
  DEPTH_TRUNCATED,
  DOWNLINK_MAX_DEPTH,
  boundFrame,
  frameBytes,
} from './bounded-event-queue.js';

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

/** 迭代造一條 `n` 層的陣列鏈（根算第 1 層），遞迴造的話測試自己先爆。 */
function chain(n: number): unknown[] {
  const root: unknown[] = [];
  let tail = root;
  for (let level = 1; level < n; level++) {
    const next: unknown[] = [];
    tail.push(next);
    tail = next;
  }
  return root;
}

/** 從根往下數到第一個不是陣列的東西，數出有幾層陣列；迭代。 */
function arrayDepth(value: unknown): number {
  let depth = 0;
  let current: unknown = value;
  while (Array.isArray(current)) {
    depth += 1;
    current = current[0];
  }
  return depth;
}

describe('boundFrame（偏離 D：下行副本的巢狀深度截斷，#1560 N1384）', () => {
  it('門檻是日誌上限的兩倍', () => {
    expect(DOWNLINK_MAX_DEPTH).toBe(1200);
  });

  it('沒超過門檻的原樣回傳，不複製：剛好 1200 層', () => {
    const frame = { data: chain(DOWNLINK_MAX_DEPTH - 1) }; // 外層物件 1 層 ＋ 陣列 1199 層
    const bounded = boundFrame(frame);
    expect(bounded.truncated).toBe(false);
    expect(bounded.frame).toBe(frame);
  });

  it('多一層就截斷：超過的子樹換成佔位，其餘原樣；來源物件沒被改', () => {
    const deep = chain(DOWNLINK_MAX_DEPTH); // 加上外層物件共 1201 層
    const frame = { keep: 'x', data: deep };
    const bounded = boundFrame(frame);
    expect(bounded.truncated).toBe(true);
    expect(bounded.frame).not.toBe(frame);
    const copy = bounded.frame as { keep: string; data: unknown[] };
    expect(copy.keep).toBe('x');
    // 外層物件算第 1 層，所以陣列只留 1199 層，第 1200 層的位置是佔位字串。
    let tail: unknown = copy.data;
    let arrays = 0;
    while (Array.isArray(tail) && typeof tail[0] !== 'string') {
      arrays += 1;
      tail = tail[0];
    }
    expect(arrays).toBe(DOWNLINK_MAX_DEPTH - 2);
    expect(Array.isArray(tail) ? tail[0] : tail).toBe(DEPTH_TRUNCATED);
    expect(arrayDepth(frame.data)).toBe(DOWNLINK_MAX_DEPTH); // 來源原樣
  });

  // 兩萬層：Linux Node 22 的遞迴 JSON.stringify 約 5000 層就 RangeError（實測），macOS Node 25 不會，所以不斷言「截之前會爆」，只斷言截之後的結果。
  it('兩萬層：截斷後算得出位元組、序列化不拋', () => {
    const frame = { data: chain(20_000) };
    const bounded = boundFrame(frame);
    expect(bounded.truncated).toBe(true);
    expect(bounded.bytes).toBe(Buffer.byteLength(JSON.stringify(bounded.frame), 'utf8'));
    expect(bounded.bytes).toBeGreaterThan(DOWNLINK_MAX_DEPTH);
  });

  it('不是陣列也不是純物件的值原樣留著，不算層數', () => {
    const when = new Date(0);
    const bounded = boundFrame({ chain: chain(DOWNLINK_MAX_DEPTH), when });
    expect((bounded.frame as { when: Date }).when).toBe(when);
  });

  it('JSON 表達不出來的照拋，由呼叫端照偏離 C 處理：BigInt、循環參照（循環不會走不完）', () => {
    expect(() => boundFrame({ n: 1n })).toThrow(/BigInt/u);
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => boundFrame(loop)).toThrow(/circular/iu);
  });

  it('同一個物件出現兩次（共用）時只複製一份，深的那份也不會成倍長大', () => {
    const shared = chain(DOWNLINK_MAX_DEPTH + 50);
    const bounded = boundFrame({ a: shared, b: shared });
    const copy = bounded.frame as { a: unknown; b: unknown };
    expect(copy.a).toBe(copy.b);
  });
});
