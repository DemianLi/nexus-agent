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
 * - **不分快取**：我們的 `inputTokens` 含快取讀取，直接跟輸出相加就是總量。
 * - **沒有首字延遲與輸出速度**：我們沒記串流第一個 token 的時間。
 *
 * @module
 */

import type { WireSessionStats, WireTokenUsage } from '@nexus/wire';

import { compact } from '@/lib/context-meter-view';

export interface SessionUsageView {
  /** 收著時那顆上的字。 */
  readonly label: string;
  /** 按鈕的名稱（給報讀）。 */
  readonly ariaLabel: string;
  /** 用量那一段；沒有 token 時不給。 */
  readonly usage?: { readonly total: string; readonly input: string; readonly output: string };
  /** 時間那一段；一次模型呼叫都沒結束時不給。 */
  readonly time?: { readonly counts: string; readonly llm?: string; readonly tool?: string };
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
  const input = tokenUsage?.inputTokens ?? 0;
  const output = tokenUsage?.outputTokens ?? 0;
  const hasTokens = input > 0 || output > 0;
  const steps = sessionStats?.steps ?? 0;
  if (steps === 0 && !hasTokens) return null;

  const usage = hasTokens
    ? { total: exactTokens(input + output), input: exactTokens(input), output: exactTokens(output) }
    : undefined;
  const time =
    sessionStats !== null && steps > 0
      ? {
          counts: `${sessionStats.turns} 輪／${steps} 次`,
          ...(sessionStats.llmMs > 0 ? { llm: formatDuration(sessionStats.llmMs) } : {}),
          ...(sessionStats.toolMs > 0 ? { tool: formatDuration(sessionStats.toolMs) } : {}),
        }
      : undefined;

  const label = hasTokens ? `${compact(input + output)} token` : time!.counts;
  return {
    label,
    ariaLabel: `這條對話的用量：${label}，點開看明細`,
    ...(usage !== undefined ? { usage } : {}),
    ...(time !== undefined ? { time } : {}),
  };
}
