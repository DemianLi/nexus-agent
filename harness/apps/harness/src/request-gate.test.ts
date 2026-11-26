/**
 * 全機的模型請求並行閘（[#1505](https://github.com/DemianLi/nexus-agent/issues/1505)）本體：計數、FIFO、聽中止訊號、排隊逾時。
 * 這一層沒有網路也沒有模型，用假計時器量時間。每條都有一個突變能讓它紅（見 `scripts` 以外的 PR 內文突變表）。
 */

import { DEFAULT_STREAM_RETRYABLE_CODES } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { classifyTurnFailure } from './live-model.js';
import {
  createRequestGate,
  LOCAL_CAPACITY_CODE,
  LocalCapacityError,
  RequestGate,
} from './request-gate.js';

/** 讓已排隊的微任務都跑完。 */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function gateOf(maxConcurrent: number, maxWaitMs = 60_000, warn?: (line: string) => void) {
  return new RequestGate({ maxConcurrent, maxWaitMs, ...(warn !== undefined && { warn }) });
}

describe('RequestGate：計數與交接', () => {
  it('上限 2：前兩個立刻拿到，第三個排隊，前一個還了才拿到', async () => {
    const gate = gateOf(2);
    const a = await gate.acquire();
    const b = await gate.acquire();
    expect(gate.active).toBe(2);
    let third = false;
    const pending = gate.acquire().then((release) => {
      third = true;
      return release;
    });
    await settle();
    expect(third).toBe(false);
    expect(gate.waiting).toBe(1);
    a();
    const c = await pending;
    expect(third).toBe(true);
    // 交接：名額直接換手，沒有「先減再搶」的空窗，在跑的數量一直是 2。
    expect(gate.active).toBe(2);
    expect(gate.waiting).toBe(0);
    b();
    c();
    expect(gate.active).toBe(0);
  });

  it('FIFO：排隊的依序拿到', async () => {
    const gate = gateOf(1);
    const first = await gate.acquire();
    const order: string[] = [];
    const waiters = ['x', 'y', 'z'].map((name) =>
      gate.acquire().then((release) => {
        order.push(name);
        return release;
      }),
    );
    await settle();
    expect(order).toEqual([]);
    first();
    (await waiters[0]!)();
    (await waiters[1]!)();
    (await waiters[2]!)();
    expect(order).toEqual(['x', 'y', 'z']);
    expect(gate.active).toBe(0);
  });

  it('release 冪等：重複還不會多放出名額', async () => {
    const gate = gateOf(1);
    const release = await gate.acquire();
    release();
    release();
    release();
    expect(gate.active).toBe(0);
    // 還了三次之後上限仍然是 1，不是 3。
    const a = await gate.acquire();
    let second = false;
    void gate.acquire().then(() => (second = true));
    await settle();
    expect(second).toBe(false);
    a();
  });
});

describe('RequestGate：中止訊號', () => {
  it('已經中止的訊號：直接拋原因，不佔名額', async () => {
    const gate = gateOf(1);
    const controller = new AbortController();
    controller.abort(new Error('按了停止'));
    await expect(gate.acquire(controller.signal)).rejects.toThrow('按了停止');
    expect(gate.active).toBe(0);
  });

  it('等待中被中止：離開隊伍、拋原因、不佔名額；之後的人照樣拿得到', async () => {
    const gate = gateOf(1);
    const holder = await gate.acquire();
    const controller = new AbortController();
    const waiting = gate.acquire(controller.signal);
    const caught = waiting.catch((error: unknown) => error);
    await settle();
    expect(gate.waiting).toBe(1);
    controller.abort(new Error('按了停止'));
    expect(((await caught) as Error).message).toBe('按了停止');
    expect(gate.waiting).toBe(0);
    // 名額沒漏：holder 還了之後在跑的是 0，不是被離開的那一個吃掉。
    holder();
    expect(gate.active).toBe(0);
    const next = await gate.acquire();
    expect(gate.active).toBe(1);
    next();
  });

  it('中止的人排在前面：名額交給下一個沒中止的', async () => {
    const gate = gateOf(1);
    const holder = await gate.acquire();
    const controller = new AbortController();
    const dropped = gate.acquire(controller.signal).catch(() => 'aborted');
    let granted = false;
    const kept = gate.acquire().then((release) => {
      granted = true;
      return release;
    });
    await settle();
    controller.abort();
    expect(await dropped).toBe('aborted');
    holder();
    const release = await kept;
    expect(granted).toBe(true);
    expect(gate.active).toBe(1);
    release();
    expect(gate.active).toBe(0);
  });
});

