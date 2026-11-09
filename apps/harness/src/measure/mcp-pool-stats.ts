/**
 * MCP 連線池前後測（#2570）的統計工具。#1947 的彙總是 Python 寫的（`random.Random`、`statistics.median`、
 * `f'{x:.3f}'`）；這裡逐位重現它的行為，同一份原始數據兩邊印出來的報告才能逐字相同，窗與區間的定義也才沒有走樣。
 */

const N = 624;
const M = 397;

/** Python `random.Random(seed)` 的 MT19937。只支援非負整數種子，以及 `getrandbits(k ≤ 32)` 與 `randrange(n)`。 */
export class PyRandom {
  readonly #mt = new Uint32Array(N);
  #index = N;

  constructor(seed: number | bigint) {
    let rest = BigInt(seed);
    if (rest < 0n) throw new Error('PyRandom 只收非負整數種子');
    const key: number[] = [];
    do {
      key.push(Number(rest & 0xffffffffn));
      rest >>= 32n;
    } while (rest > 0n);
    this.#initByArray(key);
  }

  #initGenrand(s: number): void {
    const mt = this.#mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < N; i++) {
      const prev = mt[i - 1] ?? 0;
      mt[i] = (Math.imul(1812433253, prev ^ (prev >>> 30)) + i) >>> 0;
    }
    this.#index = N;
  }

  #initByArray(key: readonly number[]): void {
    const mt = this.#mt;
    this.#initGenrand(19650218);
    let i = 1;
    let j = 0;
    for (let k = Math.max(N, key.length); k > 0; k--) {
      const prev = mt[i - 1] ?? 0;
      mt[i] = (((mt[i] ?? 0) ^ Math.imul(prev ^ (prev >>> 30), 1664525)) + (key[j] ?? 0) + j) >>> 0;
      i++;
      j++;
      if (i >= N) {
        mt[0] = mt[N - 1] ?? 0;
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (let k = N - 1; k > 0; k--) {
      const prev = mt[i - 1] ?? 0;
      mt[i] = (((mt[i] ?? 0) ^ Math.imul(prev ^ (prev >>> 30), 1566083941)) - i) >>> 0;
      i++;
      if (i >= N) {
        mt[0] = mt[N - 1] ?? 0;
        i = 1;
      }
    }
    mt[0] = 0x80000000;
  }

  #next(): number {
    const mt = this.#mt;
    if (this.#index >= N) {
      for (let k = 0; k < N; k++) {
        const y = ((mt[k] ?? 0) & 0x80000000) | ((mt[(k + 1) % N] ?? 0) & 0x7fffffff);
        mt[k] = ((mt[(k + M) % N] ?? 0) ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0)) >>> 0;
      }
      this.#index = 0;
    }
    let y = mt[this.#index++] ?? 0;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** `getrandbits(k)`，`1 ≤ k ≤ 32`。 */
  getrandbits(k: number): number {
    if (!Number.isInteger(k) || k < 1 || k > 32)
      throw new Error(`getrandbits 只支援 1–32 位元：${k}`);
    return this.#next() >>> (32 - k);
  }

  /** `randrange(n)`：Python 的 `_randbelow`，取 `n` 的位元數，超出就重抽。 */
  randrange(n: number): number {
    if (!Number.isInteger(n) || n < 1 || n > 0xffffffff)
      throw new Error(`randrange 只支援 1–2³²−1：${n}`);
    const k = Math.floor(Math.log2(n)) + 1;
    let r = this.getrandbits(k);
    while (r >= n) r = this.getrandbits(k);
    return r;
  }
}

/** `statistics.median`：偶數個取中間兩個的平均。 */
export function median(xs: readonly number[]): number {
  if (xs.length === 0) throw new Error('median 不收空的序列');
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const hi = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? hi : ((sorted[mid - 1] ?? 0) + hi) / 2;
}

