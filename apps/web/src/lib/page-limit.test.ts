import { describe, expect, it } from 'vitest';

import type { PageLimit, PageOutcome } from '@/lib/page-limit';
import { INITIAL_PAGE_LIMIT, stepPageLimit } from '@/lib/page-limit';

/**
 * 413 之後送多少 `limit`（#555）。
 *
 * **主角是「永遠不會把一個超過 `maxLines` 的 `limit` 變成畫面上的 400」**：web 看不到 `maxLines`，送錯了
 * 路由回 400，畫面就是「座標不對」（#543 為此才不送 `limit`）。逐條規則之外，底下用一個照路由規則回應的
 * 假 server 把整個檔讀完。
 */

const page = (lines: number, eof = false): PageOutcome => ({ kind: 'page', lines, eof });
const TOO_LARGE: PageOutcome = { kind: 'too-large' };
const INVALID: PageOutcome = { kind: 'invalid' };
const at = (state: Partial<PageLimit>): PageLimit => ({ ...INITIAL_PAGE_LIMIT, ...state });

describe('stepPageLimit', () => {
  it('不送 limit、沒到檔尾：那一頁的 lines 就是 cap', () => {
    expect(stepPageLimit(INITIAL_PAGE_LIMIT, page(5000))).toEqual({
      next: 'done',
      state: at({ cap: 5000 }),
    });
    // 到檔尾的那一頁可能比較短，不能當 cap。
    expect(stepPageLimit(INITIAL_PAGE_LIMIT, page(12, true)).state.cap).toBeUndefined();
  });

  it('縮：知道 cap 從一半開始，不知道從 1 開始，之後對半', () => {
    expect(stepPageLimit(at({ cap: 5000 }), TOO_LARGE)).toEqual({
      next: 'retry',
      state: at({ cap: 5000, limit: 2500 }),
    });
    expect(stepPageLimit(INITIAL_PAGE_LIMIT, TOO_LARGE).state.limit).toBe(1);
    expect(stepPageLimit(at({ cap: 5000, limit: 2500 }), TOO_LARGE).state.limit).toBe(1250);
    expect(stepPageLimit(at({ cap: 1 }), TOO_LARGE).state.limit).toBe(1);
  });

  it('limit=1 還是 413：這一行本身超長，之後恢復不送', () => {
    expect(stepPageLimit(at({ cap: 5000, limit: 1 }), TOO_LARGE)).toEqual({
      next: 'long-line',
      state: at({ cap: 5000 }),
    });
  });

  it('cap 還不知道：縮到讀得到之後，下一頁先試一次不送', () => {
    expect(stepPageLimit(at({ limit: 1 }), page(1))).toEqual({
      next: 'done',
      state: at({ good: 1, probed: true }),
    });
  });

  it('之後每讀到一頁就加倍，碰到 cap 恢復不送', () => {
    expect(stepPageLimit(at({ cap: 5000, limit: 1250 }), page(1250)).state.limit).toBe(2500);
    expect(stepPageLimit(at({ cap: 5000, limit: 2500 }), page(2500)).state.limit).toBeUndefined();
    expect(stepPageLimit(at({ probed: true, limit: 8 }), page(8)).state.limit).toBe(16);
  });

  it('加倍時的 400：cap 還不知道、L 又比證明過的大，才歸因成超過 maxLines', () => {
    expect(stepPageLimit(at({ probed: true, good: 8, limit: 16 }), INVALID)).toEqual({
      next: 'retry',
      state: at({ probed: true, good: 8, cap: 8, limit: 8 }),
    });
  });

  it.each([
    ['不送 limit', at({})],
    ['cap 已知', at({ cap: 5000, good: 8, limit: 16 })],
    ['L 沒比證明過的大', at({ probed: true, good: 16, limit: 16 })],
    ['還沒有任何一次成功', at({ limit: 1 })],
  ])('其他的 400 照舊是 bug：%s', (_, state) => {
    expect(stepPageLimit(state, INVALID)).toEqual({ next: 'invalid', state });
  });
});

