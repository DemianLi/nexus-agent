/**
 * dev／preview server 把 `/threads` 轉給 harness 時，Origin 要不要改寫——[#387](https://github.com/DemianLi/nexus-agent/issues/387)。
 *
 * harness 的信任圍欄逐字照 dsh（`apps/harness/src/request-trust.ts`）：帶了 Origin 就必須與 Host 同一個
 * authority。dsh 由同一個 host 服務 SPA 與 API，瀏覽器的 Origin 本來就等於 Host；我們的 SPA 由 Vite 服務，
 * proxy 的 `changeOrigin` 只把 Host 改寫成 target、Origin 照舊是 Vite 的來源，不改的話自己送的每一個 POST
 * 都會被擋（2026-09-18 實測：harness 收到 `host: localhost:18788`、`origin: http://localhost:15173`）。
 *
 * **只改寫「等於 Vite 自己來源」的那一種。** 這裡的「自己」是瀏覽器連進來用的 Host——它已經先過了 Vite 自己的
 * `allowedHosts` 檢查（排在 proxy 前面），所以 rebinding 過來的請求到不了這裡。其他 Origin 原樣轉：跨站頁面經
 * Vite 送來時 Origin 是攻擊站、`Sec-Fetch-Site` 是 `cross-site`，要讓 harness 的圍欄照樣擋。
 *
 * 比對照 harness 那側：兩邊都走 WHATWG 正規化，只比 authority。
 */

/**
 * @param origin - 瀏覽器送進 Vite 的 `Origin` 標頭。
 * @param host - 瀏覽器送進 Vite 的 `Host` 標頭。
 * @param target - proxy 的 target URL。
 * @returns 要換上的 Origin；原樣轉就是 `undefined`。
 */
export function proxiedOrigin(
  origin: string | undefined,
  host: string | undefined,
  target: string,
): string | undefined {
  if (origin === undefined || host === undefined) return undefined;
  try {
    return new URL(origin).host === new URL(`http://${host}`).host
      ? new URL(target).origin
      : undefined;
  } catch {
    return undefined;
  }
}
