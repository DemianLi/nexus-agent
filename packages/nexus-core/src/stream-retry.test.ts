/**
 * 串流中段重打的規則（[#520](https://github.com/DemianLi/nexus-agent/issues/520)）：什麼時候重打、重打幾次、等多久、
 * 中止時怎麼收。真的打假端點、走完 pump 與折疊器的那一半在 `apps/harness/src/stream-retry.test.ts`。
 */

import { AIMessage } from '@langchain/core/messages';
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureModelCall } from './model-call-scope.js';
import { createModelCallRecorder } from './model-calls.js';
import { SessionLog } from './session-log.js';
import {
  createStreamRetryMiddleware,
  noteStreamFailure,
  streamFailureReporter,
  STREAM_RETRY_SIGNAL,
  streamRetryDelayMs,
  streamRetrySignalOf,
} from './stream-retry.js';
import type { StreamRetryOptions } from './stream-retry.js';
import type { SessionLookup } from './registry.js';
import { TURN_CANCEL_CONFIG_KEY } from './turn-cancel.js';

type Handler = (request: unknown) => Promise<unknown>;

/** 沒接日誌：只測重打的判斷，不寫事件。 */
const NO_SESSIONS = { forCall: (): SessionLookup => ({ kind: 'not-attached' }) };

/** 把 middleware 的 `wrapModelCall` 當函式叫。`signal` 是這一輪的中止訊號（有的話）。 */
function callWith(
  options: StreamRetryOptions,
  handler: Handler,
  signal?: AbortSignal,
): Promise<unknown> {
  const middleware = createStreamRetryMiddleware(options, NO_SESSIONS) as unknown as {
    wrapModelCall: (request: unknown, handler: Handler) => Promise<unknown>;
  };
  const request = {
    runtime: { configurable: signal === undefined ? {} : { [TURN_CANCEL_CONFIG_KEY]: signal } },
  };
  return middleware.wrapModelCall(request, handler);
}

const RETRYABLE = { code: 'TRANSPORT' } as const;

describe('範圍外', () => {
  it('回報是空操作，不拋', () => {
    expect(() => noteStreamFailure(RETRYABLE)).not.toThrow();
    expect(() => streamFailureReporter()(RETRYABLE)).not.toThrow();
  });
});

