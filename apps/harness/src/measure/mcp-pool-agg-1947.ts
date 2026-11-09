/**
 * #1947 第 1 步的彙總（`agg.py`），改寫成 TS，輸出逐字相同。拿 #1947 留下的原始數據兩邊各跑一次、逐字比對，證明
 * {@link ./mcp-pool-stats.ts} 的窗、中位數與 bootstrap 區間跟 Python 版是同一個定義；CI 拿合成數據釘住同一件事。
 * MCP 前後測的彙總是 {@link ./mcp-pool-agg.ts}，共用同一組統計工具。
 */

import {
  PyCounter,
  PyTuple,
  WINDOWS,
  bootstrapMedian90,
  fixed,
  median,
  pyRepr,
} from './mcp-pool-stats.js';

/** 一輪：#1947 的驅動寫進 JSON 的 `turns[臂][i]`。 */
export interface Turn1947 {
  readonly warm: boolean;
  readonly wallMs: number;
  readonly cpuMs: number;
  readonly by: Readonly<Record<string, number>>;
  readonly outcome: string;
  readonly llmReq: number;
  readonly la: string;
}

/** 一回合：JSON 裡 `label` 以 `round` 開頭的那些列。 */
export interface Round1947 {
  readonly label: string;
  readonly round: number;
  readonly turns: Readonly<Record<string, readonly Turn1947[]>>;
  readonly evict: Readonly<Record<string, { readonly ok: unknown }>>;
  readonly L: { readonly readyMs: number; readonly startupCpuMs: number };
  readonly memAfter: Readonly<Record<string, { readonly anonMB: number }>>;
}

const ARMS = ['L', 'SK', 'SF', 'SF2'] as const;

type Tagged = Round1947 & { readonly tag: string };

function arm(row: Tagged, a: string): readonly Turn1947[] {
  const turns = row.turns[a];
  if (turns === undefined) throw new Error(`${row.tag} 第 ${row.round} 回合沒有 ${a} 臂`);
  return turns;
}

function measured(row: Tagged, a: string): Turn1947[] {
  return arm(row, a).filter((t) => !t.warm);
}

function wv(row: Tagged, a: string, lo: number, hi: number, key = 'cpuMs'): number[] {
  return measured(row, a)
    .slice(lo - 1, hi)
    .map((t) =>
      key in t ? ((t as unknown as Record<string, number>)[key] ?? 0) : (t.by[key] ?? 0),
    );
}

function wvby(row: Tagged, a: string, lo: number, hi: number, comm: string): number[] {
  return measured(row, a)
    .slice(lo - 1, hi)
    .map((t) => t.by[comm] ?? 0);
}

function ratios(rs: readonly Tagged[], num: string, den: string, lo: number, hi: number): number[] {
  return rs.map((r) => median(wv(r, num, lo, hi)) / median(wv(r, den, lo, hi)));
}

function loadavg1(t: Turn1947): number {
  return Number.parseFloat(t.la.trim().split(/\s+/u)[0] ?? 'NaN');
}

/** 次數表，鍵是 Python 的 tuple；用字串當內部鍵，印的時候還原。 */
class TupleCounter {
  readonly #counts = new Map<string, [PyTuple, number]>();

  add(...items: unknown[]): void {
    const key = JSON.stringify(items);
    const hit = this.#counts.get(key);
    if (hit === undefined) this.#counts.set(key, [new PyTuple(items), 1]);
    else hit[1] += 1;
  }