describe('RequestGate：排隊逾時', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('等超過 maxWaitMs：拋 LocalCapacityError（碼 LOCAL_CAPACITY），訊息寫上限、在跑、排隊與下一步；寫一行 warn', async () => {
    const warn = vi.fn();
    const gate = gateOf(2, 5_000, warn);
    await gate.acquire();
    await gate.acquire();
    const waiting = gate.acquire();
    const caught = waiting.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_000);
    const error = (await caught) as LocalCapacityError;
    expect(error).toBeInstanceOf(LocalCapacityError);
    expect(error.code).toBe(LOCAL_CAPACITY_CODE);
    expect(error.message).toContain('5000 毫秒');
    expect(error.message).toContain('上限 2');
    expect(error.message).toContain('在跑 2');
    expect(error.message).toContain('排隊 1');
    expect(error.message).toContain('maxConcurrentRequests');
    expect(error.message).toContain('maxWaitMs');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain(error.message);
    // 逾時的人離開了隊伍，不會被之後的釋放吃掉名額。
    expect(gate.waiting).toBe(0);
  });

  it('逾時的人不會在之後被交接到名額', async () => {
    const gate = gateOf(1, 1_000);
    const holder = await gate.acquire();
    const caught = gate.acquire().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await caught).toBeInstanceOf(LocalCapacityError);
    holder();
    expect(gate.active).toBe(0);
  });

  it('拿到名額時計時器清掉：之後過了 maxWaitMs 也不會逾時、不會寫 warn', async () => {
    const warn = vi.fn();
    const gate = gateOf(1, 1_000, warn);
    const holder = await gate.acquire();
    const second = gate.acquire();
    await vi.advanceTimersByTimeAsync(500);
    holder();
    const release = await second;
    // 計時器真的清掉了，不是留著空轉：一個 60 秒的計時器掛在事件循環上，行程要多等它。
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(warn).not.toHaveBeenCalled();
    expect(gate.active).toBe(1);
    release();
  });

  it('中止離開時計時器也清掉', async () => {
    const warn = vi.fn();
    const gate = gateOf(1, 1_000, warn);
    await gate.acquire();
    const controller = new AbortController();
    const caught = gate.acquire(controller.signal).catch((error: unknown) => error);
    controller.abort();
    await caught;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('createRequestGate：由 live-model 那一列的兩格建', () => {
  it('沒設 maxConcurrentRequests 就不建閘（不限，行為同沒有這張卡）', () => {
    expect(createRequestGate({ maxWaitMs: 60_000 })).toBeUndefined();
    expect(createRequestGate({ maxConcurrentRequests: undefined, maxWaitMs: 60_000 })).toBe(
      undefined,
    );
  });

  it('設了就依兩格建，warn 接到給的函式', async () => {
    vi.useFakeTimers();
    try {
      const warn = vi.fn();
      const gate = createRequestGate({ maxConcurrentRequests: 1, maxWaitMs: 100 }, warn)!;
      expect(gate.maxConcurrent).toBe(1);
      await gate.acquire();
      const caught = gate.acquire().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(100);
      expect(await caught).toBeInstanceOf(LocalCapacityError);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('失敗分類：排隊逾時是本機碼，而且不在預設可重試集裡', () => {
  it('classifyTurnFailure 認得 LocalCapacityError，包了幾層 cause 也認；沒有 status', () => {
    const inner = new LocalCapacityError('排隊逾時');
    const wrapped = new Error('外層', { cause: new Error('中層', { cause: inner }) });
    expect(classifyTurnFailure(inner)).toEqual({ message: '排隊逾時', code: LOCAL_CAPACITY_CODE });
    expect(classifyTurnFailure(wrapped).code).toBe(LOCAL_CAPACITY_CODE);
    expect(classifyTurnFailure(wrapped)).not.toHaveProperty('status');
  });

  it('LOCAL_CAPACITY 不在 DEFAULT_STREAM_RETRYABLE_CODES：排隊逾時不會再排一次隊', () => {
    expect(DEFAULT_STREAM_RETRYABLE_CODES).not.toContain(LOCAL_CAPACITY_CODE);
  });
});