/**
 * 照路由的規則回應：`limit` 超過 `maxLines` 是 400，一頁超過 `maxBytes` 是 413（**拒絕不是截斷**），
 * 行與行之間的換行算一個位元組。
 */
function serve(sizes: readonly number[], maxLines: number, maxBytes: number) {
  return (offset: number, limit: number | undefined): PageOutcome => {
    if (limit !== undefined && limit > maxLines) return INVALID;
    const take = sizes.slice(offset, offset + (limit ?? maxLines));
    const bytes = take.reduce((sum, size) => sum + size, 0) + Math.max(0, take.length - 1);
    if (bytes > maxBytes) return TOO_LARGE;
    return page(take.length, offset + take.length >= sizes.length);
  };
}

/** 從頭讀到尾，照 store 的用法走 {@link stepPageLimit}：長行當成一行讀掉（位元組窗口那一段不在這裡）。 */
function drive(sizes: readonly number[], maxLines: number, maxBytes: number) {
  const respond = serve(sizes, maxLines, maxBytes);
  let state = INITIAL_PAGE_LIMIT;
  let offset = 0;
  let requests = 0;
  let absorbed = 0;
  const longLines: number[] = [];
  while (offset < sizes.length) {
    requests += 1;
    if (requests > 10_000) throw new Error('沒有收斂');
    const outcome = respond(offset, state.limit);
    if (outcome.kind === 'invalid') absorbed += 1;
    const step = stepPageLimit(state, outcome);
    if (step.next === 'invalid') {
      throw new Error(`第 ${offset} 行回了 400（limit=${String(state.limit)}）`);
    }
    state = step.state;
    if (step.next === 'long-line') {
      longLines.push(offset);
      offset += 1;
    } else if (step.next === 'done' && outcome.kind === 'page') {
      offset += outcome.lines;
    }
  }
  return { requests, absorbed, longLines };
}

describe('照路由規則的假 server 讀完整個檔', () => {
  const MIB = 1024 * 1024;

  it.each([
    ['每行 500 B、第一頁就 413、maxLines 5000', Array(12_000).fill(500), 5000],
    ['每行 520 B、maxLines 4097：第一頁 413，加倍到 4096 又 413', Array(20_000).fill(520), 4097],
    [
      '前面短、中間一段中長行、後面短',
      [...Array(6000).fill(10), ...Array(9000).fill(700), ...Array(6000).fill(10)],
      5000,
    ],
    [
      '中間夾兩條超過上限的長行',
      [...Array(100).fill(10), 3 * MIB, 5, 3 * MIB, ...Array(100).fill(10)],
      5000,
    ],
    ['第一行就超長', [3 * MIB, ...Array(10).fill(10)], 5000],
    ['長行後面接中長行', [...Array(10).fill(10), 3 * MIB, ...Array(8000).fill(600)], 5000],
  ])('%s：不會出現 400，行都接得上', (_, sizes, maxLines) => {
    const result = drive(sizes, maxLines, 2 * MIB);
    const long = sizes.flatMap((size, i) => (size > 2 * MIB ? [i] : []));
    expect(result.longLines).toEqual(long);
  });

  it('第一頁就 413、後面變短：加倍撞到 maxLines 的 400 在裡面消化掉', () => {
    // maxLines 3：前三行各 1 MiB 讀不成一頁，之後的短行讓 limit 一路加倍到超過 3。
    const sizes = [MIB, MIB, MIB, ...Array(100).fill(10)];
    const result = drive(sizes, 3, 2 * MIB);
    expect(result.absorbed).toBeGreaterThan(0);
    expect(result.longLines).toEqual([]);
  });

  it('請求數有上界：一段中長行不會退化成一行一個請求', () => {
    // 12000 行、每行 500 B：理想是每頁約 4194 行、3 頁。
    const { requests } = drive(Array(12_000).fill(500), 5000, 2 * 1024 * 1024);
    expect(requests).toBeLessThan(40);
  });
});
