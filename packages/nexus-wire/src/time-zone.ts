/**
 * 呼叫端報上來的時區（`run.start` 的 `client_time_zone`，[#1629](https://github.com/DemianLi/nexus-agent/issues/1629)）怎麼驗、怎麼正規化。
 *
 * 照 dsh 的 `canonicalClientTimeZone`（`packages/util/time/src/index.ts`，`687f282e`）：**只驗證與正規化，不格式化任何東西**，
 * 失敗的措辭由各個邊界自己決定（這裡只回 `undefined`）。
 *
 * **為什麼要正規名**：時區會跟著日誌持久化，之後由另一個行程再解析一次。邊界上收下一個別名（例如 `Asia/Calcutta`），
 * 之後讀的一方算出來的 `Asia/Kolkata` 就對不上，所以這裡一律回正規名，別名在邊界上就退掉。
 *
 * @module
 */

/** 嚴格的瀏覽器時區格式：`UTC`，或 IANA 的 `Area/Location` 樣式。 */
const IANA_TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$/u;

/**
 * 驗證並正規化一個呼叫端報上來的 IANA 時區。
 *
 * @param value - 呼叫端給的時區名。
 * @returns 正規名；名字不能用（空字串、前後有空白、格式不對、`Intl` 不認得）時回 `undefined`。
 */
export function canonicalClientTimeZone(value: string): string | undefined {
  if (
    value.length === 0 ||
    value.trim() !== value ||
    (value !== 'UTC' && !IANA_TIME_ZONE.test(value))
  ) {
    return undefined;
  }
  try {
    const canonical = new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions()
      .timeZone;
    if (canonical !== 'UTC' && !IANA_TIME_ZONE.test(canonical)) return undefined;
    return canonical;
  } catch {
    // `Intl` 不認得的名字：由呼叫端對應成自己的拒絕。
    return undefined;
  }
}