describe('重打的判斷', () => {
  it('回報過可重打的失敗：重打，成功就回成功那次的結果', async () => {
    let calls = 0;
    const result = await callWith({ maxRetries: 2, initialDelayMs: 1 }, async () => {
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
      callWith({ maxRetries: 2, initialDelayMs: 1 }, async () => {
        calls += 1;
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(calls).toBe(1);
  });

  it('回報的碼不在可重試清單裡（HTTP_422 這類）：不重打，原錯誤往外拋（#1437：碼決定重試）', async () => {
    let calls = 0;
    await expect(
      callWith({ maxRetries: 2, initialDelayMs: 1 }, async () => {
        calls += 1;
        noteStreamFailure({ code: 'HTTP_422' });
        throw new Error('請求有問題');
      }),
    ).rejects.toThrow('請求有問題');
    expect(calls).toBe(1);
  });

  it('同一次嘗試回報多次以第一次為準：後面連帶的回報不能把「碼不在清單裡」改成可重打', async () => {
    let calls = 0;
    await expect(
      callWith({ maxRetries: 2, initialDelayMs: 1 }, async () => {
        calls += 1;
        noteStreamFailure({ code: 'HTTP_422' });
        noteStreamFailure(RETRYABLE);
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
    expect(calls).toBe(1);
  });

  it('預算用完：總共打 1 + maxRetries 次，最後一次的錯誤原樣往外拋', async () => {
    let calls = 0;
    await expect(
      callWith({ maxRetries: 2, initialDelayMs: 1 }, async () => {
        calls += 1;
        noteStreamFailure(RETRYABLE);
        throw new Error(`第 ${calls} 次`);
      }),
    ).rejects.toThrow('第 3 次');
    expect(calls).toBe(3);
  });

  it('retryableCodes 是閘門：碼不在清單裡就不重打（原錯誤往外拋）；省略取 dsh 的預設五碼', async () => {
    let calls = 0;
    const failWith = (code: string) => async () => {
      calls += 1;
      noteStreamFailure({ code });
      throw new Error(code);
    };
    await expect(
      callWith(
        { maxRetries: 2, initialDelayMs: 1, retryableCodes: ['SERVER'] },
        failWith('TIMEOUT'),
      ),
    ).rejects.toThrow('TIMEOUT');
    expect(calls).toBe(1);

    calls = 0;
    await expect(
      callWith(
        { maxRetries: 2, initialDelayMs: 1, retryableCodes: ['TIMEOUT'] },
        failWith('TIMEOUT'),
      ),
    ).rejects.toThrow('TIMEOUT');
    expect(calls).toBe(3);

    // 省略：dsh 預設的五個碼都重打，其他的碼（例如 HTTP_404）不重打。
    for (const code of ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']) {
      calls = 0;
      await expect(callWith({ maxRetries: 1, initialDelayMs: 1 }, failWith(code))).rejects.toThrow(
        code,
      );
      expect(calls, code).toBe(2);
    }
    calls = 0;
    await expect(
      callWith({ maxRetries: 1, initialDelayMs: 1 }, failWith('HTTP_404')),
    ).rejects.toThrow('HTTP_404');
    expect(calls).toBe(1);
  });

  it('每一次嘗試各有各的範圍：上一次的回報不會讓這一次的一般錯誤被重打', async () => {
    let calls = 0;
    await expect(
      callWith({ maxRetries: 2, initialDelayMs: 1 }, async () => {
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
    let stale: ((failure: { code: string }) => void) | undefined;
    await expect(
      callWith({ maxRetries: 3, initialDelayMs: 1 }, async () => {
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
    const result = await callWith({ maxRetries: 1, initialDelayMs: 1 }, async () => {
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
    const run = callWith({ maxRetries: 3, initialDelayMs: 100, jitterRatio: 0 }, async () => {
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
      { maxRetries: 3, initialDelayMs: 10_000 },
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
        { maxRetries: 3, initialDelayMs: 1 },
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
    const options = { maxRetries: 9, initialDelayMs: 1_000, jitterRatio: 0 };
    expect([0, 1, 2, 3, 4, 5].map((n) => streamRetryDelayMs(options, n))).toEqual([
      1_000, 2_000, 4_000, 8_000, 10_000, 10_000,
    ]);
    expect(streamRetryDelayMs({ ...options, maxDelayMs: 3_000 }, 3)).toBe(3_000);
  });

  it('抖動對稱：亂數 0 → 乘 1 - ratio，亂數 0.5 → 不變，亂數趨近 1 → 乘 1 + ratio；預設抖動 0.1', () => {
    const base = { maxRetries: 1, initialDelayMs: 1_000, jitterRatio: 0.2 };
    expect(streamRetryDelayMs({ ...base, random: at(0) }, 0)).toBe(800);
    expect(streamRetryDelayMs({ ...base, random: at(0.5) }, 0)).toBe(1_000);
    expect(streamRetryDelayMs({ ...base, random: at(0.999999) }, 0)).toBe(1_200);
    const { jitterRatio: _omitted, ...withDefault } = base;
    expect(streamRetryDelayMs({ ...withDefault, random: at(0) }, 0)).toBe(900);
  });

  it('抖動之後再夾到 maxDelayMs（照 dsh 的 localDelay）：封頂的那幾次抖動往上也不會超過上限，往下照樣有', () => {
    const options = { maxRetries: 9, initialDelayMs: 1_000, maxDelayMs: 2_000, jitterRatio: 0.1 };
    expect(streamRetryDelayMs({ ...options, random: at(0.999999) }, 6)).toBe(2_000);
    expect(streamRetryDelayMs({ ...options, random: at(0) }, 6)).toBe(1_800);
  });
});

describe('retry-after（照 dsh 的 recover）', () => {
  const OPTIONS: StreamRetryOptions = {
    maxRetries: 3,
    initialDelayMs: 1_000,
    maxDelayMs: 5_000,
    jitterRatio: 0,
  };

  afterEach(() => vi.useRealTimers());

  it('不超過 maxDelayMs：照供應商給的等，不加抖動、不用本機退避', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const run = callWith({ ...OPTIONS, jitterRatio: 0.5 }, async () => {
      calls += 1;
      if (calls === 1) {
        noteStreamFailure({ ...RETRYABLE, retryAfterMs: 2_500 });
        throw new Error('限流');
      }
      return '好';
    });
    await vi.advanceTimersByTimeAsync(2_499);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(run).resolves.toBe('好');
    expect(calls).toBe(2);
  });

  it('超過 maxDelayMs：直接放棄，原錯誤往外拋，不再打', async () => {
    let calls = 0;
    await expect(
      callWith(OPTIONS, async () => {
        calls += 1;
        noteStreamFailure({ ...RETRYABLE, retryAfterMs: 5_001 });
        throw new Error('限流太久');
      }),
    ).rejects.toThrow('限流太久');
    expect(calls).toBe(1);
  });

  it('剛好等於 maxDelayMs 還等；0 或非有限的當沒給，走本機退避', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const run = callWith({ ...OPTIONS, initialDelayMs: 1_000 }, async () => {
      calls += 1;
      if (calls === 1) {
        noteStreamFailure({ ...RETRYABLE, retryAfterMs: 5_000 });
        throw new Error('一');
      }
      if (calls === 2) {
        noteStreamFailure({ ...RETRYABLE, retryAfterMs: 0 });
        throw new Error('二');
      }
      return '好';
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2);
    // 第二次失敗是第 2 次重打：本機退避 initial × 2^1 = 2 秒（retryAfterMs 0 當沒給）。
    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(run).resolves.toBe('好');
    expect(calls).toBe(3);
  });
});

describe('首事件前後共用同一份預算（#1427）', () => {
  it('同一個迴圈不分失敗是第一則事件之前或之後：總共打 1 + maxRetries 次，用盡後原錯誤往外拋', async () => {
    let calls = 0;
    await expect(
      callWith({ maxRetries: 3, initialDelayMs: 1, jitterRatio: 0 }, async () => {
        calls += 1;
        // 前兩次當「第一則事件之前」的失敗（HTTP 層回報），之後當「中段」（串流層回報）：都是同一個回報口。
        noteStreamFailure(calls <= 2 ? { code: 'RATE_LIMIT', status: 429 } : { code: 'TRANSPORT' });
        throw new Error(`第 ${String(calls)} 次`);
      }),
    ).rejects.toThrow('第 4 次');
    expect(calls).toBe(4);
  });
});

describe('日誌與通知（失敗當下）', () => {
  /** 外層重試、內層起訖紀錄器，與產品組裝同序；`config.writer` 收到的通知收進 `signals`。 */
  function rig(options: StreamRetryOptions, signal?: AbortSignal) {
    const log = new SessionLog('stream-retry');
    const sessions = {
      forCall: (): SessionLookup => ({
        kind: 'ok',
        address: { kind: 'root' } as never,
        log,
      }),
    };
    const retry = createStreamRetryMiddleware(options, sessions) as unknown as {
      wrapModelCall: (request: unknown, handler: Handler) => Promise<unknown>;
    };
    const recorder = createModelCallRecorder(sessions) as unknown as {
      wrapModelCall: (request: unknown, handler: Handler) => Promise<unknown>;
    };
    const signals: unknown[] = [];
    const request = {
      runtime: { configurable: signal === undefined ? {} : { [TURN_CANCEL_CONFIG_KEY]: signal } },
    };
    const run = (handler: Handler): Promise<unknown> =>
      AsyncLocalStorageProviderSingleton.runWithConfig(
        { writer: (chunk: unknown) => signals.push(chunk) } as never,
        () => retry.wrapModelCall(request, (req) => recorder.wrapModelCall(req, handler)),
      );
    return { log, signals, run };
  }
  const typesOf = (log: SessionLog) => log.events.map((event) => event.type);

  it('重打：失敗那對收尾 → llm/retry（指回失敗那次、帶 delayMs）→ llm/retry-started → 下一對起訖；通知與日誌一一對上', async () => {
    const { log, signals, run } = rig({
      maxRetries: 2,
      initialDelayMs: 5,
      jitterRatio: 0,
    });
    let calls = 0;
    const result = await run(async () => {
      calls += 1;
      if (calls === 1) {
        noteStreamFailure({ code: 'TRANSPORT' });
        throw new Error('連線斷了');
      }
      return new AIMessage('好了');
    });
    expect(result).toBeInstanceOf(AIMessage);
    expect(typesOf(log)).toEqual([
      'model/start',
      'model/end',
      'llm/retry',
      'llm/retry-started',
      'model/start',
      'assistant/message',
      'model/end',
    ]);
    const [start, end, retry, started] = log.events as unknown as {
      seq: number;
      data: Record<string, unknown>;
    }[];
    expect(end!.data).toMatchObject({ modelCall: start!.seq, outcome: 'error' });
    expect(retry!.data).toMatchObject({
      retry: 1,
      maxRetries: 2,
      delayMs: 5,
      modelCall: start!.seq,
      failure: { code: 'TRANSPORT', message: '連線斷了' },
    });
    expect(started!.data).toMatchObject({
      retryId: retry!.data['retryId'],
      retry: 1,
      modelCall: start!.seq,
    });
    expect(started!.data['waitedMs']).toBeGreaterThanOrEqual(0);
    // 通知：排定在前（帶 modelCall、delayMs、碼），重打在後；經 `streamRetrySignalOf` 認得回來。
    expect(signals.map((each) => streamRetrySignalOf(each))).toEqual([
      {
        kind: STREAM_RETRY_SIGNAL,
        phase: 'scheduled',
        retryId: retry!.data['retryId'],
        retry: 1,
        maxRetries: 2,
        delayMs: 5,
        code: 'TRANSPORT',
        modelCall: start!.seq,
      },
      {
        kind: STREAM_RETRY_SIGNAL,
        phase: 'started',
        retryId: retry!.data['retryId'],
        retry: 1,
        modelCall: start!.seq,
      },
    ]);
  });

  it('外面還有摘要器那樣的 captureModelCall：照樣問得到識別，而且是最後（成功）那一次——格子巢狀，不被重試放的那一格擋住', async () => {
    const { log, run } = rig({ maxRetries: 2, initialDelayMs: 1, jitterRatio: 0 });
    let calls = 0;
    const { call } = await captureModelCall(() =>
      run(async () => {
        calls += 1;
        if (calls === 1) {
          noteStreamFailure({ code: 'TRANSPORT' });
          throw new Error('斷了');
        }
        return new AIMessage('好了');
      }),
    );
    const starts = log.events.filter((event) => event.type === 'model/start');
    expect(starts).toHaveLength(2);
    expect(call.of(log)).toBe(starts[1]!.seq);
  });

  it('一次呼叫的所有重試共用一個 retryId，retry 逐次加一、各指回自己那一次失敗', async () => {
    const { log, run } = rig({ maxRetries: 3, initialDelayMs: 1, jitterRatio: 0 });
    let calls = 0;
    await run(async () => {
      calls += 1;
      if (calls <= 2) {
        noteStreamFailure({ code: 'TIMEOUT' });
        throw new Error('停住了');
      }
      return new AIMessage('好了');
    });
    const retries = log.events.filter((event) => event.type === 'llm/retry') as unknown as {
      data: { retryId: string; retry: number; modelCall: number };
    }[];
    const starts = log.events.filter((event) => event.type === 'model/start');
    expect(retries.map((each) => each.data.retry)).toEqual([1, 2]);
    expect(retries[1]!.data.retryId).toBe(retries[0]!.data.retryId);
    expect(retries.map((each) => each.data.modelCall)).toEqual([starts[0]!.seq, starts[1]!.seq]);
  });

  it('預算用完的最後一次失敗：不排、不寫 llm/retry，也不送通知', async () => {
    const { log, signals, run } = rig({ maxRetries: 1, initialDelayMs: 1 });
    await expect(
      run(async () => {
        noteStreamFailure({ code: 'TRANSPORT' });
        throw new Error('一直斷');
      }),
    ).rejects.toThrow('一直斷');
    expect(typesOf(log).filter((type) => type === 'llm/retry')).toHaveLength(1);
    expect(signals).toHaveLength(2); // 第一次失敗排定＋重打；第二次失敗什麼都沒有。
  });

  it('沒人回報的失敗：不寫 llm/retry、不送通知', async () => {
    const { log, signals, run } = rig({ maxRetries: 2, initialDelayMs: 1 });
    await expect(
      run(async () => {
        throw new Error('一般的錯');
      }),
    ).rejects.toThrow('一般的錯');
    expect(typesOf(log)).toEqual(['model/start', 'model/end']);
    expect(signals).toEqual([]);
  });

  it('等退避時按停止：llm/retry 與排定的通知已經出去，但不寫 llm/retry-started、也不送重打的通知', async () => {
    const controller = new AbortController();
    const { log, signals, run } = rig(
      { maxRetries: 2, initialDelayMs: 10_000, jitterRatio: 0 },
      controller.signal,
    );
    const pending = run(async () => {
      noteStreamFailure({ code: 'TRANSPORT' });
      throw new Error('斷了');
    });
    // 讓第一次嘗試失敗、進到退避，再停。
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await expect(pending).rejects.toThrow('斷了');
    expect(typesOf(log)).toEqual(['model/start', 'model/end', 'llm/retry']);
    expect(signals.map((each) => (each as { phase: string }).phase)).toEqual(['scheduled']);
  });

  it('範圍外（沒有圖脈絡、沒有 writer）也不拋：日誌照寫，通知是空操作', async () => {
    const log = new SessionLog('stream-retry');
    const sessions = {
      forCall: (): SessionLookup => ({ kind: 'ok', address: { kind: 'root' } as never, log }),
    };
    const retry = createStreamRetryMiddleware(
      { maxRetries: 1, initialDelayMs: 1 },
      sessions,
    ) as unknown as { wrapModelCall: (request: unknown, handler: Handler) => Promise<unknown> };
    let calls = 0;
    await retry.wrapModelCall({ runtime: { configurable: {} } }, async () => {
      calls += 1;
      if (calls === 1) {
        noteStreamFailure({ code: 'TRANSPORT' });
        throw new Error('斷了');
      }
      return 'ok';
    });
    // 沒有起訖紀錄器：`llm/retry` 不帶 modelCall，但還是寫了。
    expect(typesOf(log)).toEqual(['llm/retry', 'llm/retry-started']);
  });
});

describe('通知的辨認', () => {
  it('不是我們的記號、或形狀不對：一律不認（圖裡別的工具用 config.writer 送的東西不能被當成通知）', () => {
    expect(streamRetrySignalOf(undefined)).toBeUndefined();
    expect(streamRetrySignalOf({ kind: 'other' })).toBeUndefined();
    expect(
      streamRetrySignalOf({
        kind: STREAM_RETRY_SIGNAL,
        phase: 'scheduled',
        retryId: 'a',
        retry: 1,
      }),
    ).toBeUndefined();
    expect(
      streamRetrySignalOf({ kind: STREAM_RETRY_SIGNAL, phase: 'weird', retryId: 'a', retry: 1 }),
    ).toBeUndefined();
    expect(
      streamRetrySignalOf({ kind: STREAM_RETRY_SIGNAL, phase: 'started', retryId: '', retry: 1 }),
    ).toBeUndefined();
    expect(
      streamRetrySignalOf({
        kind: STREAM_RETRY_SIGNAL,
        phase: 'started',
        retryId: 'a',
        retry: 1,
        modelCall: 'x',
      }),
    ).toBeUndefined();
  });
});
