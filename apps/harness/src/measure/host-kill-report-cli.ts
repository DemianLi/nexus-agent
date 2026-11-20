/**
 * 印殺宿主量測的結果（{@link ./host-kill-stats.ts}）：段 A、B、相加的 p50／p95／最大值，W 的公式值，規則寫死的回報條件，連續殺的退避與段 A。
 * 每個參數是 `<架構>=<組.json>`，一個檔一個架構。不進 CI：原始數據在本機證據目錄。
 *
 * ```bash
 * KILLS=<單次殺次數，要和量測那次相同> pnpm --filter @nexus/harness exec tsx src/measure/host-kill-report-cli.ts arm64=<組.json> [x64=<組.json>]
 * ```
 */

import { readFileSync } from 'node:fs';
import { reportTriggers, summarize, wFormula } from './host-kill-stats.js';
import type { Dist, KillSample } from './host-kill-stats.js';

interface Row {
  readonly label: string;
  readonly valid?: boolean;
  readonly why?: string;
  readonly aMs?: number;
  readonly bMs?: number;
  readonly backoffMs?: number;
  readonly hostAgeMsAtKill?: number;
}

const args = process.argv.slice(2);
if (args.length === 0) throw new Error('用法：host-kill-report-cli.ts <架構>=<組.json>…');
const fmt = (d: Dist): string =>
  `n=${String(d.n)} p50 ${d.p50.toFixed(0)} p95 ${d.p95.toFixed(0)} 最大 ${d.max.toFixed(0)} ms`;
const summaries = [];
const lines: string[] = [];
for (const arg of args) {
  const [arch, file] = arg.split('=');
  if (arch === undefined || file === undefined) throw new Error(`格式要 <架構>=<檔>：${arg}`);
  const rows = (JSON.parse(readFileSync(file, 'utf8')) as { results: Row[] }).results;
  const single = rows.filter((r) => r.label.startsWith('kill single-'));
  const samples: KillSample[] = single
    .filter((r) => r.valid === true)
    .map((r) => ({ aMs: r.aMs ?? Number.NaN, bMs: r.bMs ?? Number.NaN, backoffMs: r.backoffMs }));
  // 驅動提早收尾時沒殺到的次數也算沒恢復，所以分母取 KILLS。
  const s = summarize(
    arch,
    samples,
    single.length === 0 ? 0 : Math.max(single.length, Number(process.env.KILLS ?? 30)),
  );
  summaries.push(s);
  lines.push(`== ${arch}`);
  lines.push(`  段 A：${fmt(s.a)}`);
  lines.push(`  段 B：${fmt(s.b)}`);
  lines.push(`  A＋B：${fmt(s.sum)}`);
  lines.push(`  扣掉退避的段 A：${fmt(s.aNoBackoff)}`);
  lines.push(
    `  作廢或沒恢復：${String(s.missing)}（${
      single
        .filter((r) => r.valid !== true)
        .map((r) => `${r.label}：${r.why ?? ''}`)
        .join('；') || '無'
    }）`,
  );
  const backoffs = single.map((r) => r.backoffMs).filter((x): x is number => x !== undefined);
  lines.push(
    `  單次樣本的退避：${[...new Set(backoffs)].sort((a, b) => a - b).join('、') || '沒讀到'} ms`,
  );
  lines.push(
    `  殺之前宿主存活（ms）：最小 ${String(Math.min(...single.map((r) => r.hostAgeMsAtKill ?? Number.NaN)))}`,
  );
  lines.push('  連續殺（退避 ms／段 A ms／有效）：');
  for (const r of rows.filter((x) => x.label.startsWith('kill consec-'))) {
    lines.push(
      `    ${r.label}：${String(r.backoffMs ?? '無')}／${r.aMs?.toFixed(0) ?? '無'}／${r.valid === true ? '是' : `否（${r.why ?? ''}）`}`,
    );
  }
}
lines.push(`W 的公式值：${String(wFormula(summaries.map((s) => s.sum.max)))} ms`);
const triggers = reportTriggers(summaries);
lines.push(`回報條件：${triggers.length === 0 ? '沒有觸發' : triggers.join('；')}`);
process.stdout.write(`${lines.join('\n')}\n`);