  toMap(): Map<PyTuple, number> {
    return new Map([...this.#counts.values()]);
  }
}

/**
 * 照 `agg.py` 的順序與格式印出整份報告。
 *
 * @param runs - 依序的 `[tag, JSON 的 results]`；`agg.py` 讀的是 `run1`、`run2`，只有這兩個 tag 會分組列出。
 * @returns 報告全文，每行以換行結尾（同 Python 的 `print`）。
 * @throws 回合數不到 13，或某回合缺臂。
 */
export function report1947(runs: readonly (readonly [string, readonly unknown[]])[]): string {
  const lines: string[] = [];
  const print = (...parts: string[]): void => void lines.push(parts.join(' '));
  const rounds: Tagged[] = [];
  for (const [tag, results] of runs) {
    for (const raw of results) {
      const row = raw as Round1947;
      if (!String(row.label ?? '').startsWith('round')) continue;
      rounds.push({ ...row, tag });
    }
  }
  print(`回合數 ${rounds.length}`);

  const flags = new Map<PyTuple, string[]>();
  for (const row of rounds) {
    const f: string[] = [];
    for (const a of ARMS) {
      const ts = measured(row, a);
      if (arm(row, a).some((t) => t.outcome !== 'completed')) f.push(`${a}:outcome`);
      const bad = ts.map((t) => t.llmReq).filter((n) => n !== 3);
      if (bad.length > 0) f.push(`${a}:llmReq${pyRepr(new PyCounter<number>().update(bad))}`);
      if (arm(row, a).some((t) => loadavg1(t) > 3.0)) f.push(`${a}:vmload>3`);
    }
    for (const a of ['SF', 'SF2']) {
      if (row.evict[a]?.ok !== true) f.push(`${a}:notevicted`);
    }
    flags.set(new PyTuple([row.tag, row.round]), f);
  }
  const flagged = new Map([...flags].filter(([, v]) => v.length > 0));
  print('標記：', flagged.size === 0 ? '無' : pyRepr(flagged));
  const la = rounds.flatMap((row) => ARMS.flatMap((a) => arm(row, a).map(loadavg1)));
  print(`VM loadavg1 範圍 ${fixed(Math.min(...la), 2)}–${fixed(Math.max(...la), 2)}`);

  const groups: [string, Tagged[]][] = [
    ['run1', rounds.filter((r) => r.tag === 'run1')],
    ['run2', rounds.filter((r) => r.tag === 'run2')],
    ['合併 24 回合', rounds],
  ];
  for (const [label, rs] of groups) {
    print(`\n== ${label}（n=${rs.length}）`);
    for (const [lo, hi] of WINDOWS) {
      const meds = ARMS.map((a) => median(rs.map((r) => median(wv(r, a, lo, hi)))));
      print(
        `  第${lo}–${hi}輪 CPU 中位（ms，跨回合中位）：` +
          ARMS.map((a, i) => `${a} ${fixed(meds[i] ?? 0, 1)}`).join(' '),
      );
      for (const [num, den] of [
        ['L', 'SF'],
        ['SF2', 'SF'],
        ['SK', 'SF'],
        ['L', 'SK'],
      ] as const) {
        const x = ratios(rs, num, den, lo, hi);
        const b = bootstrapMedian90(x);
        print(
          `    ${num}/${den}: 中位 ${fixed(median(x), 3)}  90% 區間 ${fixed(b[0], 3)}–${fixed(b[1], 3)}  範圍 ${fixed(Math.min(...x), 3)}–${fixed(Math.max(...x), 3)}  >1 的回合 ${x.filter((v) => v > 1).length}/${x.length}`,
        );
      }
    }
  }

  print('\n== wall（合併，量測輪全部，跨回合中位的中位，ms）');
  for (const a of ARMS) {
    print(`  ${a}: ${fixed(median(rounds.map((r) => median(wv(r, a, 1, 40, 'wallMs')))), 1)}`);
  }

  print('\n== CPU 按 thread 拆（合併，各窗跨回合中位，ms）');
  const comms = new PyCounter<string>();
  for (const r of rounds) {
    for (const a of ARMS) {
      for (const t of arm(r, a)) comms.update(Object.keys(t.by).filter((k) => k !== 'total'));
    }
  }
  print('  出現過的 comm：', pyRepr(comms.counts));
  const top = comms.mostCommon(6).map(([c]) => c);
  for (const [lo, hi] of WINDOWS) {
    for (const a of ['L', 'SF', 'SK']) {
      print(
        `  第${lo}–${hi}輪 ${a}: ` +
          top
            .map(
              (c) => `${c} ${fixed(median(rounds.map((r) => median(wvby(r, a, lo, hi, c)))), 1)}`,
            )
            .join(' '),
      );
    }
  }

  print('\n== 各回合第 1–40 輪 CPU 中位（看共用行程隨回合的變化）');
  for (const r of rounds) {
    print(
      `  ${r.tag} r${String(r.round).padStart(2)}: ` +
        ARMS.map((a) => `${a} ${fixed(median(wv(r, a, 1, 40)), 1)}`).join(' ') +
        `  L ready ${pyRepr(r.L.readyMs)} 啟動 CPU ${pyRepr(r.L.startupCpuMs)}`,
    );
  }

  print('\n== 回合結束時各臂 anon（MB）與 thread 數');
  for (const r of [rounds[0], rounds[11], rounds[12], rounds.at(-1)]) {
    if (r === undefined) throw new Error('回合數不到 13，印不出記憶體那一段');
    print(
      `  ${r.tag} r${r.round}: ` +
        ARMS.map((a) => `${a} ${pyRepr(r.memAfter[a]?.anonMB)}`).join(' '),
    );
  }

  const c = new TupleCounter();
  const c2 = new TupleCounter();
  for (const r of rounds) {
    for (const a of ARMS) {
      for (const t of arm(r, a)) (t.warm ? c2 : c).add(a, t.llmReq);
    }
  }
  print('\n== 量測輪的 llmReq 分布：', pyRepr(c.toMap()));
  print('== 暖機輪的 llmReq 分布：', pyRepr(c2.toMap()));
  return lines.map((line) => `${line}\n`).join('');
}
