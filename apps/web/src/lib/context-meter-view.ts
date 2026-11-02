/**
 * 用量表要畫的東西（[#528](https://github.com/DemianLi/nexus-agent/issues/528)）：這條對話離自動摘要還有多遠。
 *
 * 資料是 harness 的投影 `ConversationState.contextPressure`（規則見 `@nexus/wire` 的 `context-pressure.ts`）。
 * 這裡只把它換成畫面上的字，照 #528 grilling 的 Q3–Q6：
 *
 * - **`measure` 在才畫**。只有 `inputTokens` 的時候（摘要被關掉的部署）不畫：沒有分母。
 * - **比例的分子跟門檻同源**：`tokens` 那道比 `approxTokens`，`messages` 那道比 `messageCount`。供應商報的
 *   `inputTokens` 算法不同，只放進明細的「目前大小」那一行，不拿來算比例。
 * - **環取最近的那道**，明細每道各一行、照設定的順序。門檻是部署的設定（patch 改得動），一律讀線上給的值，
 *   不寫死 100000／60。
 * - **只算會真的觸發的門檻**（[#1444](https://github.com/DemianLi/nexus-agent/issues/1444)）：`messagesCompactable` 是
 *   `false` 時，`messages` 那道到了也摘不到東西（整串都在原樣保留的尾巴裡，#1441），不算進環、不會是最近那道，明細照列並
 *   標成目前不會觸發。沒有這一格（舊日誌）照沒有這一格以前的算法。每一道都不算時環是 0%，不是不畫：環一消失，看起來像量測壞了。
 * - **組成三行**（#1571 N1193）：有 `breakdown` 才有，寫「約 N」。系統提示與工具定義比總數大時對話夾在 0，三格相加會超過
 *   總數，所以不畫合計，超過時多一句說明。
 * - **百分比無條件捨去**，最多 100：「100%」只在真的到門檻時出現。比例是估算的，所以前面標「約」。
 * - **色階不在這裡**：環照 SG 的 70／90 上色（`ContextRing` 自己算，#1591）；原本 80% 的 `WARNING_RATIO` 只剩用量表在用，
 *   跟著拿掉。
 *
 * @module
 */

import type { WireContextMeasure, WireContextPressure, WireSummaryThreshold } from '@nexus/wire';

/** 明細裡的一道門檻。 */
export interface ThresholdRow {
  readonly type: WireSummaryThreshold['type'];
  /** 例如「約 8.1k／10k token」、「3／4 則」。 */
  readonly text: string;
  /** 環量的就是這一道：比例最高的那道，同分取設定裡排前面的。 */
  readonly nearest: boolean;
  /** 這一道目前不會觸發（`messages` 那道、`messagesCompactable` 是 `false`）：不算進環，也不會是最近那道。 */
  readonly dormant: boolean;
}

/** 明細裡組成的一行。 */
export interface BreakdownRow {
  readonly part: 'system' | 'tools' | 'messages';
  readonly label: string;
  /** 例如「約 8.1k」。 */
  readonly text: string;
}

export interface ContextMeterView {
  /** 環要填多滿，0 到 1。 */
  readonly ratio: number;
  /** 「約 N%」的 N：無條件捨去，最多 100。 */
  readonly percent: number;
  /** 「目前大小」那一行；沒收到 `model/usage` 時沒有這一行。 */
  readonly inputTokens?: string;
  readonly rows: readonly ThresholdRow[];
  /** 組成三行；舊日誌或還沒量過時沒有這一格。 */
  readonly breakdown?: readonly BreakdownRow[];
  /** 三格相加比總數大時的說明。 */
  readonly breakdownNote?: string;
  /** 明細底下那句：有沒有會觸發的門檻，說法不同。 */
  readonly note: string;
}

/** 不會觸發的那一行底下那句。 */
export const DORMANT_ROW_TEXT = '整串都在原樣保留的範圍內，這道目前不會觸發';

/** 明細底下那句：每一道都會觸發時。 */
export const NOTE_ALL_ACTIVE = '到了任何一道門檻，較早的訊息會被摘要成一段。比例是估算的。';
/** 有一道以上不會觸發、但還有會觸發的。 */
export const NOTE_SOME_DORMANT = '到了會觸發的門檻，較早的訊息會被摘要成一段。比例是估算的。';
/** 一道會觸發的都沒有：環是 0%。 */
export const NOTE_NONE_ACTIVE = '目前沒有會觸發的門檻，不會自動摘要。';

