/**
 * 一對裡的葉子（[#2769](https://github.com/DemianLi/nexus-agent/issues/2769)）：假的橋連線、假的控制面、假的計時器，
 * 量「連上登記什麼、`attach` 怎麼綁、橋斷了什麼時候結束」。接真的組合行程在 `per-thread.integration.test.ts`。
 */

import { PairConnectError } from '@nexus/host-bridge';
import type { Json, PairConnectOptions, PairDisconnect } from '@nexus/host-bridge';
import { describe, expect, it } from 'vitest';

import type { BindOutcome } from './conversation-control.js';
import { BRIDGE_LOST_EXIT_CODE, BRIDGE_UNREACHABLE_EXIT_CODE, startPairLeaf } from './pair-leaf.js';
import type { PairLeafControl } from './pair-leaf.js';

const GRACE_MS = 10_000;
const POLL_MS = 1_000;

interface Rig {
  readonly exits: number[];
  readonly logs: string[];
  readonly bound: string[];
  readonly state: {
    attached: boolean;
    idle: boolean;
    stopped: number;
    bindOutcome: BindOutcome;
    /** 真的 `bind` 在 `handler.open` 結束前 `attached` 是 false：true 時假的 bind 停在那裡。 */
    holdBind: boolean;
  };
  readonly connected: PairConnectOptions[];
  /** 橋斷了。 */
  cut(disconnect?: PairDisconnect): void;
  /** 往前走 `ms` 毫秒的假時間，期間到期的計時器依序跑。 */
  advance(ms: number): Promise<void>;
  /** 呼叫組合行程那一側會叫的 `attach`。 */
  attach(payload: Json): Promise<Json>;
}

