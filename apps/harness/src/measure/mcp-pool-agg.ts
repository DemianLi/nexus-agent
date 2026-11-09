/**
 * MCP 連線池前測（#2570 PR-A）的彙總：照 `.docs/mcp-pool-baseline-2570-2026-11-10.md` 的規則，把
 * {@link ./mcp-pool-driver.ts} 寫的 JSON 印成報告。窗、中位數與 bootstrap 區間都用 {@link ./mcp-pool-stats.ts}，
 * 跟 #1947 的彙總同一個定義。
 */

import { WINDOWS, bootstrapMedian90, fixed, median } from './mcp-pool-stats.js';

export type Arm = 'single' | 'per-thread';

/** 一道柵欄：驅動寫的 `turns[臂][i]`。 */
export interface Barrier {
  readonly k: number;
  readonly warm: boolean;
  readonly cpuMs: number;
  readonly statMs: number;
  readonly byRole: Readonly<Record<string, number>>;
  readonly conversations: readonly number[];
  readonly born: number;
  readonly died: number;
  readonly readErrors: number;
  readonly stdioBefore: number;
  readonly stdioAfter: number;
  readonly outcomes: readonly string[];
  readonly llmReq: number;
  readonly threadWallMs: readonly number[];
}

/** 驅動 `census()` 寫的：各角色的行程數與 RSS／PSS。 */
export interface Census {
  readonly roles: Readonly<
    Record<string, { readonly count: number; readonly rssMB: number; readonly pssMB: number }>
  >;
  readonly readErrors: number;
}

/** 驅動 `poolMetrics()` 寫的。 */
export interface PoolMetrics {
  readonly stdioStarted: Readonly<Record<string, number>>;
  readonly stdioInitialized: Readonly<Record<string, number>>;
  readonly http: {
    readonly initialize: number;
    readonly openConnections: number;
    readonly peakConnections: number;
    readonly acceptedConnections: number;
  };
}

/** 一回合：JSON 裡 `label` 以 `round` 開頭的那些列。 */
export interface Round {
  readonly round: number;
  readonly turns: Readonly<Partial<Record<Arm, readonly Barrier[]>>>;
  readonly startup: Readonly<
    Partial<
      Record<Arm, { readonly readyMs: number; readonly cpuMs: number; readonly census: Census }>
    >
  >;
  readonly firstCall: Readonly<Partial<Record<Arm, Readonly<Record<string, number | null>>>>>;
  readonly pool: Readonly<Partial<Record<Arm, PoolMetrics>>>;
  readonly memAfter: Readonly<Partial<Record<Arm, Census>>>;
  readonly stopped: Readonly<Partial<Record<Arm, { readonly leftovers: readonly unknown[] }>>>;
}

/** 一組：驅動一次執行的 JSON。 */
export interface Group {
  readonly tag: string;
  readonly env: {
    readonly ARMS: readonly Arm[];
    readonly N: number;
    readonly W: number;
    readonly T: number;
  };
  readonly results: readonly unknown[];
}

function roundsOf(group: Group): Round[] {
  return group.results.filter((row): row is Round =>
    String((row as { label?: unknown }).label ?? '').startsWith('round'),
  );
}

function barriers(r: Round, arm: Arm): readonly Barrier[] {
  const b = r.turns[arm];
  if (b === undefined) throw new Error(`第 ${r.round} 回合沒有 ${arm}`);
  return b;
}

const measured = (r: Round, arm: Arm): Barrier[] => barriers(r, arm).filter((b) => !b.warm);

/** 一道柵欄的每輪 CPU 總和：整棵行程樹的增量 ÷ 這道柵欄完成的輪數。 */
export function perTurnCpu(b: Barrier, n: number): number {
  return b.cpuMs / n;
}

/** 一道柵欄裡每條對話行程的 CPU：取最大的 N 個（預熱池那一個這一輪沒接 thread），回中位數；沒有對話行程（single 臂）回 undefined。 */
export function conversationMedian(b: Barrier, n: number): number | undefined {
  const top = [...b.conversations].sort((x, y) => y - x).slice(0, n);
  return top.length === 0 ? undefined : median(top);
}

/**
 * 有效性（規則「有效性、排除與標記」的 1–6 條）：回該回合違反了哪幾條，空陣列就是有效。
 */
