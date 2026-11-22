/**
 * 右側欄「成本」分頁要畫什麼（[#1032](https://github.com/DemianLi/nexus-agent/issues/1032)，第 0 版）。
 *
 * **這個檔是第 0 版**，只在沒有用量投影（#1028，`features/cost/token-meter-view.ts`）時用：舊伺服器、插件關了、拋過、版本不認得。
 * 有投影時畫面整個換成逐輪的那一套，數字不再混這裡的兩顆總帳。
 *
 * **數字來自總帳，不是從畫面上加的**：`ConversationState.tokenUsage`／`sessionStats` 是 root 日誌整份折出來的值（規則在
 * `@nexus/wire` 的 `session-totals.ts`），畫面是分頁載入、會被摘要改寫，從 `entries` 加會算錯。所以 `entries` 是空的、或只
 * 載入了一頁，這裡的數字照樣等於 frame 的值（`cost-view.test.ts`）。`entries` 只用來數壓縮次數與找背景子代理，兩者都標明
 * 「只算已載入的」。
 *
 * **口徑不在畫面上**，在 `docs/operations.md`〈成本與觀測分頁的口徑與限制〉：這一版不畫金額、完成率、「本輪」與工具次數。
 *
 * @module
 */

import type {
  ConversationState,
  WireContextPressure,
  WireSessionStats,
  WireTokenUsage,
} from '@nexus/wire';

import { contextMeterView, percentText } from '@/shared/lib/context-meter-view';
import {
  cacheCountText,
  cacheHitRate,
  cacheHitRateText,
  exactTokens,
  formatDuration,
  usageBuckets,
} from '@/shared/lib/usage-view';

export type CostRow = readonly [label: string, value: string];

export interface UsageSections {
  /** token 那一段；一次都沒有回報用量（輸入輸出都是 0）就沒有。 */
  readonly tokens?: readonly CostRow[];
  /** 輪數、模型呼叫、耗時；一次模型呼叫都沒結束就沒有。 */
  readonly stats?: readonly CostRow[];
}

/**
 * 一份總帳（root 的或某個子代理的）換成兩段列。條件同頂列用量鈕（`sessionUsageView`，照 dsh `StatsPills`）：token 要大於 0 才算
 * 有、時間那段要至少一次模型呼叫結束，`null` 當成「全是 0」。兩段都沒有時回兩個都不給，由畫面講「還沒有用量」。
 */
export function usageSections(
  tokenUsage: WireTokenUsage | null,
  sessionStats: WireSessionStats | null,
): UsageSections {
  const buckets = usageBuckets(tokenUsage);
  const hasTokens = buckets.total > 0;
  const hasStats = sessionStats !== null && sessionStats.steps > 0;
  const hitRate = cacheHitRate(buckets);
  return {
    ...(hasTokens
      ? {
          tokens: [
            ['輸入', exactTokens(buckets.input)],
            // 舊 server 的快取兩格是輸入的明細（已含在輸入裡），不另列；新 server 的四桶互不重疊，各列一行，沒記畫「沒記」。
            ...(buckets.cacheInInput
              ? []
              : ([
                  ['快取讀', cacheCountText(buckets.cacheRead)],
                  ['快取寫', cacheCountText(buckets.cacheWrite)],
                ] satisfies readonly CostRow[])),
            ['輸出', exactTokens(buckets.output)],
            ['合計', exactTokens(buckets.total)],
            ...(hitRate === undefined
              ? []
              : ([['快取命中率', cacheHitRateText(hitRate)]] satisfies readonly CostRow[])),
          ] satisfies readonly CostRow[],
        }
      : {}),
    ...(hasStats
      ? {
          stats: [
            ['輪數', `${sessionStats.turns}`],
            ['模型呼叫', `${sessionStats.steps} 次`],
            ['模型耗時', formatDuration(sessionStats.llmMs)],
            ['工具耗時', formatDuration(sessionStats.toolMs)],
          ] satisfies readonly CostRow[],
        }
      : {}),
  };
}

/** 目前 context 多大、離自動摘要多遠（`ContextMeter` 同源）；摘要關掉、或還沒收到就是 `undefined`。 */
export function contextRows(pressure: WireContextPressure | null): readonly CostRow[] | undefined {
  const view = contextMeterView(pressure);
  if (view === null) return undefined;
  return [
    ['離自動摘要', percentText(view)],
    ...(view.inputTokens === undefined ? [] : [['目前大小', view.inputTokens] as const]),
    ...view.rows.map(
      (row) =>
        [row.type === 'tokens' ? 'token 門檻' : '訊息門檻', row.text] as const satisfies CostRow,
    ),
  ];
}

/** 「目前的 context」那一段：context 的列（有的話）加上已載入的壓縮次數，所以這一段一定有列。 */
export function contextSectionRows(
  pressure: WireContextPressure | null,
  compactions: number,
): readonly CostRow[] {
  return [...(contextRows(pressure) ?? []), ['已載入的壓縮次數', `${compactions} 次`]];
}

/** 已載入的壓縮次數。 */
export function compactionCount(entries: ConversationState['entries']): number {
  let count = 0;
  for (const entry of entries) if (entry.kind === 'compaction') count += 1;
  return count;
}