async function rig(connectFails?: Error): Promise<Rig> {
  const exits: number[] = [];
  const logs: string[] = [];
  const bound: string[] = [];
  const connected: PairConnectOptions[] = [];
  const state = {
    attached: false,
    idle: false,
    stopped: 0,
    bindOutcome: { ok: true } as BindOutcome,
    holdBind: false,
  };
  const control: PairLeafControl = {
    bind: async (threadId) => {
      bound.push(threadId);
      if (state.holdBind) await new Promise<never>(() => undefined);
      if (state.bindOutcome.ok) state.attached = true;
      return state.bindOutcome;
    },
    get attached() {
      return state.attached;
    },
    isIdle: () => state.idle,
    stopAdmission: () => {
      state.stopped += 1;
    },
  };
  let resolveClosed: (value: PairDisconnect) => void = () => undefined;
  const closed = new Promise<PairDisconnect>((resolve) => (resolveClosed = resolve));
  let now = 0;
  const timers: { at: number; callback: () => void }[] = [];
  await startPairLeaf({
    socketPath: '/run/p.sock',
    control,
    log: (line) => logs.push(line),
    exit: (code) => {
      exits.push(code);
    },
    connect: async (options) => {
      connected.push(options);
      if (connectFails !== undefined) throw connectFails;
      return { closed };
    },
    graceMs: GRACE_MS,
    pollMs: POLL_MS,
    timers: {
      setTimeout: (callback, ms) => {
        const timer = { at: now + ms, callback };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (handle) => {
        const index = timers.indexOf(handle as (typeof timers)[number]);
        if (index !== -1) timers.splice(index, 1);
      },
    },
  });
  return {
    exits,
    logs,
    bound,
    state,
    connected,
    cut: (disconnect = { kind: 'closed', detail: '組合行程關了' }) => resolveClosed(disconnect),
    advance: async (ms) => {
      const until = now + ms;
      for (;;) {
        await Promise.resolve();
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (next === undefined || next.at > until) break;
        timers.shift();
        now = next.at;
        next.callback();
      }
      now = until;
      await Promise.resolve();
    },
    attach: async (payload) => {
      const method = connected[0]?.methods?.attach;
      if (method === undefined) throw new Error('沒登記 attach');
      return method(payload, {} as never);
    },
  };
}

describe('沒給 --pair-socket', () => {
  it('不呼叫 connect、不碰控制面、不結束', async () => {
    let connects = 0;
    const touched: string[] = [];
    const exits: number[] = [];
    await startPairLeaf({
      socketPath: undefined,
      control: {
        bind: async () => {
          touched.push('bind');
          return { ok: true };
        },
        get attached() {
          touched.push('attached');
          return false;
        },
        isIdle: () => {
          touched.push('isIdle');
          return false;
        },
        stopAdmission: () => {
          touched.push('stopAdmission');
        },
      },
      log: () => touched.push('log'),
      exit: (code) => {
        exits.push(code);
      },
      connect: async () => {
        connects += 1;
        return { closed: new Promise<PairDisconnect>(() => undefined) };
      },
    });
    expect(connects).toBe(0);
    expect(touched).toEqual([]);
    expect(exits).toEqual([]);
  });
});

describe('連線與登記', () => {
  it('登記是空的 tools、hooks，只做 attach 這一個 method', async () => {
    const r = await rig();
    expect(r.connected).toHaveLength(1);
    expect(r.connected[0]?.socketPath).toBe('/run/p.sock');
    expect(r.connected[0]?.register).toEqual({ tools: [], hooks: [] });
    expect(Object.keys(r.connected[0]?.methods ?? {})).toEqual(['attach']);
  });

  it('連不上橋：記一行、以連不上的結束碼結束，不碰控制面', async () => {
    const r = await rig(new Error('逾時'));
    expect(r.exits).toEqual([BRIDGE_UNREACHABLE_EXIT_CODE]);
    expect(r.logs).toHaveLength(1);
    expect(r.logs[0]).toContain('逾時');
    expect(r.bound).toEqual([]);
  });

  it('PairConnectError 也走同一條', async () => {
    const failure = new PairConnectError({
      kind: 'absent',
      attempts: 1,
      connects: 0,
      retryLater: 0,
      closedBeforeFrame: 0,
      unanswered: 0,
      cutShort: 0,
      elapsedMs: 5,
    } as ConstructorParameters<typeof PairConnectError>[0]);
    const r = await rig(failure);
    expect(r.exits).toEqual([BRIDGE_UNREACHABLE_EXIT_CODE]);
  });
});

describe('attach', () => {
  it('綁完才回 result，帶 threadId', async () => {
    const r = await rig();
    await expect(r.attach({ threadId: 't1' })).resolves.toEqual({ bound: 't1' });
    expect(r.bound).toEqual(['t1']);
  });

  it('payload 不對就回錯、不綁', async () => {
    const r = await rig();
    for (const payload of [null, 'x', [], {}, { threadId: 1 }, { threadId: '' }] as Json[]) {
      await expect(r.attach(payload)).rejects.toThrow('threadId');
    }
    expect(r.bound).toEqual([]);
  });

  it('已綁別條 thread 被拒就回錯，帶原因', async () => {
    const r = await rig();
    r.state.bindOutcome = { ok: false, reason: '已綁 thread "t1"，不改綁 "t2"' };
    await expect(r.attach({ threadId: 't2' })).rejects.toThrow('已綁 thread "t1"');
  });
});

describe('橋斷了', () => {
  it('還沒 attach：立刻結束，不停准入', async () => {
    const r = await rig();
    r.cut();
    await r.advance(0);
    expect(r.exits).toEqual([BRIDGE_LOST_EXIT_CODE]);
    expect(r.state.stopped).toBe(0);
    expect(r.logs.join('\n')).toContain('還沒 attach 成功');
  });

  it('attach 到一半（open 還在跑）也算還沒成功：立刻結束', async () => {
    const r = await rig();
    r.state.holdBind = true;
    void r.attach({ threadId: 't1' });
    r.cut();
    await r.advance(0);
    expect(r.exits).toEqual([BRIDGE_LOST_EXIT_CODE]);
  });

  it('已綁且閒著：停准入後立刻結束', async () => {
    const r = await rig();
    await r.attach({ threadId: 't1' });
    r.state.idle = true;
    r.cut();
    await r.advance(0);
    expect(r.state.stopped).toBe(1);
    expect(r.exits).toEqual([BRIDGE_LOST_EXIT_CODE]);
  });

  it('已綁、一輪進行中：停准入、不結束，這一輪收完（下一次查到閒）才結束', async () => {
    const r = await rig();
    await r.attach({ threadId: 't1' });
    r.state.idle = false;
    r.cut();
    await r.advance(0);
    expect(r.state.stopped).toBe(1);
    expect(r.exits).toEqual([]);
    await r.advance(POLL_MS * 3);
    expect(r.exits).toEqual([]);
    r.state.idle = true;
    await r.advance(POLL_MS);
    expect(r.exits).toEqual([BRIDGE_LOST_EXIT_CODE]);
    expect(r.state.stopped).toBe(1);
  });

  it('上限到了這一輪還沒收完：強制結束', async () => {
    const r = await rig();
    await r.attach({ threadId: 't1' });
    r.cut();
    await r.advance(GRACE_MS - POLL_MS);
    expect(r.exits).toEqual([]);
    await r.advance(POLL_MS);
    expect(r.exits).toEqual([BRIDGE_LOST_EXIT_CODE]);
    expect(r.logs.join('\n')).toContain('強制結束');
  });

  it('自己關的連線（local）不算橋斷', async () => {
    const r = await rig();
    await r.attach({ threadId: 't1' });
    r.cut({ kind: 'local', detail: '自己關的' });
    await r.advance(GRACE_MS * 2);
    expect(r.exits).toEqual([]);
    expect(r.state.stopped).toBe(0);
  });
});