export function roundFlags(r: Round, arms: readonly Arm[]): string[] {
  const out: string[] = [];
  for (const a of arms) {
    const all = barriers(r, a);
    if (all.some((b) => b.outcomes.some((o) => o !== 'completed'))) out.push(`${a}:outcome`);
    const ms = measured(r, a);
    if (ms.some((b) => b.readErrors !== 0)) out.push(`${a}:readErrors`);
    if (ms.some((b) => b.born !== 0 || b.died !== 0)) out.push(`${a}:born/died`);
    const counts = new Set(ms.flatMap((b) => [b.stdioBefore, b.stdioAfter]));
    if (counts.size > 1) out.push(`${a}:stdio${[...counts].sort((x, y) => x - y).join('/')}`);
    if ((r.stopped[a]?.leftovers.length ?? 0) > 0) out.push(`${a}:leftovers`);
  }
  const [first, ...rest] = arms;
  if (first !== undefined) {
    const ref = barriers(r, first).map((b) => b.llmReq);
    for (const a of rest) {
      const other = barriers(r, a).map((b) => b.llmReq);
      if (other.length !== ref.length || other.some((x, i) => x !== ref[i]))
        out.push(`${a}:llmReq`);
    }
  }
  return out;
}

/** 一回合一窗：該窗每道柵欄的值取中位數。 */
function windowMedian(
  r: Round,
  a: Arm,
  lo: number,
  hi: number,
  f: (b: Barrier) => number | undefined,
): number {
  const xs = measured(r, a)
    .slice(lo - 1, hi)
    .map(f)
    .filter((x): x is number => x !== undefined);
  return median(xs);
}

function summary(xs: readonly number[], digits: number): string {
  const [lo, hi] = bootstrapMedian90(xs);
  return `${fixed(median(xs), digits)}（90% ${fixed(lo, digits)}–${fixed(hi, digits)}，範圍 ${fixed(Math.min(...xs), digits)}–${fixed(Math.max(...xs), digits)}，n=${String(xs.length)}）`;
}

const medOf = (xs: readonly number[]): number => (xs.length === 0 ? Number.NaN : median(xs));

/**
 * 整份報告。主統計量只用有效回合；有回合被標記時，每窗的每輪 CPU 總和另印一段含它們的值。per-thread 的每輪 CPU 總和與每條對話行程每輪標成「代用值」。
 *
 * @param groups - 依序的各組 JSON（每組是驅動一次執行）。
 * @returns 報告全文，每行以換行結尾。
 * @throws 某回合缺一臂，或某窗在用到的回合裡沒有值（例如 T < 21）。
 */
