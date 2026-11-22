/**
 * 頂列那顆「這條對話的用量」要畫什麼（[#574](https://github.com/DemianLi/nexus-agent/issues/574)）。資料是
 * `ConversationState.tokenUsage`／`sessionStats`，規則寫在 `@nexus/wire` 的 `session-totals.ts` 檔頭。
 *
 * 顯示條件照 dsh `StatsPills`（`packages/client/ui-chat/src/client/chat/StatsPills.tsx`，`477b4f4`）：
 *
 * - **有 token** 指輸入或輸出大於 0（`:330`）。模型呼叫全都沒報用量時，收著與點開都只畫次數，不給 `total`。
 * - **一次模型呼叫都沒結束、也沒有 token，整顆不畫**（`:347`）。`null` 當成 dsh 的「全是 0」。
 *
 * 跟 dsh 不同的地方，都是 #574 定過的 UI 形狀：
 *
 * - dsh 是輸入框底列兩顆 pill，這裡**併成頂列一顆**。平常顯示總量，沒有 token 時退成次數，跟 dsh
 *   只剩時間那顆時一樣；點開只有精確總數與成本分頁的入口，明細只在成本分頁（#3036 第 6 條）。
 * - **四桶互不重疊**（[#724](https://github.com/DemianLi/nexus-agent/issues/724)，照 dsh `usage-projection`）：輸入（未快取）、
 *   快取讀、快取寫、輸出，**合計是四項相加，不再靠 `inputTokens` 含不含快取**（{@link usageBuckets}）。server 有送
 *   `uncachedInputTokens` 就走這條，所以 `inputTokens` 之後改成只算未快取，畫面的數字不變；沒送的舊 server 退回讀
 *   `inputTokens`（含快取讀取，兩格快取是它的明細）。
 * - **快取讀、快取寫缺席時各處畫 {@link NOT_RECORDED}，不畫 0**——舊日誌、供應商沒報快取細節的呼叫、還沒寫這兩格的 server 都沒有，而 0 是
 *   「記了、沒命中」，兩件事分開（以後算命中率的分母不能混進沒記的）；沒記的那一項在合計裡不加。
 * - **沒有首字延遲與輸出速度**：我們沒記串流第一個 token 的時間。
 *
 * @module
 */

import type { WireSessionStats, WireTokenUsage } from '@nexus/wire';

import { compact } from '@/shared/lib/context-meter-view';

/**
 * 一份總帳分成的幾桶，畫面上每個地方的數字都從這裡來。
 *
 * - **新 server**（有 `uncachedInputTokens`）：`input` 是未快取的輸入，與快取讀、快取寫、輸出互不重疊，`total` 是四項相加
 *   （沒記的快取那一項不加）。**完全不讀 `inputTokens`**。
 * - **舊 server**（沒有）：`input` 是 `inputTokens`（含快取讀取），兩格快取是它的明細已含在裡面，`total` 是輸入加輸出。
 */
export interface UsageBuckets {
  readonly input: number;
  /** 命中快取讀出來的輸入；沒記是 `undefined`。 */
  readonly cacheRead: number | undefined;
  /** 寫進快取的輸入；沒記是 `undefined`。 */
  readonly cacheWrite: number | undefined;
  readonly output: number;
  readonly total: number;
  /** `true`：`input` 含快取（舊 server），兩格快取是它的明細，不另加進 `total`。 */
  readonly cacheInInput: boolean;
}

export function usageBuckets(tokenUsage: WireTokenUsage | null): UsageBuckets {
  const output = tokenUsage?.outputTokens ?? 0;
  const cacheRead = tokenUsage?.cacheReadTokens;
  const cacheWrite = tokenUsage?.cacheWriteTokens;
  const uncached = tokenUsage?.uncachedInputTokens;
  if (uncached !== undefined) {
    return {
      input: uncached,
      cacheRead,
      cacheWrite,
      output,
      total: uncached + (cacheRead ?? 0) + (cacheWrite ?? 0) + output,
      cacheInInput: false,
    };
  }
  const input = tokenUsage?.inputTokens ?? 0;
  return { input, cacheRead, cacheWrite, output, total: input + output, cacheInInput: true };
}

/**
 * 快取命中率（[#724](https://github.com/DemianLi/nexus-agent/issues/724)，PM 拍板要畫）：快取讀 ÷（未快取＋快取讀＋快取寫），
 * 是整段帳加起來的比例，不是各次呼叫比例的平均。分母就是整筆輸入（舊 server 的 `inputTokens` 本來就含兩格快取）。
 *
 * - `undefined`：不畫。兩個快取桶都沒記（server 根本不記快取），或整筆輸入是 0（除不了）。
 * - `'unrecorded'`：**只記了其中一桶**，另一桶沒記，分母不完整，寫「沒記」，**不寫 0%**——0% 是「記了、一次都沒命中」。
 * - `number`：0 到 1。
 */
export type CacheHitRate = number | 'unrecorded' | undefined;

export function cacheHitRate(buckets: UsageBuckets): CacheHitRate {
  const { cacheRead, cacheWrite } = buckets;
  if (cacheRead === undefined && cacheWrite === undefined) return undefined;
  if (cacheRead === undefined || cacheWrite === undefined) return 'unrecorded';
  const prompt = buckets.cacheInInput ? buckets.input : buckets.input + cacheRead + cacheWrite;
  return prompt > 0 ? cacheRead / prompt : undefined;
}

/** 命中率寫成字：小數一位（`62.4%`）；沒記寫 {@link NOT_RECORDED}。 */
export function cacheHitRateText(rate: Exclude<CacheHitRate, undefined>): string {
  return rate === 'unrecorded' ? NOT_RECORDED : `${(rate * 100).toFixed(1)}%`;
}

export interface SessionUsageView {
  /** 收著時那顆上的字。 */
  readonly label: string;
  /** 按鈕的名稱（給報讀）。 */
  readonly ariaLabel: string;
  /** 點開後的精確總數；沒有 token 時不給。明細只在成本分頁。 */
  readonly total?: string;
}

/** 快取桶或命中率缺席時畫的字（缺席＝沒記，不是 0）。 */
export const NOT_RECORDED = '沒記';

/** 快取桶的數字寫成字：缺席寫 {@link NOT_RECORDED}（不是 0）。 */
export function cacheCountText(count: number | undefined): string {
  return count === undefined ? NOT_RECORDED : exactTokens(count);
}

/** 精確的 token 數，千分位：`412,380 token`。 */
export function exactTokens(count: number): string {
  return `${count.toLocaleString('en-US')} token`;
}

/** 照 dsh `formatDuration`：一分鐘內到小數一位（`45.2 秒`），之後取整到秒（`2 分 42 秒`）。 */
export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${Math.round(seconds * 10) / 10} 秒`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)} 分 ${whole % 60} 秒`;
}

export function sessionUsageView(
  tokenUsage: WireTokenUsage | null,
  sessionStats: WireSessionStats | null,
): SessionUsageView | null {
  const buckets = usageBuckets(tokenUsage);
  const hasTokens = buckets.total > 0;
  const steps = sessionStats?.steps ?? 0;
  if (steps === 0 && !hasTokens) return null;
  const label = hasTokens
    ? `${compact(buckets.total)} token`
    : `${sessionStats!.turns} 輪／${steps} 次`;
  return {
    label,
    ariaLabel: `這條對話的用量：${label}，點開看明細`,
    ...(hasTokens ? { total: exactTokens(buckets.total) } : {}),
  };
}
