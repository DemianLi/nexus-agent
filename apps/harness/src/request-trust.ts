/**
 * 線上每一個請求的瀏覽器信任圍欄（[#387](https://github.com/DemianLi/nexus-agent/issues/387)）。
 *
 * **擋的是 DNS rebinding。** 攻擊頁把自己的網域重新解析到 `127.0.0.1` 之後，瀏覽器認為是同源：
 * preflight 不發、`content-type: application/json` 照帶、回應也讀得到。所以 `wire-handler.ts`
 * 檔頭那道「只收 JSON、逼出一個不回答的 preflight」擋得住跨站，擋不住這條；只綁 loopback
 * 也不是防護，rebinding 打的正是只綁 loopback 的服務。2026-09-18 實測過：真的 `serve` 收到
 * `Host: evil.example:18787` 照樣回 200（探針與結果在 #387 的 triage 留言）。
 *
 * **判準逐字照 dsh**：`packages/client/connection/src/api-request-trust.ts` 的
 * `isTrustedApiRequest` 與 `loopback-hostname.ts`（`ddefc45`）。三道，依序：
 *
 * 1. **Host**：每個請求都判，沒有捷徑。純 HTTP 下瀏覽器的讀取不帶 Origin 也不帶
 *    Fetch-Metadata，跟 curl 分不開，而被 rebinding 的頁面讀得到那個回應；Host 是 rebinding
 *    唯一偽造不了的標頭。缺 Host、解析不了、或 hostname 不是 loopback，一律不信。
 * 2. **`Sec-Fetch-Site: cross-site`** 一律不信，不看 Origin。
 * 3. **Origin**：帶了就必須與 Host 是同一個 authority（兩邊都走 WHATWG 正規化）；字面 `null`
 *    （sandboxed iframe、`file:` 頁面）解析不出 authority，不信；沒帶就放行——第 1 道已經綁住了。
 *
 * **缺 Host 不退回去讀 URL。** 真的 HTTP/1.1 請求一定帶 Host；`wire-server.ts` 的 URL 是它自己
 * 拿綁定位址拼的，跟瀏覽器以為自己在連哪裡無關。
 *
 * ## 偏離（照 AGENTS.md 的偏離規則登記）
 *
 * - **沒有 `trustedHosts`。** dsh 讓部署宣告非 loopback 的 authority（`--trusted-host`，載入期由
 *   `assertTrustedAuthority` 驗格式）。我們的 `serve` 沒有 `--host`，非 loopback 暴露沒有路徑，
 *   宣告了也沒有東西會用到。**重開條件**：`serve` 加上 `--host`——那天把 dsh 的
 *   `isTrustedAuthority` 分支與 `assertTrustedAuthority` 一起帶進來。
 * - **Origin 的落差只剩開發迴圈要修，修在 proxy，不修在這裡。** 產品路徑上網頁由 serve 自己服務
 *   （`web-static.ts`，[#424](https://github.com/DemianLi/nexus-agent/issues/424)），跟 dsh 一樣
 *   瀏覽器的 Origin 本來就等於 Host。開發時 web 經 Vite proxy 進來，`changeOrigin` 只改寫 Host、
 *   不改 Origin，照抄第 3 道會把自己的 POST 全擋掉；所以由 `apps/web/src/lib/proxy-origin.ts` 把
 *   「等於 Vite 自己來源」的 Origin 改寫成 target，這裡的判準一個字不動。
 *
 * **圍欄不建立身分**：過了這一道還要過瀏覽器會話（`browser-auth.ts`，#424），防的是同機其他
 * 使用者或行程直接打 API，跟 rebinding 是不同的威脅。原本登記在這裡的「沒有瀏覽器會話認證」
 * 偏離，重開條件（在多使用者的機器上跑）2026-09-19 觸發，已由 #424 補上。
 */

/**
 * 一個 Host 標頭 authority 正規化後的 URL（hostname 小寫、預設 port 拿掉、IPv6 帶方括號），
 * 解析不了就 undefined。
 */
function parseAuthority(authority: string): URL | undefined {
  try {
    // http: 是 WHATWG 的 special scheme：解析結果一定有非空的 hostname，不然就拋。
    return new URL(`http://${authority}`);
  } catch {
    return undefined;
  }
}

/**
 * 正規化後的 hostname 是不是本機 loopback。
 *
 * @param hostname - WHATWG URL 的 hostname（IPv6 字面值保留方括號）。
 * @returns `localhost`、`[::1]`，或 `127.0.0.0/8` 裡任何一個 IPv4 位址。
 */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const parts = hostname.split('.');
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

/**
 * 這個請求能不能進到線的任何一條路徑。
 *
 * @param headers - 請求標頭。
 * @returns Host 是 loopback、沒有跨站標記、而且帶了 Origin 時與 Host 同源，才是 true。
 */
export function isTrustedWireRequest(headers: Headers): boolean {
  const host = headers.get('host') ?? undefined;
  if (host === undefined) return false;
  const hostUrl = parseAuthority(host);
  if (hostUrl === undefined) return false;
  if (!isLoopbackHostname(hostUrl.hostname)) return false;
  if (headers.get('sec-fetch-site') === 'cross-site') return false;
  const origin = headers.get('origin') ?? undefined;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}