/** 系統提示加工具定義就超過總數時，組成底下那句。 */
export const BREAKDOWN_OVER_TEXT =
  '系統提示與工具定義是另外估的，比總數大，所以三行相加不等於總數。';

const breakdownOf = (measure: WireContextMeasure) => {
  const { breakdown, approxTokens } = measure;
  if (breakdown === undefined) return {};
  const { systemTokens, toolsTokens, messageTokens } = breakdown;
  const about = (count: number) => `約 ${compact(count)}`;
  return {
    breakdown: [
      { part: 'system', label: '系統提示', text: about(systemTokens) },
      { part: 'tools', label: '工具定義', text: about(toolsTokens) },
      { part: 'messages', label: '對話', text: about(messageTokens) },
    ],
    ...(systemTokens + toolsTokens > approxTokens ? { breakdownNote: BREAKDOWN_OVER_TEXT } : {}),
  } as const;
};

/** `null`：不畫。 */
export function contextMeterView(pressure: WireContextPressure | null): ContextMeterView | null {
  const measure = pressure?.measure;
  if (measure === undefined) return null;
  // 只有明講 `false` 才算不會觸發；沒有這一格（舊日誌）照舊。
  const dormant = (threshold: WireSummaryThreshold) =>
    threshold.type === 'messages' && measure.messagesCompactable === false;
  // 不會觸發的那道記成 -1：不會贏過任何一道會觸發的（比例最小是 0）。
  const ratios = measure.thresholds.map((threshold) =>
    dormant(threshold)
      ? -1
      : (threshold.type === 'tokens' ? measure.approxTokens : measure.messageCount) /
        threshold.value,
  );
  // 線上保證至少一道（折疊器不收空陣列）；每一道都不會觸發時沒有最近那道，環是 0。
  const top = Math.max(...ratios);
  const nearest = top < 0 ? -1 : ratios.indexOf(top);
  const rows = measure.thresholds.map((threshold, index) => ({
    type: threshold.type,
    text:
      threshold.type === 'tokens'
        ? `約 ${compact(measure.approxTokens)}／${compact(threshold.value)} token`
        : `${measure.messageCount}／${threshold.value} 則`,
    nearest: index === nearest,
    dormant: dormant(threshold),
  }));
  const ratio = Math.min(Math.max(top, 0), 1);
  const dormantCount = rows.filter((row) => row.dormant).length;
  return {
    ratio,
    percent: Math.floor(ratio * 100),
    ...(pressure?.inputTokens === undefined
      ? {}
      : { inputTokens: `${pressure.inputTokens.toLocaleString('en-US')} token` }),
    rows,
    ...breakdownOf(measure),
    note:
      dormantCount === 0
        ? NOTE_ALL_ACTIVE
        : dormantCount === rows.length
          ? NOTE_NONE_ACTIVE
          : NOTE_SOME_DORMANT,
  };
}

/** 觸發按鈕的名稱：畫面上那串「約 N%」原樣出現在裡面，用語音控制的人照畫面唸得出來。 */
export function contextMeterLabel(view: ContextMeterView): string {
  return `對話用量：${percentText(view)}，點開看明細`;
}

/** 收著時畫面上那串字。 */
export function percentText(view: ContextMeterView): string {
  return `約 ${view.percent}%`;
}

/**
 * 42123 → 「42k」、8123 → 「8.1k」、950 → 「950」、1500000 → 「1.5M」。門檻與估算值都是這個寫法，兩邊才比得起來。
 */
export function compact(count: number): string {
  if (count < 1000) return String(count);
  // 捨入後會變成「1000k」的那一段直接進位成 M。
  const [value, unit] = count < 999_500 ? [count / 1000, 'k'] : [count / 1_000_000, 'M'];
  // 一位數才留一位小數。`Number` 拿掉「10.0」這種尾巴。
  return `${Number(value.toFixed(value < 10 ? 1 : 0))}${unit}`;
}
