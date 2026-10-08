/**
 * 連線監督者的政策（[#1099](https://github.com/DemianLi/nexus-agent/issues/1099)）：退避、預算、放棄、重置、關閉，
 * 用假計時器與可控時鐘逐步走，不起任何子行程。真的殺子行程恢復的那一半在 [`reconnect.test.ts`](./reconnect.test.ts)。
 *
 * 判準照 dsh 的 `connection.ts`（`5badb150`）：500 ms 起每次連續失敗加倍、上限 30000 ms；同一次中斷最多 10 次；
 * 連上之後撐過 `maxDelayMs` 才掉線，失敗次數歸零。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reconnectSchema, Supervisor } from './supervisor.js';
import type { ReconnectPolicy, SupervisorHooks } from './supervisor.js';

interface Gen {
  readonly id: number;
  /** 被 watch 掛上的「這一代斷了」通報。 */
  down?: () => void;
}

/** 一組可控的假連線：`failures` 是接下來要失敗幾次，`clock` 是可控時鐘。 */
function harness(policy: Partial<ReconnectPolicy> = {}) {
  let clock = 0;
  let next = 1;
  const state = {
    failures: 0,
    connects: 0,
    running: 0,
    maxRunning: 0,
    gate: undefined as Promise<void> | undefined,
    closed: [] as number[],
    reports: [] as string[],
  };
  const hooks: SupervisorHooks<Gen> = {
    label: 'mcp-client(t)',
    policy: reconnectSchema.parse(policy),
    now: () => clock,
    async connect() {
      state.connects += 1;
      state.running += 1;
      state.maxRunning = Math.max(state.maxRunning, state.running);
      try {
        if (state.gate !== undefined) await state.gate;
        if (state.failures > 0) {
          state.failures -= 1;
          throw new Error('still down');
        }
        const id = next;
        next += 1;
        return { id };
      } finally {
        state.running -= 1;
      }
    },
    close(generation) {
      state.closed.push(generation.id);
      return Promise.resolve();
    },
    watch(generation, onDown) {
      generation.down = onDown;
    },
    report: (message) => state.reports.push(message),
  };
  const first: Gen = { id: 0 };
  const supervisor = new Supervisor(hooks, first);
  return {
    state,
    first,
    supervisor,
    setClock: (ms: number) => {
      clock = ms;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('政策的形狀', () => {
  it('預設值照 dsh：500、30000、10、啟用', () => {
    expect(reconnectSchema.parse({})).toEqual({
      enabled: true,
      initialDelayMs: 500,
      maxDelayMs: 30_000,
      maxAttempts: 10,
    });
  });

  it('不收未知欄位、初始間隔不能大於上限、次數至少 1', () => {
    expect(() => reconnectSchema.parse({ nope: 1 })).toThrow();
    expect(() => reconnectSchema.parse({ initialDelayMs: 100, maxDelayMs: 50 })).toThrow(
      'initialDelayMs',
    );
    expect(() => reconnectSchema.parse({ maxAttempts: 0 })).toThrow();
  });
});

describe('退避', () => {
  it('500 起每次連續失敗加倍，到 30000 封頂；精準到毫秒', async () => {
    const h = harness();
    h.state.failures = 100;
    h.supervisor.down(h.first);
    expect(h.supervisor.current()).toBeUndefined();
    const delays = [500, 1000, 2000, 4000, 8000, 16000, 30_000, 30_000];
    for (const [index, delay] of delays.entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(h.state.connects).toBe(index);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.state.connects).toBe(index + 1);
    }
  });

  it('進度寫進日誌：掉線、第 n 次、連回來', async () => {
    const h = harness();
    h.state.failures = 1;
    h.supervisor.down(h.first);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.state.reports).toEqual([
      'mcp-client(t): connection lost; reconnecting in 500ms (attempt 1/10)',
      'mcp-client(t): connection attempt failed: Error: still down',
      'mcp-client(t): connection failed; retrying in 1000ms (attempt 2/10)',
      'mcp-client(t): reconnected (attempt 2/10)',
    ]);
    expect(h.supervisor.current()?.id).toBe(1);
  });

  it('斷線期間沒有目前這一代（呼叫端據此讓工具呼叫失敗）；連回來之後換成新的一代', async () => {
    const h = harness();
    h.supervisor.down(h.first);
    expect(h.supervisor.current()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(500);
    expect(h.supervisor.current()?.id).toBe(1);
    expect(h.state.closed).toEqual([0]);
  });
});

describe('預算', () => {
  it('連續失敗超過 maxAttempts 就放棄，不再排計時器', async () => {
    const h = harness({ maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 1000 });
    h.state.failures = 100;
    h.supervisor.down(h.first);
    await vi.advanceTimersByTimeAsync(10 + 20 + 40);
    expect(h.state.connects).toBe(3);
    expect(h.supervisor.gaveUp).toBe(true);
    expect(h.state.reports.at(-1)).toContain(
      'giving up after 3 consecutive failed reconnect attempts',
    );
    await vi.advanceTimersByTimeAsync(100_000);
    expect(h.state.connects).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.supervisor.current()).toBeUndefined();
  });

  it('連上之後撐過 maxDelayMs 才掉線：失敗次數歸零；差 1 毫秒就沒歸零', async () => {
    for (const [stable, expectedDelay] of [
      [30_000, 500],
      [29_999, 8000],
    ] as const) {
      const h = harness();
      h.setClock(0);
      // 先失敗三次再連回來：此時累計 4 次（三次失敗加上掉線那一次），沒歸零的下一次是第 5 次，8000 ms。
      h.state.failures = 3;
      h.supervisor.down(h.first);
      await vi.advanceTimersByTimeAsync(500 + 1000 + 2000 + 4000);
      expect(h.supervisor.current()?.id).toBe(1);
      const reconnected = h.supervisor.current() as Gen;
      // 連上的時刻是 0（時鐘沒動），穩定了 `stable` 毫秒之後掉線。
      h.setClock(stable);
      h.state.reports.length = 0;
      h.supervisor.down(reconnected);
      expect(h.state.reports[0]).toContain(`in ${String(expectedDelay)}ms`);
    }
  });
});

describe('一次只有一個嘗試', () => {
  it('進行中的嘗試還沒結束，再通報同一代或舊一代都不會多開一個', async () => {
    const h = harness();
    let release!: () => void;
    h.state.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.supervisor.down(h.first);
    await vi.advanceTimersByTimeAsync(500);
    expect(h.state.running).toBe(1);
    h.supervisor.down(h.first); // 舊的一代：冪等，什麼都不排
    h.first.down?.();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.state.connects).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.maxRunning).toBe(1);
    expect(h.supervisor.current()?.id).toBe(1);
  });

  it('同一代被通報兩次（close 事件加呼叫失敗）只算一次', () => {
    const h = harness();
    h.supervisor.down(h.first);
    h.supervisor.down(h.first);
    h.first.down?.();
    expect(h.state.reports).toHaveLength(1);
    expect(h.state.closed).toEqual([0]);
  });
});

