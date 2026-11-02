/**
 * 頂列那顆「這條對話的用量」要畫什麼（[#574](https://github.com/DemianLi/nexus-agent/issues/574)）。資料是
 * `ConversationState.tokenUsage`／`sessionStats`，規則寫在 `@nexus/wire` 的 `session-totals.ts` 檔頭。
 *
 * 顯示條件照 dsh `StatsPills`（`packages/client/ui-chat/src/client/chat/StatsPills.tsx`，`477b4f4`）：
 *
 * - **有 token** 指輸入或輸出大於 0（`:330`）。模型呼叫全都沒報用量時，只畫次數，不畫用量那一段。
 * - **一次模型呼叫都沒結束、也沒有 token，整顆不畫**（`:347`）。`null` 當成 dsh 的「全是 0」。
 * - 時間那兩列**大於 0 才列**（`:201-212`）。
 *
 * 跟 dsh 不同的地方，都是 #574 定過的 UI 形狀：
 *
 * - dsh 是輸入框底列兩顆 pill，這裡**併成頂列一顆**，點開分兩段。平常顯示總量，沒有 token 時退成次數，跟 dsh
 *   只剩時間那顆時一樣。
 * - **四桶互不重疊**（[#724](https://github.com/DemianLi/nexus-agent/issues/724)，照 dsh `usage-projection`）：輸入（未快取）、
 *   快取讀、快取寫、輸出，**合計是四項相加，不再靠 `inputTokens` 含不含快取**（{@link usageBuckets}）。server 有送
 *   `uncachedInputTokens` 就走這條，所以 `inputTokens` 之後改成只算未快取，畫面的數字不變；沒送的舊 server 退回讀
 *   `inputTokens`（含快取讀取，兩格快取是它的明細）。
 * - **快取讀、快取寫缺席畫「沒記」，不畫 0**——舊日誌、供應商沒報快取細節的呼叫、還沒寫這兩格的 server 都沒有，而 0 是
 *   「記了、沒命中」，兩件事分開（以後算命中率的分母不能混進沒記的）；沒記的那一項在合計裡不加。
 * - **沒有首字延遲與輸出速度**：我們沒記串流第一個 token 的時間。
 *
 * @module
 */

import type { WireSessionStats, WireTokenUsage } from '@nexus/wire';

import { compact } from '@/lib/context-meter-view';

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
  /** 用量那一段；沒有 token 時不給。 */
  readonly usage?: {
    readonly total: string;
    readonly input: string;
    readonly output: string;
    /** 命中快取讀出來的那部分輸入；沒記畫 {@link NOT_RECORDED}。 */
    readonly cacheRead: string;
    /** 寫進快取的那部分輸入；沒記畫 {@link NOT_RECORDED}。 */
    readonly cacheWrite: string;
    /** 兩格底下那一句說明：有記時講已含在輸入裡，有沒記的時講沒記不是 0。 */
    readonly cacheNote: string;
  };
  /** 時間那一段；一次模型呼叫都沒結束時不給。 */
  readonly time?: { readonly counts: string; readonly llm?: string; readonly tool?: string };
}

/** 快取那兩格缺席時畫的字（缺席＝沒記，不是 0）。 */
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

  const { cacheRead, cacheWrite } = buckets;
  const unrecorded = cacheRead === undefined || cacheWrite === undefined;
  const usage = hasTokens
    ? {
        total: exactTokens(buckets.total),
        input: exactTokens(buckets.input),
        output: exactTokens(buckets.output),
        cacheRead: cacheRead === undefined ? NOT_RECORDED : exactTokens(cacheRead),
        cacheWrite: cacheWrite === undefined ? NOT_RECORDED : exactTokens(cacheWrite),
        cacheNote: unrecorded
          ? buckets.cacheInInput
            ? '「沒記」是這台 server 沒有記錄，不是 0。'
            : '「沒記」是這台 server 沒有記錄，不是 0；合計不含沒記的那一項。'
          : buckets.cacheInInput
            ? '快取讀、快取寫已含在輸入裡。'
            : '輸入是未快取的部分；輸入、快取讀、快取寫、輸出互不重疊，合計是四項相加。',
      }
    : undefined;
  const time =
    sessionStats !== null && steps > 0
      ? {
          counts: `${sessionStats.turns} 輪／${steps} 次`,
          ...(sessionStats.llmMs > 0 ? { llm: formatDuration(sessionStats.llmMs) } : {}),
          ...(sessionStats.toolMs > 0 ? { tool: formatDuration(sessionStats.toolMs) } : {}),
        }
      : undefined;

  const label = hasTokens ? `${compact(buckets.total)} token` : time!.counts;
  return {
    label,
    ariaLabel: `這條對話的用量：${label}，點開看明細`,
    ...(usage !== undefined ? { usage } : {}),
    ...(time !== undefined ? { time } : {}),
  };
}
