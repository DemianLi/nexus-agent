/**
 * {@link ./mcp-pool-agg-1947.ts} 測試用的合成數據：形狀同 #1947 的 `run1.json`、`run2.json`（各 12 回合、四臂、暖機 5 輪＋量測 40 輪），
 * 數值由固定種子產生。`mcp-pool-agg-1947.expected.txt` 是 `agg.py` 吃這份數據印出來的報告，產生方式見測試檔。
 *
 * 刻意埋了：run1 r7 L 第 20 輪 failed、run2 r4 SK 第 9 輪 load 3.25、SF 第 30 輪 llmReq 5、run2 r9 SF 沒逐出，
 * 讓 `agg.py` 的每種標記與 Counter repr 都印得出來。
 */

import { PyRandom } from './mcp-pool-stats.js';

const ARMS = ['L', 'SK', 'SF', 'SF2'] as const;

/** 小數兩位，同驅動寫出的精度。 */
const two = (x: number): number => Math.round(x * 100) / 100;

/** 合成的 `[tag, results]`，`results` 裡夾一列不是回合的（`label` 不以 `round` 開頭），彙總要跳過它。 */
export function synthetic1947Runs(): [string, unknown[]][] {
  const rnd = new PyRandom(2570);
  const u = (): number => rnd.getrandbits(32) / 2 ** 32;
  return ['run1', 'run2'].map((tag, run): [string, unknown[]] => {
    const results: unknown[] = [{ label: 'start', round: 0 }];
    for (let round = 1; round <= 12; round++) {
      const turns: Record<string, unknown[]> = {};
      for (const [a, armIndex] of ARMS.map((name, i) => [name, i] as const)) {
        const base = [60, 75, 50, 51][armIndex] ?? 50;
        turns[a] = Array.from({ length: 45 }, (_, i) => {
          const warm = i < 5;
          const k = i + 1;
          const main = two(base * (0.8 + 0.4 * u()) + (warm ? 30 : 0));
          const node = two(4 + 3 * u());
          const by: Record<string, number> = { total: 0, node, main };
          if (u() < 0.7) by['libuv-worker'] = two(2 * u());
          if (k % 7 === 0) by.V8 = two(u());
          by.total = two(main + node + (by['libuv-worker'] ?? 0) + (by.V8 ?? 0));
          const load = run === 1 && round === 4 && a === 'SK' && k === 9 ? 3.25 : two(0.2 + u());
          return {
            k,
            warm,
            pos: (k + round) % 4,
            wallMs: two(120 + 40 * u()),
            cpuMs: by.total,
            by,
            events: 80 + Math.floor(10 * u()),
            outcome: run === 0 && round === 7 && a === 'L' && k === 20 ? 'failed' : 'completed',
            llmReq: k === 1 || (k >= 10 && (k - 10) % 3 === 0) ? 4 : k === 30 && a === 'SF' ? 5 : 3,
            la: `${load.toFixed(2)} 0.25 0.20 1/375 108`,
          };
        });
      }
      results.push({
        label: `round${round}`,
        round,
        laBefore: '0.30 0.25 0.20 1/375 108',
        laAfter: '0.31 0.25 0.20 1/375 108',
        L: { readyMs: round === 2 ? 600 : two(600 + 20 * u()), startupCpuMs: two(840 + 30 * u()) },
        open: {},
        memBefore: {},
        memAfter: Object.fromEntries(
          ARMS.map((a) => [
            a,
            { rssMB: two(300 + 10 * u()), anonMB: two(230 + 10 * u()), threads: 11 },
          ]),
        ),
        evict: {
          SF: { ok: !(run === 1 && round === 9), waitedMs: 3600, missing: 0 },
          SF2: { ok: true, waitedMs: 3610, missing: 0 },
        },
        turns,
      });
    }
    return [tag, results];
  });
}
