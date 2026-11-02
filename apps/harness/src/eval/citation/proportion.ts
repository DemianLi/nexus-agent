/**
 * 比例的信賴區間（Wilson score interval）。
 *
 * **為什麼不用 [`../stats.ts`](../stats.ts) 的區間**：那一份是「以題目為單位重抽」的 bootstrap（#1002），單位是**題**，
 * 每題先對自己的幾次執行取平均、再把題當獨立樣本；少於兩題不報區間。這次量的是同一組夾具下「這個行為發生的比例」，
 * 每次執行是一次伯努利試驗，要的是 k/n 的二項比例區間。硬套的話，4 個問法就成了 4 個「題」，區間寬到沒有意義，
 * 而且會把「問法之間的差」和「同一問法重跑之間的差」混在一起算。
 *
 * Wilson 在 n 只有 20 上下、比例靠近 0 或 1 時比 Wald（p ± z√(p(1−p)/n)）可靠：Wald 在 0/20 時給出 [0, 0]，
 * 好像一次都不可能發生，Wilson 給 [0, 0.16]。**它仍然假設每次執行互相獨立**——同一題的重跑共用同一個 prompt 與同一份夾具，
 * 這個假設是近似；報告裡同時列出各問法的明細，讓讀的人自己看有沒有某個問法特別偏。
 */

/** 區間與點估計。 */
export interface Proportion {
  readonly k: number;
  readonly n: number;
  /** 點估計 k/n；n 為 0 時為 `NaN`。 */
  readonly p: number;
  readonly low: number;
  readonly high: number;
}

/** 95% 的 z 值。 */
export const Z_95 = 1.959964;

/**
 * 算 k/n 的 Wilson 區間。
 *
 * @param k - 發生次數。
 * @param n - 總次數。
 * @param z - 常態分位數，預設 95%。
 * @returns 點估計與區間；n 為 0 時全部是 `NaN`。
 */
export function wilson(k: number, n: number, z: number = Z_95): Proportion {
  if (!Number.isInteger(k) || !Number.isInteger(n) || n < 0 || k < 0 || k > n) {
    throw new RangeError(`需要 0 ≤ k ≤ n 的整數，拿到 k=${k}、n=${n}`);
  }
  if (n === 0) return { k, n, p: Number.NaN, low: Number.NaN, high: Number.NaN };
  const p = k / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return { k, n, p, low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

/** 印成 `12/24 = 50% [31%, 69%]`。 */
export function formatProportion(value: Proportion): string {
  if (value.n === 0) return '0/0';
  const pct = (x: number): string => `${Math.round(x * 100)}%`;
  return `${value.k}/${value.n} = ${pct(value.p)} [${pct(value.low)}, ${pct(value.high)}]`;
}
