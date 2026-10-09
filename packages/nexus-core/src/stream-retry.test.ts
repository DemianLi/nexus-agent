/**
 * 串流中段重打的規則（[#520](https://github.com/DemianLi/nexus-agent/issues/520)）：什麼時候重打、重打幾次、等多久、
 * 中止時怎麼收。真的打假端點、走完 pump 與折疊器的那一半在 `apps/harness/src/stream-retry.test.ts`。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createStreamRetryMiddleware,
  noteStreamFailure,
  streamFailureReporter,
  streamRetryDelayMs,
} from './stream-retry.js';
import type { StreamRetryOptions } from './stream-retry.js';
import { TURN_CANCEL_CONFIG_KEY } from './turn-cancel.js';

type Handler = (request: unknown) => Promise<unknown>;

/** 把 middleware 的 `wrapModelCall` 當函式叫。`signal` 是這一輪的中止訊號（有的話）。 */
function callWith(
  options: StreamRetryOptions,
  handler: Handler,
  signal?: AbortSignal,
): Promise<unknown> {
  const middleware = createStreamRetryMiddleware(options) as unknown as {
    wrapModelCall: (request: unknown, handler: Handler) => Promise<unknown>;
  };
  const request = {
    runtime: { configurable: signal === undefined ? {} : { [TURN_CANCEL_CONFIG_KEY]: signal } },
  };
  return middleware.wrapModelCall(request, handler);
}

const RETRYABLE = { code: 'TRANSPORT', retryable: true } as const;

describe('範圍外', () => {
  it('回報是空操作，不拋', () => {
    expect(() => noteStreamFailure(RETRYABLE)).not.toThrow();
    expect(() => streamFailureReporter()(RETRYABLE)).not.toThrow();
  });
});

