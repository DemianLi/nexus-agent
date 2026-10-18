// 暫時的量測檔（#1526）：在 CI 的 vitest 裡量原生 JSON.stringify／structuredClone 的層數門檻。量完就撤。
import { it } from 'vitest';

type Shape = 'object' | 'array' | 'mixed';
const build: Record<Shape, (n: number) => unknown> = {
  object: (n) => {
    let v: unknown = 'leaf';
    for (let i = 0; i < n; i++) v = { next: v };
    return v;
  },
  array: (n) => {
    let v: unknown = 'leaf';
    for (let i = 0; i < n; i++) v = [v];
    return v;
  },
  mixed: (n) => {
    let v: unknown = 'leaf';
    for (let i = 0; i < n; i++) v = i % 2 ? { next: v } : [v];
    return v;
  },
};
function freeze<T>(v: T): T {
  const stack: unknown[] = [v];
  while (stack.length) {
    const x = stack.pop();
    if (x === null || typeof x !== 'object' || Object.isFrozen(x)) continue;
    Object.freeze(x);
    for (const k of Object.keys(x)) stack.push((x as Record<string, unknown>)[k]);
  }
  return v;
}
const ok = (f: () => unknown): boolean => {
  try {
    f();
    return true;
  } catch {
    return false;
  }
};
function limit(test: (n: number) => boolean, hi: number): string {
  let lo = 0;
  if (test(hi)) return `>=${hi}`;
  while (lo < hi - 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (test(mid)) lo = mid;
    else hi = mid;
  }
  return String(lo);
}

it('量測：原生序列化的層數門檻（暫時）', () => {
  const rows = [`node ${process.version} ${process.platform} ${process.arch}`];
  for (const shape of ['object', 'array', 'mixed'] as const) {
    for (const frozen of [false, true]) {
      const make = (n: number) => (frozen ? freeze(build[shape](n)) : build[shape](n));
      const s = limit((n) => ok(() => JSON.stringify(make(n))), 20_000);
      const c = limit((n) => ok(() => structuredClone(make(n))), 20_000);
      rows.push(`${shape} ${frozen ? 'frozen' : 'unfrozen'} stringify=${s} structuredClone=${c}`);
    }
  }
  // console 會被吞，故意丟錯把數字帶到報告上。
  throw new Error(`DEPTH-PROBE-1526 ${rows.join(' | ')}`);
});
