/**
 * 池的後測判定（#3032，規則見 `.docs/mcp-pool-baseline-2570-2026-11-10.md`「後測的規則」與其補充段）：三條過關條件逐條算成立或不成立。
 * 前測的比值區間與握手次數是那份文件「結果」節的表，抄在這裡當對照，不從前測原始數據重算。
 *
 * @module
 */

import {
  condition2Violations,
  perTurnCpu,
  roundFlags,
  roundsOf,
  windowMedian,
} from './mcp-pool-agg.js';
import type { Group } from './mcp-pool-agg.js';
import { WINDOWS, fixed, median } from './mcp-pool-stats.js';

/** 前測 per-thread ÷ single 的 bootstrap 90% 區間上緣，依窗 1–10、11–20、21–40 的順序。 */
export const PRE_RATIO_UPPER: Readonly<Record<number, readonly [number, number, number]>> = {
  4: [1.448, 1.292, 1.24],
  8: [1.81, 1.772, 1.513],
  16: [1.9, 1.644, 1.61],
};

/** 前測 per-thread 臂每回合的握手數（整台合計）：stdio 兩列合計、HTTP 一列。 */
export const PRE_HANDSHAKES: Readonly<Record<number, { stdio: number; http: number }>> = {
  4: { stdio: 12, http: 6 },
  8: { stdio: 20, http: 10 },
  16: { stdio: 36, http: 18 },
};

/** stdio server 的列數（M 台裡 stdio 的兩台）：條件 2 的預期子行程數，也是條件 3 每列上限的除數。 */
export const STDIO_ROWS = 2;

export interface Verdict {
  readonly n: number;
  readonly c1: readonly string[];
  readonly c1Pass: boolean;
  readonly c2Violations: readonly string[];
  readonly c3: readonly string[];
  readonly c3Pass: boolean;
}

/** 一組（一個 N）的後測判定。只用 roundFlags 沒標記的回合；N 不在前測表裡、或沒有有效回合就 throw。 */
export function postVerdict(group: Group): Verdict {
  const { N } = group.env;
  const arms = group.env.ARMS;
  const upper = PRE_RATIO_UPPER[N];
  const pre = PRE_HANDSHAKES[N];
  if (upper === undefined || pre === undefined) throw new Error(`前測沒有 N=${String(N)}`);
  const valid = roundsOf(group).filter((r) => roundFlags(r, arms).length === 0);
  if (valid.length === 0) throw new Error(`${group.tag} 沒有有效的回合`);
  const c1: string[] = [];
  let c1Pass = true;
  WINDOWS.forEach(([lo, hi], i) => {
    const ratios = valid.map(
      (r) =>
        windowMedian(r, 'per-thread', lo, hi, (b) => perTurnCpu(b, N)) /
        windowMedian(r, 'single', lo, hi, (b) => perTurnCpu(b, N)),
    );
    const med = median(ratios);
    const limit = upper[i] ?? Number.NaN;
    const ok = med <= limit;
    c1Pass &&= ok;
    c1.push(
      `第${String(lo)}–${String(hi)}輪 比值 ${fixed(med, 3)} ≤ 前測上緣 ${fixed(limit, 3)}：${ok ? '成立' : '不成立'}`,
    );
  });
  const c2Violations = valid.flatMap((r) =>
    condition2Violations(r, 'per-thread', STDIO_ROWS).map((v) => `r${String(r.round)} ${v}`),
  );
  const c3: string[] = [];
  let c3Pass = true;
  for (const r of valid) {
    const pool = r.pool['per-thread'];
    const init = Object.entries(pool?.stdioInitialized ?? {});
    const limitRow = pre.stdio / STDIO_ROWS;
    for (const [server, n] of init) {
      const ok = n <= limitRow;
      c3Pass &&= ok;
      c3.push(
        `r${String(r.round)} stdio ${server} initialize ${String(n)} ≤ ${String(limitRow)}：${ok ? '成立' : '不成立'}`,
      );
    }
    const http = pool?.http.initialize ?? Number.NaN;
    const okHttp = http <= pre.http;
    c3Pass &&= okHttp;
    c3.push(
      `r${String(r.round)} HTTP initialize ${String(http)} ≤ ${String(pre.http)}：${okHttp ? '成立' : '不成立'}`,
    );
  }
  // 沒有任何一個 stdio 列記到握手，視為資料缺，不算成立。
  if (valid.every((r) => Object.keys(r.pool['per-thread']?.stdioInitialized ?? {}).length === 0))
    c3Pass = false;
  return { n: N, c1, c1Pass, c2Violations, c3, c3Pass };
}

/** 每組印三條條件的成立與否與明細；任一組 {@link postVerdict} throw 就整個 throw。 */
export function reportPost(groups: readonly Group[]): string {
  const lines: string[] = [];
  for (const g of groups) {
    const v = postVerdict(g);
    lines.push(`== ${g.tag}（N=${String(v.n)}）`);
    lines.push(
      `  條件 1（CPU 比值）：${v.c1Pass ? '成立' : '不成立'}`,
      ...v.c1.map((x) => `    ${x}`),
    );
    lines.push(
      `  條件 2（stdio 子行程）：${v.c2Violations.length === 0 ? '成立' : '不成立'}`,
      ...v.c2Violations.map((x) => `    ${x}`),
    );
    lines.push(`  條件 3（握手）：${v.c3Pass ? '成立' : '不成立'}`, ...v.c3.map((x) => `    ${x}`));
  }
  return `${lines.join('\n')}\n`;
}