describe('重打的判斷', () => {
  it('回報過可重打的失敗：重打，成功就回成功那次的結果', async () => {
    let calls = 0;
    const result = await callWith({ maxRetries: 2, baseDelayMs: 1 }, async () => {
      calls += 1;
      if (calls === 1) {
        noteStreamFailure(RETRYABLE);
        throw new Error('斷了');
      }
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('沒有人回報的失敗一律原樣往外拋，不重打（SDK 層已經重試過的、一般的錯誤都在這裡）', async () => {
    let calls = 0;
    const boom = new Error('不是串流中段的事');
    await expect(
      callWith({ maxRetries: 2, baseDelayMs: 1 }, async () => {
        calls += 1;
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(calls).toBe(1);
  });

  it('回報說重打沒用（retryable: false）：不重打', async () => {
    let calls = 0;
    await expect(
      callWith({ maxRetries: 2, baseDelayMs: 1 }, async () => {
        calls += 1;
        noteStreamFailure({ code: '400', retryable: false });
        throw new Error('請求有問題');
      }),
    ).rejects.toThrow('請求有問題');
    expect(calls).toBe(1);
  });

  it('同一次嘗試回報多次以第一次為準：後面連帶的回報不能把「不可重打」改成可重打', async () => {
    let calls = 0;
    await expect(
      callWith({ maxRetries: 2, baseDelayMs: 1 }, async () => {
        calls += 1;
        noteStreamFailure({ code: '400', retryable: false });
        noteStreamFailure(RETRYABLE);
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
    expect(calls).toBe(1);
  });

  it('預算用完：總共打 1 + maxRetries 次，最後一次的錯誤原樣往外拋', async () => {
    let calls = 0;
    await expect(
      callWith({ maxRetries: 2, baseDelayMs: 1 }, async () => {
        calls += 1;
        noteStreamFailure(RETRYABLE);
        throw new Error(`第 ${calls} 次`);
      }),
    ).rejects.toThrow('第 3 次');
    expect(calls).toBe(3);
  });

  it('每一次嘗試各有各的範圍：上一次的回報不會讓這一次的一般錯誤被重打', async () => {
    let calls = 0;
    await expect(
      callWith({ maxRetries: 2, baseDelayMs: 1 }, async () => {
        calls += 1;
        if (calls === 1) {
          noteStreamFailure(RETRYABLE);
          throw new Error('斷了');
        }
        throw new Error('第二次是別的事');
      }),
    ).rejects.toThrow('第二次是別的事');
    expect(calls).toBe(2);
  });

  it('上一次嘗試的回報函式晚到：算在它自己那一次，不會算到這一次頭上', async () => {
    let calls = 0;
    let stale: ((failure: { code: string; retryable: boolean }) => void) | undefined;
    await expect(
      callWith({ maxRetries: 3, baseDelayMs: 1 }, async () => {
        calls += 1;
        if (calls === 1) {
          stale = streamFailureReporter();
          stale(RETRYABLE);
          throw new Error('斷了');
        }
        // 第一次那條串流的讀端晚到，才又回報了一次——第二次本身沒有任何失敗要回報。
        stale?.(RETRYABLE);
        throw new Error('第二次是別的事');
      }),
    ).rejects.toThrow('第二次是別的事');
    expect(calls).toBe(2);
  });

  it('回報函式綁在取得它的那一刻：之後從別的非同步脈絡回報，照樣算在那一次嘗試上', async () => {
    let calls = 0;
    const result = await callWith({ maxRetries: 1, baseDelayMs: 1 }, async () => {
      calls += 1;
      const report = streamFailureReporter();
      if (calls === 1) {
        // 模擬 ReadableStream 的 pull：回報發生在一個與 handler 無關的計時器裡。
        await new Promise<void>((resolve) =>
          setTimeout(() => {
            report(RETRYABLE);
            resolve();
          }, 5),
        );
        throw new Error('斷了');
      }
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });
});

describe('退避與中止', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('退避是 base、2×base、4×base……', async () => {
    const stamps: number[] = [];
    const run = callWith({ maxRetries: 3, baseDelayMs: 100, jitterRatio: 0 }, async () => {
      stamps.push(Date.now());
      noteStreamFailure(RETRYABLE);
      throw new Error('斷了');
    });
    const settled = run.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(100 + 200 + 400);
    await settled;
    expect(stamps.map((stamp, index) => (index === 0 ? 0 : stamp - stamps[index - 1]!))).toEqual([
      0, 100, 200, 400,
    ]);
  });

  it('等退避的時候按了停止：立刻收，原本的錯誤照樣往外拋，不再打', async () => {
    const controller = new AbortController();
    let calls = 0;
    const boom = new Error('斷了');
    const run = callWith(
      { maxRetries: 3, baseDelayMs: 10_000 },
      async () => {
        calls += 1;
        noteStreamFailure(RETRYABLE);
        throw boom;
      },
      controller.signal,
    );
    const assertion = expect(run).rejects.toBe(boom);
    await vi.advanceTimersByTimeAsync(50);
    controller.abort();
    await assertion;
    expect(calls).toBe(1);
  });

  it('這一輪已經被中止：失敗之後根本不排重打', async () => {
    const controller = new AbortController();
    let calls = 0;
    await expect(
      callWith(
        { maxRetries: 3, baseDelayMs: 1 },
        async () => {
          calls += 1;
          noteStreamFailure(RETRYABLE);
          controller.abort();
          throw new Error('被切斷');
        },
        controller.signal,
      ),
    ).rejects.toThrow('被切斷');
    expect(calls).toBe(1);
  });
});

describe('退避的形狀（照 dsh 的 retry-policy.ts:14-17）', () => {
  const at = (random: number) => () => random;

  it('倍增，單次封頂在 maxDelayMs（預設 10 秒）', () => {
    const options = { maxRetries: 9, baseDelayMs: 1_000, jitterRatio: 0 };
    expect([0, 1, 2, 3, 4, 5].map((n) => streamRetryDelayMs(options, n))).toEqual([
      1_000, 2_000, 4_000, 8_000, 10_000, 10_000,
    ]);
    expect(streamRetryDelayMs({ ...options, maxDelayMs: 3_000 }, 3)).toBe(3_000);
  });

  it('抖動對稱：亂數 0 → 乘 1 - ratio，亂數 0.5 → 不變，亂數趨近 1 → 乘 1 + ratio；預設抖動 0.1', () => {
    const base = { maxRetries: 1, baseDelayMs: 1_000, jitterRatio: 0.2 };
    expect(streamRetryDelayMs({ ...base, random: at(0) }, 0)).toBe(800);
    expect(streamRetryDelayMs({ ...base, random: at(0.5) }, 0)).toBe(1_000);
    expect(streamRetryDelayMs({ ...base, random: at(0.999999) }, 0)).toBe(1_200);
    const { jitterRatio: _omitted, ...withDefault } = base;
    expect(streamRetryDelayMs({ ...withDefault, random: at(0) }, 0)).toBe(900);
  });

  it('抖動是套在封頂之後：封頂的那幾次一樣有抖動，不會超過 maxDelayMs × (1 + ratio)', () => {
    const options = { maxRetries: 9, baseDelayMs: 1_000, maxDelayMs: 2_000, jitterRatio: 0.1 };
    expect(streamRetryDelayMs({ ...options, random: at(0.999999) }, 6)).toBe(2_200);
  });
});
