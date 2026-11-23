/**
 * 連線監督者的政策（[#1099](https://github.com/DemianLi/nexus-agent/issues/1099)）：退避、預算、放棄、重置、關閉，
 * 用假計時器與可控時鐘逐步走，不起任何子行程。真的殺子行程恢復的那一半在 [`reconnect.test.ts`](./reconnect.test.ts)。
 *
 * 判準照 dsh 的 `connection.ts`（`5badb150`）：500 ms 起每次連續失敗加倍、上限 30000 ms；同一次中斷最多 10 次；
 * 連上之後撐過 `maxDelayMs` 才掉線，失敗次數歸零。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GENERATION_CLOSE_TIMEOUT_MS, reconnectSchema, Supervisor } from './supervisor.js';
import type { ReconnectPolicy, SupervisorHooks } from './supervisor.js';

interface Gen {
  readonly id: number;
  /** 被 watch 掛上的「這一代斷了」通報。 */
  down?: () => void;
  /** 這一代真的關掉了；預設 `close` 一被叫就落定，`holdClosed` 時永不落定。 */
  readonly closed: Promise<void>;
  readonly markClosed: () => void;
}

function gen(id: number): Gen {
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  return { id, closed, markClosed };
}

/**
 * 一組可控的假連線：`failures` 是接下來要失敗幾次，`clock` 是可控時鐘。`start: 'failed'` 是第一次就連不上：監督者建構時
 * 沒有第 0 代（`first` 照樣建，只是沒交出去）。
 */
