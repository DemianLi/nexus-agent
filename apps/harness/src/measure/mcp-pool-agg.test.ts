import { describe, expect, it } from 'vitest';
import { conversationMedian, perTurnCpu, reportMcpPool, roundFlags } from './mcp-pool-agg.js';
import type { Arm, Barrier, Group, Round } from './mcp-pool-agg.js';

const N = 4;

function barrier(k: number, over: Partial<Barrier> = {}): Barrier {
  return {
    k,
    warm: k <= 5,
    cpuMs: 400,
    statMs: 400,
    byRole: { serve: 380, 'mcp-stdio': 20 },
    conversations: [],
    born: 0,
    died: 0,
    readErrors: 0,
    stdioBefore: 2,
    stdioAfter: 2,
    outcomes: Array.from({ length: N }, () => 'completed'),
    llmReq: k === 1 ? 5 * N : 4 * N,
    threadWallMs: [100, 120, 110, 130],
    ...over,
  };
}

function round(n: number, perThreadCpu: (k: number) => number, over: Partial<Round> = {}): Round {
  const single = Array.from({ length: 45 }, (_, i) => barrier(i + 1));
  const perThread = Array.from({ length: 45 }, (_, i) =>
    barrier(i + 1, {
      cpuMs: perThreadCpu(i + 1),
      byRole: { conversation: perThreadCpu(i + 1) - 40, front: 20, 'mcp-stdio': 20 },
      conversations: [0.1, 90, 95, 100, 105],
      stdioBefore: 12,
      stdioAfter: 12,
    }),
  );
  const census = { roles: { serve: { count: 1, rssMB: 300, pssMB: 250 } }, readErrors: 0 };
  const pool = {
    stdioStarted: { a: 2, b: 2 },
    stdioInitialized: { a: 1, b: 1 },
    http: { initialize: 1, openConnections: 3, peakConnections: 4, acceptedConnections: 5 },
  };
  return {
    round: n,
    turns: { single, 'per-thread': perThread },
    startup: {
      single: { readyMs: 1300, cpuMs: 1100, census },
      'per-thread': { readyMs: 1500, cpuMs: 2900, census },
    },
    firstCall: {
      single: { mcpa: 170, mcpb: 220, mcph: 260 },
      'per-thread': { mcpa: 120, mcpb: 140, mcph: 160 },
    },
    pool: { single: pool, 'per-thread': pool },
    memAfter: { single: census, 'per-thread': census },
    stopped: { single: { leftovers: [] }, 'per-thread': { leftovers: [] } },
    ...over,
  };
}

const ARMS: readonly Arm[] = ['single', 'per-thread'];

describe('每輪的量', () => {
  it('每輪 CPU 總和是整棵樹的增量除以 N', () => {
    expect(perTurnCpu(barrier(6), N)).toBe(100);
  });

  it('對話行程取最大的 N 個，預熱池那一個不算', () => {
    expect(conversationMedian(barrier(6, { conversations: [0.1, 90, 95, 100, 105] }), N)).toBe(
      97.5,
    );
    expect(conversationMedian(barrier(6), N)).toBeUndefined();
  });
});

describe('有效性', () => {
  it('六條都成立就沒有標記', () => {
    expect(
      roundFlags(
        round(1, () => 800),
        ARMS,
      ),
    ).toEqual([]);
  });

  it('每一條各自標得出來', () => {
    const r = round(1, () => 800);
    const broken: Round = {
      ...r,
      turns: {
        single: r.turns.single?.map((b) =>
          b.k === 3 ? { ...b, outcomes: ['failed'] } : b.k === 7 ? { ...b, readErrors: 1 } : b,
        ),
        'per-thread': r.turns['per-thread']?.map((b) =>
          b.k === 8 ? { ...b, died: 1, stdioAfter: 11, llmReq: 15 } : b,
        ),
      },
      stopped: { single: { leftovers: [{ pid: 1 }] }, 'per-thread': { leftovers: [] } },
    };
    expect(roundFlags(broken, ARMS)).toEqual([
      'single:outcome',
      'single:readErrors',
      'single:leftovers',
      'per-thread:born/died',
      'per-thread:stdio11/12',
      'per-thread:llmReq',
    ]);
  });

  it('暖機輪的 born/died 不算', () => {
    const r = round(1, () => 800);
    const warm: Round = {
      ...r,
      turns: {
        ...r.turns,
        single: r.turns.single?.map((b) => (b.k === 1 ? { ...b, born: 3 } : b)),
      },
    };
    expect(roundFlags(warm, ARMS)).toEqual([]);
  });
});

describe('報告', () => {
  it('比值、角色、對話行程與池的那幾行', () => {
    const group: Group = {
      tag: 'n4',
      env: { ARMS: [...ARMS], N, W: 5, T: 40 },
      results: [
        { label: 'start' },
        ...[1, 2, 3].map((n) => ({ label: `round ${String(n)}`, ...round(n, () => 800 + 40 * n) })),
      ],
    };
    const text = reportMcpPool([group]);
    expect(text).toContain('== n4（N=4，臂 single、per-thread，回合 3）');
    expect(text).toContain('標記：無');
    expect(text).not.toContain('含被標記回合');
    expect(text).toContain('    single: 100.0（90% 100.0–100.0，範圍 100.0–100.0，n=3）');
    expect(text).toContain(
      '    per-thread（代用值）: 220.0（90% 210.0–230.0，範圍 210.0–230.0，n=3）',
    );
    expect(text).toContain(
      '    per-thread/single: 2.200（90% 2.100–2.300，範圍 2.100–2.300，n=3）',
    );
    expect(text).toContain('    single 按角色：mcp-stdio 5.0 serve 95.0');
    expect(text).toContain('    per-thread 每條對話行程每輪（D162，代用值）：97.5');
    expect(text).toContain('stdio 子行程 12，stdio 起了 4 次、握手 2 次');
    expect(text).toContain(
      '首次呼叫 mcpa 120 mcpb 140 mcph 160 ms；第 1 輪 thread wall 中位 115 ms',
    );
  });

  it('被標記的回合不進主統計量', () => {
    const bad = round(2, () => 9999, {
      stopped: { single: { leftovers: [{ pid: 1 }] }, 'per-thread': { leftovers: [] } },
    });
    const group: Group = {
      tag: 'n4',
      env: { ARMS: [...ARMS], N, W: 5, T: 40 },
      results: [round(1, () => 800), bad, round(3, () => 800)].map((r) => ({
        label: `round ${String(r.round)}`,
        ...r,
      })),
    };
    const text = reportMcpPool([group]);
    expect(text).toContain('標記：r2 single:leftovers');
    expect(text).toContain(
      '    per-thread（代用值）: 200.0（90% 200.0–200.0，範圍 200.0–200.0，n=2）',
    );
    expect(text).toMatch(/ {4}含被標記回合 per-thread（代用值）: 200\.0（.*，n=3）/u);
  });
});
