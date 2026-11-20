/**
 * 殺宿主量測（#3032，規則見 `.docs/mcp-pool-baseline-2570-2026-11-10.md`「後測的規則」二、W 的量測與其補充段）的統計：段 A、段 B、兩段相加的
 * p50／p95／最大值，W 的正式值公式，以及規則寫死的回報條件。
 *
 * 百分位用 nearest-rank：第 p 百分位是排序後第 ⌈p/100 × n⌉ 個（n＝30 時 p95 是第 29 個）。
 *
 * @module
 */

/** 一筆有效樣本：兩段與當時的退避。 */
export interface KillSample {
  /** 段 A：宿主被殺 → 對話行程的 `onReady`（毫秒）。 */
  readonly aMs: number;
  /** 段 B：段 A 結束 → 重新 `open` 的綁定可用（毫秒）。 */
  readonly bMs: number;
  /** 監督行程 stderr 的「宿主 N ms 後重起」；沒讀到記 `undefined`。 */
  readonly backoffMs: number | undefined;
}

export interface Dist {
  readonly n: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

/** nearest-rank 百分位；空陣列回 NaN。 */
export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return Number.NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? Number.NaN;
}

export function dist(xs: readonly number[]): Dist {
  return {
    n: xs.length,
    p50: percentile(xs, 50),
    p95: percentile(xs, 95),
    max: xs.length === 0 ? Number.NaN : Math.max(...xs),
  };
}

export const W_FLOOR_MS = 5_000;

/**
 * W ＝ ⌈ 兩段相加的最大值（各架構取較大者）× 1.5 ⌉ 取整到秒，下限 5 秒。
 *
 * @param maxSumMsByArch - 各架構「兩段相加」的最大值（毫秒）。
 * @returns W（毫秒，整秒）。
 */
export function wFormula(maxSumMsByArch: readonly number[]): number {
  const worst = Math.max(...maxSumMsByArch);
  return Math.max(W_FLOOR_MS, Math.ceil((worst * 1.5) / 1000) * 1000);
}

export interface ArchSummary {
  readonly arch: string;
  readonly a: Dist;
  readonly b: Dist;
  readonly sum: Dist;
  /** 扣掉退避等待之後的段 A（沒讀到退避的樣本不進）。 */
  readonly aNoBackoff: Dist;
  readonly missing: number;
}

/** attempts 是這個架構應有的單次殺次數；missing＝attempts－有效樣本數，沒殺到的、作廢的都算。 */
export function summarize(
  arch: string,
  samples: readonly KillSample[],
  attempts: number,
): ArchSummary {
  return {
    arch,
    a: dist(samples.map((s) => s.aMs)),
    b: dist(samples.map((s) => s.bMs)),
    sum: dist(samples.map((s) => s.aMs + s.bMs)),
    aNoBackoff: dist(
      samples.filter((s) => s.backoffMs !== undefined).map((s) => s.aMs - (s.backoffMs ?? 0)),
    ),
    missing: attempts - samples.length,
  };
}

/**
 * 規則寫死的回報條件：A＋B 最大值超過 3 秒；A、B、A＋B 任一 p95 超過 2 秒；有缺樣本；兩架構最大值差一倍以上。回觸發了哪幾條，空陣列就是都沒觸發。
 * 觸發後怎麼處理，見 `.docs/mcp-pool-baseline-2570-2026-11-10.md`「要回報 PM、不自己調的情況」。
 */
export function reportTriggers(summaries: readonly ArchSummary[]): string[] {
  const out: string[] = [];
  for (const s of summaries) {
    if (s.sum.max > 3_000)
      out.push(`${s.arch}：兩段相加的最大值 ${s.sum.max.toFixed(0)} ms 超過 3000 ms`);
    if (s.sum.p95 > 2_000 || s.a.p95 > 2_000 || s.b.p95 > 2_000) {
      out.push(
        `${s.arch}：p95（A ${s.a.p95.toFixed(0)}／B ${s.b.p95.toFixed(0)}／相加 ${s.sum.p95.toFixed(0)} ms）超過 2000 ms`,
      );
    }
    if (s.missing > 0)
      out.push(`${s.arch}：${String(s.missing)} 次沒有取得有效樣本（綁定沒回來或自我檢查不過）`);
  }
  const maxes = summaries.map((s) => s.sum.max);
  if (maxes.length > 1 && Math.max(...maxes) >= 2 * Math.min(...maxes)) {
    out.push('兩個架構的最大值差一倍以上');
  }
  return out;
}
