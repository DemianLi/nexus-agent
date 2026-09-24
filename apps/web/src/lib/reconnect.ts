/**
 * 下行斷了之後多久再接一次（[#593](https://github.com/DemianLi/nexus-agent/issues/593)）。
 *
 * 照 dsh 的 `ConnectionController`（`packages/client/connection/src/client/connection.ts` 的 `backoffCap`／
 * `backoffDelay`，預設值在 `recovery-config.ts`，`477b4f4`）：第 n 次重試的上限是 `500ms × 2^(n−1)`，封頂 10 秒，
 * 實際等上限的一半到全部之間的亂數；**不放棄**。瀏覽器離線時不排重試，回到線上時從第 1 次重算；人按「立刻重連」
 * 就不等，也從頭算。
 *
 * 接回來的方式是重開下行＋重抓歷史，不是續傳——協定這一版明確不收 `since`（見 `@nexus/wire` 的 `OpenEventsOptions`）。
 *
 * @module
 */

export const RECONNECT_BASE_MS = 500;
export const RECONNECT_FACTOR = 2;
export const RECONNECT_MAX_MS = 10_000;

/**
 * 「已重新連線」在狀態列留多久。同 dsh `SettingsRoot.tsx` 的 `RECOVERY_CONFIRMATION_MS`。
 */
export const RECOVERED_NOTICE_MS = 2_000;

/**
 * 第 `attempt` 次重試（從 1 起算）要等多久。
 *
 * @param attempt - 這是連續第幾次重試。
 * @param random - `[0, 1)` 的亂數，測試時注入。
 * @returns 毫秒。
 */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const cap = Math.min(
    RECONNECT_MAX_MS,
    RECONNECT_BASE_MS * RECONNECT_FACTOR ** Math.max(0, attempt - 1),
  );
  return cap / 2 + random() * (cap / 2);
}