/**
 * 中位數的 bootstrap 90% 區間：重抽 `n` 次、各取中位數、排序後取第 5% 與第 95% 位（#1947 `agg.py` 的 `boot`）。
 *
 * @returns `[下緣, 上緣]`。
 */
export function bootstrapMedian90(xs: readonly number[], n = 10000, seed = 1947): [number, number] {
  const rnd = new PyRandom(seed);
  const m = xs.length;
  const bs: number[] = [];
  for (let b = 0; b < n; b++) {
    const sample: number[] = [];
    for (let i = 0; i < m; i++) sample.push(xs[rnd.randrange(m)] ?? 0);
    bs.push(median(sample));
  }
  bs.sort((a, b) => a - b);
  return [bs[Math.trunc(0.05 * n)] ?? 0, bs[Math.trunc(0.95 * n) - 1] ?? 0];
}

/**
 * Python 的 `f'{x:.{digits}f}'`：照 double 的精確值四捨五入，剛好一半時取偶數（`Number#toFixed` 取大的那一邊）。
 */
export function fixed(x: number, digits: number): string {
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : x < 0 ? '-inf' : 'nan';
  const negative = x < 0 || Object.is(x, -0);
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(x));
  const bits = view.getBigUint64(0);
  const rawExp = Number((bits >> 52n) & 0x7ffn);
  const frac = bits & 0xfffffffffffffn;
  const mant = rawExp === 0 ? frac : frac | (1n << 52n);
  const exp = (rawExp === 0 ? 1 : rawExp) - 1075;
  const scale = 10n ** BigInt(digits);
  let q: bigint;
  if (exp >= 0) {
    q = (mant << BigInt(exp)) * scale;
  } else {
    const den = 1n << BigInt(-exp);
    const num = mant * scale;
    q = num / den;
    const twice = (num % den) * 2n;
    if (twice > den || (twice === den && q % 2n === 1n)) q += 1n;
  }
  const s = q.toString().padStart(digits + 1, '0');
  const body = digits === 0 ? s : `${s.slice(0, -digits)}.${s.slice(-digits)}`;
  return negative ? `-${body}` : body;
}

/** Python 的 tuple，只給 {@link pyRepr} 分辨用。 */
export class PyTuple {
  constructor(readonly items: readonly unknown[]) {}
}

/** Python 的 `collections.Counter`：插入順序，`repr` 照次數由多到少。 */
export class PyCounter<K> {
  readonly counts = new Map<K, number>();

  update(keys: Iterable<K>): this {
    for (const key of keys) this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    return this;
  }

  /** `most_common(n)`：次數由多到少，同次數照插入順序（Python 的排序是穩定的）。 */
  mostCommon(n?: number): [K, number][] {
    const sorted = [...this.counts].sort((a, b) => b[1] - a[1]);
    return n === undefined ? sorted : sorted.slice(0, n);
  }
}

function reprString(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = '';
  for (const ch of s) {
    if (ch === '\\' || ch === quote) out += `\\${ch}`;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else out += ch;
  }
  return `${quote}${out}${quote}`;
}

/**
 * Python 的 `repr`，涵蓋彙總會印到的型別：字串、數字（整數印成 `1`，其他照最短表示）、布林、`None`、
 * 陣列（list）、{@link PyTuple}、`Map`（dict）、{@link PyCounter}。數字的整數與浮點之分照 JSON 原文：
 * 量具的 JSON 由 `JSON.stringify` 寫出，整數值的浮點不會帶 `.0`，Python 讀進來也是 int。
 */
export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'string') return reprString(value);
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(value);
  if (value instanceof PyTuple) {
    const items = value.items.map(pyRepr);
    return items.length === 1 ? `(${items[0]},)` : `(${items.join(', ')})`;
  }
  if (value instanceof PyCounter) {
    return `Counter({${value
      .mostCommon()
      .map(([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`)
      .join(', ')}})`;
  }
  if (value instanceof Map) {
    return `{${[...value].map(([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`).join(', ')}}`;
  }
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`;
  throw new Error(`pyRepr 不認得這個型別：${typeof value}`);
}
