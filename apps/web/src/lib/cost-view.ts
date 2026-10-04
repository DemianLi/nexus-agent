/**
 * 右側欄「成本」分頁要畫什麼（[#1032](https://github.com/DemianLi/nexus-agent/issues/1032)，第 0 版）。
 *
 * **數字來自總帳，不是從畫面上加的**：`ConversationState.tokenUsage`／`sessionStats` 是 root 日誌整份折出來的值（規則在
 * `@nexus/wire` 的 `session-totals.ts`），畫面是分頁載入、會被摘要改寫，從 `entries` 加會算錯。所以 `entries` 是空的、或只
 * 載入了一頁，這裡的數字照樣等於 frame 的值（`cost-view.test.ts`）。`entries` 只用來數壓縮次數與找背景子代理，兩者都標明
 * 「只算已載入的」。
 *
 * **口徑寫在畫面上**（{@link COST_LIMITS}）：這一版不畫金額（端點不回報單價）、不畫完成率（沒有任務成功的判準）、不畫
 * 「本輪」與工具次數（即時 `model/usage` 只帶輸入，算不出逐輪輸出；`sessionStats` 沒有工具次數這一格），這些等第 1 版。
 *
 * @module
 */

import type {
  ConversationState,
  WireContextPressure,
  WireSessionStats,
  WireTokenUsage,
} from '@nexus/wire';

import { contextMeterView, percentText } from '@/lib/context-meter-view';
import { exactTokens, formatDuration } from '@/lib/session-usage-view';

export type CostRow = readonly [label: string, value: string];

/** 分頁頂上那一句。 */
export const COST_HEADLINE = '第 0 版：只用現有的總帳，不畫金額、不畫完成率';

export const COST_LIMITS_HEADING = '口徑';

/**
 * 這一版數字的口徑，全部寫在畫面上。`key` 是 `data-limit`，測試用它對。
 *
 * - `scope`：主對話那份總帳的缺口，出處在 `packages/nexus-core/src/token-usage.ts` 檔頭（失敗與中止的呼叫不進帳、生摘要那次不
 *   進帳）與 `apps/harness/src/session-title-llm.ts`（標題呼叫在 agent 之外，不寫 `model/usage`）。**失敗呼叫進帳由 #1022 改變，
 *   #1034 負責在它合併後改寫這句。**
 * - `time`：模型耗時含重試退避與失敗呼叫的時間；工具耗時不含等人核准（`session-totals.ts`）。
 */
export const COST_LIMITS = {
  scope:
    '這裡的 token 只是主對話那一份總帳：不含任何子代理（背景的在下面分列，前景的目前沒有數字）、不含生摘要的那一次、不含生標題的那一次，也不含失敗或中止的呼叫。',
  input: '輸入含快取讀取，所以輸入加輸出就是整筆帳。',
  time: '模型耗時含重試退避與失敗呼叫的時間；工具耗時不含等人核准。',
  loaded:
    '壓縮次數與背景子代理的分列只算已載入的對話：更早的在對話裡上捲、載入之後才會出現在這裡。',
  subagent: '背景子代理的數字是讀取當下的，它還在跑就會繼續增加；按「重新讀取」更新。',
  absent:
    '沒有金額（端點不回報單價）、沒有完成率（沒有任務成功的判準），也還沒有「本輪」與工具次數，這幾項等第 1 版。',
} as const;

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
  const input = tokenUsage?.inputTokens ?? 0;
  const output = tokenUsage?.outputTokens ?? 0;
  const hasTokens = input > 0 || output > 0;
  const hasStats = sessionStats !== null && sessionStats.steps > 0;
  return {
    ...(hasTokens
      ? {
          tokens: [
            ['輸入', exactTokens(input)],
            ['輸出', exactTokens(output)],
            ['合計', exactTokens(input + output)],
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

/** 已載入的壓縮次數。 */
export function compactionCount(entries: ConversationState['entries']): number {
  let count = 0;
  for (const entry of entries) if (entry.kind === 'compaction') count += 1;
  return count;
}