describe('關閉', () => {
  it('取消還沒跑的重連：之後怎麼等都不再連', async () => {
    const h = harness();
    h.supervisor.down(h.first);
    await vi.advanceTimersByTimeAsync(100);
    await h.supervisor.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(h.state.connects).toBe(0);
    expect(h.supervisor.current()).toBeUndefined();
  });

  it('等進行中的那次跑完，連上的那一代立刻關掉、不採用', async () => {
    const h = harness();
    let release!: () => void;
    h.state.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.supervisor.down(h.first);
    await vi.advanceTimersByTimeAsync(500);
    let done = false;
    const disposing = h.supervisor.dispose().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(done).toBe(false); // 還在等那次嘗試
    release();
    await disposing;
    expect(done).toBe(true);
    expect(h.state.closed).toContain(1);
    expect(h.supervisor.current()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(100_000);
    expect(h.state.connects).toBe(1);
  });

  it('進行中的嘗試失敗了，關閉之後不再排下一次', async () => {
    const h = harness();
    let release!: () => void;
    h.state.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.state.failures = 5;
    h.supervisor.down(h.first);
    await vi.advanceTimersByTimeAsync(500);
    const disposing = h.supervisor.dispose();
    release();
    await disposing;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(h.state.connects).toBe(1);
  });

  it('關閉會關掉目前這一代', async () => {
    const h = harness();
    await h.supervisor.dispose();
    expect(h.state.closed).toEqual([0]);
  });
});

describe('reconnect.enabled: false', () => {
  it('掉線之後不排任何重連，直接標成放棄並講一句', async () => {
    const h = harness({ enabled: false });
    h.supervisor.down(h.first);
    expect(h.supervisor.gaveUp).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(h.state.connects).toBe(0);
    expect(h.state.reports[0]).toContain('reconnect is disabled');
  });
});