export function reportMcpPool(groups: readonly Group[]): string {
  const lines: string[] = [];
  const print = (line = ''): void => void lines.push(line);
  for (const g of groups) {
    const { N, ARMS: arms } = g.env;
    const all = roundsOf(g);
    print(`== ${g.tag}（N=${String(N)}，臂 ${arms.join('、')}，回合 ${String(all.length)}）`);
    const flags = all.map((r) => [r.round, roundFlags(r, arms)] as const);
    const bad = flags.filter(([, f]) => f.length > 0);
    print(
      `  標記：${bad.length === 0 ? '無' : bad.map(([n, f]) => `r${String(n)} ${f.join(' ')}`).join('；')}`,
    );
    const rs = all.filter((r) => roundFlags(r, arms).length === 0);
    if (rs.length === 0) {
      print('  沒有有效的回合');
      print();
      continue;
    }
    const proxy = (a: Arm): string => (a === 'per-thread' ? '（代用值）' : '');
    for (const [lo, hi] of WINDOWS) {
      print(`  第${String(lo)}–${String(hi)}輪 每輪 CPU 總和（ms，跨回合中位）`);
      const per: Partial<Record<Arm, number[]>> = {};
      for (const a of arms) {
        per[a] = rs.map((r) => windowMedian(r, a, lo, hi, (b) => perTurnCpu(b, N)));
        print(`    ${a}${proxy(a)}: ${summary(per[a] ?? [], 1)}`);
      }
      if (bad.length > 0) {
        for (const a of arms) {
          const xs = all.map((r) => windowMedian(r, a, lo, hi, (b) => perTurnCpu(b, N)));
          print(`    含被標記回合 ${a}${proxy(a)}: ${summary(xs, 1)}`);
        }
      }
      const s = per.single;
      const p = per['per-thread'];
      if (s !== undefined && p !== undefined) {
        print(
          `    per-thread/single: ${summary(
            p.map((x, i) => x / (s[i] ?? Number.NaN)),
            3,
          )}`,
        );
      }
      for (const a of arms) {
        const roles = [
          ...new Set(rs.flatMap((r) => measured(r, a).flatMap((b) => Object.keys(b.byRole)))),
        ].sort();
        print(
          `    ${a} 按角色：` +
            roles
              .map(
                (role) =>
                  `${role} ${fixed(median(rs.map((r) => windowMedian(r, a, lo, hi, (b) => (b.byRole[role] ?? 0) / N))), 1)}`,
              )
              .join(' '),
        );
      }
      if (arms.includes('per-thread')) {
        const conv = rs.map((r) =>
          windowMedian(r, 'per-thread', lo, hi, (b) => conversationMedian(b, N)),
        );
        print(`    per-thread 每條對話行程每輪（D162，代用值）：${summary(conv, 1)}`);
      }
    }
    print('  池與記憶體（跨回合中位）');
    for (const a of arms) {
      const pool = rs.map((r) => r.pool[a]);
      const sumOf = (o: Readonly<Record<string, number>> | undefined): number =>
        Object.values(o ?? {}).reduce((x, y) => x + y, 0);
      const stdioAlive = medOf(rs.map((r) => measured(r, a)[0]?.stdioBefore ?? Number.NaN));
      print(
        `    ${a}: stdio 子行程 ${fixed(stdioAlive, 0)}，stdio 起了 ${fixed(medOf(pool.map((x) => sumOf(x?.stdioStarted))), 0)} 次、握手 ${fixed(medOf(pool.map((x) => sumOf(x?.stdioInitialized))), 0)} 次，` +
          `HTTP initialize ${fixed(medOf(pool.map((x) => x?.http.initialize ?? Number.NaN)), 0)} 次、連線 開著 ${fixed(medOf(pool.map((x) => x?.http.openConnections ?? Number.NaN)), 0)}／峰值 ${fixed(medOf(pool.map((x) => x?.http.peakConnections ?? Number.NaN)), 0)}／累計 ${fixed(medOf(pool.map((x) => x?.http.acceptedConnections ?? Number.NaN)), 0)}`,
      );
      const roles = [...new Set(rs.flatMap((r) => Object.keys(r.memAfter[a]?.roles ?? {})))].sort();
      print(
        `    ${a} 回合結束的記憶體（RSS／PSS MB，個數）：` +
          roles
            .map((role) => {
              const pick = (k: 'rssMB' | 'pssMB' | 'count'): string =>
                fixed(
                  medOf(rs.map((r) => r.memAfter[a]?.roles[role]?.[k] ?? 0)),
                  k === 'count' ? 0 : 1,
                );
              return `${role} ${pick('rssMB')}／${pick('pssMB')}（${pick('count')}）`;
            })
            .join(' '),
      );
      const total = (k: 'rssMB' | 'pssMB'): string =>
        fixed(
          medOf(
            rs.map((r) => Object.values(r.memAfter[a]?.roles ?? {}).reduce((x, y) => x + y[k], 0)),
          ),
          1,
        );
      print(`    ${a} 合計 RSS ${total('rssMB')} MB、PSS ${total('pssMB')} MB`);
      print(
        `    ${a} 起動：ready ${fixed(medOf(rs.map((r) => r.startup[a]?.readyMs ?? Number.NaN)), 0)} ms、起動 CPU ${fixed(medOf(rs.map((r) => r.startup[a]?.cpuMs ?? Number.NaN)), 0)} ms；` +
          `首次呼叫 ` +
          ['mcpa', 'mcpb', 'mcph']
            .map((s) => `${s} ${fixed(medOf(rs.map((r) => r.firstCall[a]?.[s] ?? Number.NaN)), 0)}`)
            .join(' ') +
          ` ms；第 1 輪 thread wall 中位 ${fixed(medOf(rs.map((r) => median(barriers(r, a)[0]?.threadWallMs ?? [Number.NaN]))), 0)} ms`,
      );
      const stat = rs.flatMap((r) => measured(r, a).map((b) => b.statMs / b.cpuMs));
      print(
        `    ${a} 對帳 stat/schedstat：${fixed(medOf(stat), 3)}（範圍 ${fixed(Math.min(...stat), 3)}–${fixed(Math.max(...stat), 3)}）`,
      );
    }
    print();
  }
  return lines.map((line) => `${line}\n`).join('');
}