function harness(
  policy: Partial<ReconnectPolicy> = {},
  start: 'connected' | 'failed' = 'connected',
) {
  let clock = 0;
  let next = 1;
  const state = {
    failures: 0,
    connects: 0,
    running: 0,
    maxRunning: 0,
    gate: undefined as Promise<void> | undefined,
    /** `close` 回來了，但這一代永遠確認不到關掉（stdio 的 SIGKILL 之後不等就回、孫行程還握著 pipe）。 */
    holdClosed: false,
    /** 失敗的嘗試收了幾次；`holdAbandon` 時永遠確認不到關掉。 */
    abandoned: 0,
    holdAbandon: false,
    closed: [] as number[],
    reports: [] as string[],
    errors: [] as string[],
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
        return gen(id);
      } finally {
        state.running -= 1;
      }
    },
    abandon() {
      state.abandoned += 1;
      return state.holdAbandon ? new Promise<void>(() => {}) : Promise.resolve();
    },
    close(generation) {
      state.closed.push(generation.id);
      if (!state.holdClosed) generation.markClosed();
      return Promise.resolve();
    },
    closed: (generation) => generation.closed,
    watch(generation, onDown) {
      generation.down = onDown;
    },
    report: (message) => state.reports.push(message),
    error: (message) => state.errors.push(message),
  };
  const first = gen(0);
  const supervisor = new Supervisor(hooks, start === 'connected' ? first : undefined);
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
      await vi.advanceTimersByTimeAsync(0); // 先確認上一代關掉了，才排重連（#1543）
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

  it('同一代被通報兩次（close 事件加呼叫失敗）只算一次', async () => {
    const h = harness();
    h.supervisor.down(h.first);
    h.supervisor.down(h.first);
    h.first.down?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.reports).toHaveLength(1);
    expect(h.state.closed).toEqual([0]);
  });

  it('判定卡死：記一句、照掉線收掉重連；舊一代的遲來判定不算', async () => {
    const h = harness();
    h.supervisor.stalled(h.first);
    expect(h.state.reports[0]).toContain('server stopped responding');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.closed).toEqual([0]);
    await vi.advanceTimersByTimeAsync(500);
    expect(h.state.connects).toBe(1);

    const reports = h.state.reports.length;
    h.supervisor.stalled(h.first);
    expect(h.state.reports).toHaveLength(reports);
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

describe('關閉的期限（#1543，照 dsh GENERATION_CLOSE_TIMEOUT_MS）', () => {
  it('期限是 5000 ms', () => {
    expect(GENERATION_CLOSE_TIMEOUT_MS).toBe(5000);
  });

  it('重連卡在握手：dispose 到期就回來並記一句，差 1 ms 還在等', async () => {
    const h = harness({ initialDelayMs: 1, maxDelayMs: 1 });
    h.state.gate = new Promise<void>(() => {}); // 永不回 initialize
    h.supervisor.down(h.first);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.state.running).toBe(1);
    let done = false;
    const disposing = h.supervisor.dispose().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(GENERATION_CLOSE_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    expect(h.state.errors).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await disposing;
    expect(h.state.errors).toEqual([
      'mcp-client(t): transport closure could not be confirmed during disposal — server shutdown may be incomplete',
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('目前這一代 close 回來了卻確認不到關掉：dispose 同樣到期就回來並記一句', async () => {
    const h = harness();
    h.state.holdClosed = true;
    const disposing = h.supervisor.dispose();
    await vi.advanceTimersByTimeAsync(GENERATION_CLOSE_TIMEOUT_MS);
    await disposing;
    expect(h.state.closed).toEqual([0]);
    expect(h.state.errors[0]).toContain('transport closure could not be confirmed during disposal');
  });

  it('掉線的那一代確認不到關掉：不排重連、標成放棄、記一句；差 1 ms 還沒決定', async () => {
    const h = harness();
    h.state.holdClosed = true;
    h.supervisor.down(h.first);
    await vi.advanceTimersByTimeAsync(GENERATION_CLOSE_TIMEOUT_MS - 1);
    expect(h.state.connects).toBe(0);
    expect(h.supervisor.gaveUp).toBe(false);
    expect(h.state.errors).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.state.connects).toBe(0);
    expect(h.supervisor.gaveUp).toBe(true);
    expect(h.state.errors).toHaveLength(1);
    expect(h.state.errors[0]).toMatch(
      /^mcp-client\(t\): failed generation could not confirm transport closure — reconnect stopped to avoid overlapping server processes; /u,
    );
    // 先確認再排：確認不到的那一代，不會先冒出一句「reconnecting in」。
    expect(h.state.reports).toEqual([]);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(h.state.connects).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('關掉得慢但在期限內：確認到了才排重連，退避從那一刻起算', async () => {
    const h = harness();
    h.state.holdClosed = true;
    h.supervisor.down(h.first);
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.state.reports).toEqual([]);
    h.first.markClosed();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.reports).toEqual([
      'mcp-client(t): connection lost; reconnecting in 500ms (attempt 1/10)',
    ]);
    await vi.advanceTimersByTimeAsync(499);
    expect(h.state.connects).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.state.connects).toBe(1);
    expect(h.supervisor.gaveUp).toBe(false);
    expect(h.supervisor.current()?.id).toBe(1);
  });

  it('嘗試失敗：當場收掉那一次，每次失敗收一次；用完次數放棄時沒有留著沒收的', async () => {
    const h = harness({ maxAttempts: 2 });
    h.state.failures = 2;
    h.supervisor.down(h.first);
    await vi.advanceTimersByTimeAsync(500);
    expect(h.state.connects).toBe(1);
    expect(h.state.abandoned).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.state.connects).toBe(2);
    expect(h.state.abandoned).toBe(2);
    expect(h.supervisor.gaveUp).toBe(true);
  });

  it('失敗的嘗試確認不到關掉：不排下一次、標成放棄、記一句；差 1 ms 還沒決定', async () => {
    const h = harness();
    h.state.failures = 1;
    h.state.holdAbandon = true;
    h.supervisor.down(h.first);
    await vi.advanceTimersByTimeAsync(500);
    expect(h.state.connects).toBe(1);
    await vi.advanceTimersByTimeAsync(GENERATION_CLOSE_TIMEOUT_MS - 1);
    expect(h.supervisor.gaveUp).toBe(false);
    expect(h.state.errors).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.supervisor.gaveUp).toBe(true);
    expect(h.state.errors).toHaveLength(1);
    expect(h.state.errors[0]).toMatch(/reconnect stopped to avoid overlapping server processes/u);
    expect(h.state.reports.at(-1)).toBe(
      'mcp-client(t): connection attempt failed: Error: still down',
    );
    await vi.advanceTimersByTimeAsync(100_000);
    expect(h.state.connects).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('還在等上一代關掉時 dispose：不重連、不記「reconnect stopped」', async () => {
    const h = harness();
    h.state.holdClosed = true;
    h.supervisor.down(h.first);
    await vi.advanceTimersByTimeAsync(600); // 正等著確認上一代關掉
    const disposing = h.supervisor.dispose();
    await vi.advanceTimersByTimeAsync(GENERATION_CLOSE_TIMEOUT_MS);
    await disposing;
    await vi.advanceTimersByTimeAsync(100_000);
    expect(h.state.connects).toBe(0);
    expect(h.state.errors.filter((m) => m.includes('reconnect stopped'))).toEqual([]);
  });
});

describe('第一次就連不上（建構時沒有第 0 代）', () => {
  it('建構當下就照退避排第 1 次，連上了就是目前這一代，日誌說「retrying」不說「lost」', async () => {
    const h = harness({}, 'failed');
    expect(h.supervisor.current()).toBeUndefined();
    expect(h.state.reports).toEqual([
      'mcp-client(t): connection failed; retrying in 500ms (attempt 1/10)',
    ]);
    await vi.advanceTimersByTimeAsync(499);
    expect(h.state.connects).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.state.connects).toBe(1);
    expect(h.supervisor.current()?.id).toBe(1);
    expect(h.supervisor.gaveUp).toBe(false);
    expect(h.state.reports.at(-1)).toBe('mcp-client(t): reconnected (attempt 1/10)');
  });

  it('一直連不上：同一份預算，第 10 次之後放棄，不再排計時器', async () => {
    const h = harness({}, 'failed');
    h.state.failures = 100;
    await vi.advanceTimersByTimeAsync(10 * 30_000);
    expect(h.state.connects).toBe(10);
    expect(h.supervisor.gaveUp).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('連上之後才掉線：照一般的掉線走，那一代會先關掉再重連', async () => {
    const h = harness({}, 'failed');
    await vi.advanceTimersByTimeAsync(500);
    const adopted = h.supervisor.current();
    expect(adopted?.id).toBe(1);
    adopted?.down?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.closed).toEqual([1]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.supervisor.current()?.id).toBe(2);
  });

  it('還沒連上就 dispose：取消待跑的那一次，之後不再連', async () => {
    const h = harness({}, 'failed');
    await h.supervisor.dispose();
    await vi.advanceTimersByTimeAsync(100_000);
    expect(h.state.connects).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('第 1 次在途時 dispose：等它收斂，連上的那一代關掉、不採用', async () => {
    const h = harness({}, 'failed');
    let open!: () => void;
    h.state.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(h.state.connects).toBe(1);
    const disposing = h.supervisor.dispose();
    open();
    await vi.advanceTimersByTimeAsync(0);
    await disposing;
    expect(h.supervisor.current()).toBeUndefined();
    expect(h.state.closed).toEqual([1]);
    expect(h.state.errors).toEqual([]);
  });

  it('reconnect.enabled: false：不排重連，直接標成放棄', () => {
    const h = harness({ enabled: false }, 'failed');
    expect(h.supervisor.gaveUp).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('reconnect.enabled: false', () => {
  it('掉線之後不排任何重連，直接標成放棄並講一句', async () => {
    const h = harness({ enabled: false });
    h.supervisor.down(h.first);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.supervisor.gaveUp).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(h.state.connects).toBe(0);
    expect(h.state.reports[0]).toContain('reconnect is disabled');
  });
});
