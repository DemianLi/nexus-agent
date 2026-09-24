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
 * - **百分比無條件捨去**，最多 100：「100%」只在真的到門檻時出現。比例是估算的，所以前面標「約」。
 * - **80% 以上變警示色**，同 dsh 的 `thresholdRatio` 預設 0.8。
 *
 * @module
 */

import type { WireContextPressure, WireSummaryThreshold } from '@nexus/wire';

/** 到了這個比例就變警示色（含）。 */
export const WARNING_RATIO = 0.8;

/** 明細裡的一道門檻。 */
export interface ThresholdRow {
  readonly type: WireSummaryThreshold['type'];
  /** 例如「約 8.1k／10k token」、「3／4 則」。 */
  readonly text: string;
  /** 環量的就是這一道：比例最高的那道，同分取設定裡排前面的。 */
  readonly nearest: boolean;
}

export interface ContextMeterView {
  /** 環要填多滿，0 到 1。 */
  readonly ratio: number;
  /** 「約 N%」的 N：無條件捨去，最多 100。 */
  readonly percent: number;
  readonly warning: boolean;
  /** 「目前大小」那一行；沒收到 `model/usage` 時沒有這一行。 */
  readonly inputTokens?: string;
  readonly rows: readonly ThresholdRow[];
}

/** `null`：不畫。 */
export function contextMeterView(pressure: WireContextPressure | null): ContextMeterView | null {
  const measure = pressure?.measure;
  if (measure === undefined) return null;
  const ratios = measure.thresholds.map(
    (threshold) =>
      (threshold.type === 'tokens' ? measure.approxTokens : measure.messageCount) / threshold.value,
  );
  // 線上保證至少一道（折疊器不收空陣列），所以 `nearest` 一定找得到。
  const top = Math.max(...ratios);
  const nearest = ratios.indexOf(top);
  const rows = measure.thresholds.map((threshold, index) => ({
    type: threshold.type,
    text:
      threshold.type === 'tokens'
        ? `約 ${compact(measure.approxTokens)}／${compact(threshold.value)} token`
        : `${measure.messageCount}／${threshold.value} 則`,
    nearest: index === nearest,
  }));
  const ratio = Math.min(top, 1);
  return {
    ratio,
    percent: Math.floor(ratio * 100),
    warning: top >= WARNING_RATIO,
    ...(pressure?.inputTokens === undefined
      ? {}
      : { inputTokens: `${pressure.inputTokens.toLocaleString('en-US')} token` }),
    rows,
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
