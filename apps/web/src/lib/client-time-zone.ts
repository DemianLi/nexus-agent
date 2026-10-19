/**
 * 送出一句話時帶上的瀏覽器時區（`run.start` 的 `client_time_zone`，[#1630](https://github.com/DemianLi/nexus-agent/issues/1630)）。
 *
 * 照 dsh 的 `resolvedClientTimeZone`（`packages/api/session-controller/src/client/time-zone.ts:8-14`，`687f282e`）：
 *
 * - **每次送出當下取**，不快取：人換了時區（出差、改系統設定）下一句就跟著換。
 * - **拿不到就拋**，不是不帶：dsh 在 RPC 之前呼叫它，拋了那一次送出就失敗。呼叫端（`hooks/use-conversation.ts` 的 `send`）
 *   把它當成這一句的退回訊息，請求根本沒出門，不標 uncertain。
 * - **不在這裡驗證或正規化**：伺服器用 `canonicalClientTimeZone` 驗，別名收成正規名、不合法回 `invalid_argument`（#1629）。
 *
 * 斜線命令（`slash.run`）不帶：dsh 的 `commands.execute` 不帶時區（`client/sessions/session.ts:388`）。
 *
 * @module
 */

/** 拿不到時區時的退回訊息（`send` 原樣交給輸入框）。 */
export const CLIENT_TIME_ZONE_UNAVAILABLE = '瀏覽器拿不到時區，這句話沒有送出';

/**
 * 這個瀏覽器現在的 IANA 時區。
 *
 * @returns `Intl.DateTimeFormat().resolvedOptions().timeZone`。
 * @throws 拿不到、不是字串或是空字串時（訊息是 {@link CLIENT_TIME_ZONE_UNAVAILABLE}）。
 */
export function resolvedClientTimeZone(): string {
  const timeZone: unknown = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (typeof timeZone !== 'string' || timeZone.length === 0) {
    throw new Error(CLIENT_TIME_ZONE_UNAVAILABLE);
  }
  return timeZone;
}
