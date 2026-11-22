/**
 * 線上每一個請求的瀏覽器信任圍欄（[#387](https://github.com/DemianLi/nexus-agent/issues/387)）。
 *
 * **擋的是 DNS rebinding。** 攻擊頁把自己的網域重新解析到 `127.0.0.1` 之後，瀏覽器認為是同源：
 * preflight 不發、`content-type: application/json` 照帶、回應也讀得到。所以 `wire-handler.ts`
 * 檔頭那道「只收 JSON、逼出一個不回答的 preflight」擋得住跨站，擋不住這條；只綁 loopback
 * 也不是防護，rebinding 打的正是只綁 loopback 的服務。2026-09-18 實測過：真的 `serve` 收到
 * `Host: evil.example:18787` 照樣回 200（探針與結果在 #387 的 triage 留言）。
 *
 * 三道，依序：
 *
 * 1. **Host**：每個請求都判，沒有捷徑。純 HTTP 下瀏覽器的讀取不帶 Origin 也不帶
 *    Fetch-Metadata，跟 curl 分不開，而被 rebinding 的頁面讀得到那個回應；Host 是 rebinding
 *    唯一偽造不了的標頭。缺 Host、解析不了、或既不是 loopback 也不是指名的 authority，一律不信。
 * 2. **`Sec-Fetch-Site: cross-site`** 一律不信，不看 Origin。
 * 3. **Origin**：帶了就必須與 Host 是同一個 authority。Host 照 Origin 自己的 scheme 正規化再比，前面是終止 TLS 的代理時
 *    `https://x` 與 `Host: x:443` 才對得上；只有 http(s) 的 Origin 算數，字面 `null`（sandboxed iframe、`file:` 頁面）與其他
 *    scheme 都不信；沒帶就放行——第 1 道已經綁住了。
 *
 * **非 loopback 的 authority 要指名**（`--trusted-host`，#2369）：放在反向代理後面時，瀏覽器帶的 Host 是代理對外的名字。
 * 條目在啟動時過 {@link assertTrustedAuthority}；帶 port 的只認那個 port，不帶 port 的認任何 port。指名只放行 Host，
 * 後面兩道照樣判，身分也照樣要過瀏覽器會話。
 *
 * **缺 Host 不退回去讀 URL。** 真的 HTTP/1.1 請求一定帶 Host；`wire-server.ts` 的 URL 是它自己
 * 拿綁定位址拼的，跟瀏覽器以為自己在連哪裡無關。
 *
 * ## 偏離（照 AGENTS.md 的偏離規則登記）
 *
 * - **沒有 TLS**（[#1547](https://github.com/DemianLi/nexus-agent/issues/1547) 的 Q1 (a)）。`serve` 只走 HTTP、只綁 loopback；
 *   加密由前面的 SSH 隧道或終止 TLS 的反向代理負責。`serve` 若加上 `--host`，要一起處理 `wire-server.ts` 寫死的兩處
 *   `http://`（給 handler 的 origin 與印出來的網址），以及 `browser-auth.ts` 檔頭不設 `Secure` 的那一條。
 *
 * **圍欄不建立身分**：過了這一道還要過瀏覽器會話（`browser-auth.ts`，#424），防的是同機其他
 * 使用者或行程直接打 API，跟 rebinding 是不同的威脅。原本登記在這裡的「沒有瀏覽器會話認證」
 * 偏離，重開條件（在多使用者的機器上跑）2026-09-19 觸發，已由 #424 補上。
 */

type HttpScheme = 'http:' | 'https:';

/**
 * 一個 authority 正規化後的 URL（hostname 小寫、該 scheme 的預設 port 拿掉、IPv6 帶方括號），解析不了就 undefined。
 */
function parseAuthority(authority: string, scheme: HttpScheme = 'http:'): URL | undefined {
  try {
    // http: 與 https: 是 WHATWG 的 special scheme：解析結果一定有非空的 hostname，不然就拋。
    return new URL(`${scheme}//${authority}`);
  } catch {
    return undefined;
  }
}

/**
 * 解析過的條目的正規寫法：沒寫 port 是 `hostname`，寫了是 `hostname:port`。有沒有寫 port 看兩種 scheme 的解析結果，
 * 不看原字串：`:80`、`:443` 各在一種 scheme 下會被當成預設 port 拿掉，而 WHATWG 會修掉前後空白，原字串看不準。
 */
function canonicalAuthority(entry: string, entryUrl: URL): string {
  const other = entryUrl.protocol === 'http:' ? 'https:' : 'http:';
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`${other}//${entry}`).port;
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`;
}

/**
 * 驗一個 `--trusted-host` 條目：必須是正規寫法的裸 `host[:port]`，解析前後（大小寫除外）一字不差。
 *
 * 會被解析悄悄改寫的一律拒收，在啟動時就失敗，不留到請求一律 403 才發現：多了路徑或 `user@`（後者會放行裡面那個
 * hostname）、前後空白、空的 port（會把只認一個 port 放寬成任何 port）、補零的 port、非正規的位址寫法（`0x7f.0.0.1`、
 * 百分比編碼、沒加方括號的 IPv6；IDN 寫 punycode，線上傳的就是那個形式）。補零的 port 照數值比，不會放寬，
 * 但讀回來跟寫的不一樣，一併拒收。
 *
 * @throws 條目不是正規寫法的裸 `host[:port]`。
 */
export function assertTrustedAuthority(entry: string): void {
  const entryUrl = parseAuthority(entry);
  if (entryUrl !== undefined && canonicalAuthority(entry, entryUrl) === entry.toLowerCase()) return;
  throw new Error(`--trusted-host ${JSON.stringify(entry)} 不是裸的 host[:port]`);
}

/** Host 有沒有對上一個指名的條目：帶 port 的整個 authority 要相同，不帶 port 的只比 hostname。 */
function isTrustedAuthority(
  hostUrl: URL,
  trustedHosts: readonly string[],
  scheme: HttpScheme,
): boolean {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry, scheme);
    if (entryUrl === undefined) return false;
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host;
  });
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

/** Origin 是不是這台的 http(s) authority：Host 照 Origin 的 scheme 正規化之後，兩邊的 authority 要相同。 */
function isSameAuthorityOrigin(origin: string, host: string): boolean {
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  const scheme =
    originUrl.protocol === 'https:'
      ? 'https:'
      : originUrl.protocol === 'http:'
        ? 'http:'
        : undefined;
  if (scheme === undefined) return false;
  return parseAuthority(host, scheme)?.host === originUrl.host;
}

/**
 * 這個請求能不能進到線的任何一條路徑。
 *
 * @param headers - 請求標頭。
 * @param trustedHosts - 指名的非 loopback authority（`--trusted-host`，已過 {@link assertTrustedAuthority}）。
 * @returns Host 是 loopback 或指名的、沒有跨站標記、而且帶了 Origin 時與 Host 同源，才是 true。
 */
export function isTrustedWireRequest(
  headers: Headers,
  trustedHosts: readonly string[] = [],
): boolean {
  const host = headers.get('host') ?? undefined;
  if (host === undefined) return false;
  const hostUrl = parseAuthority(host);
  if (hostUrl === undefined) return false;
  if (
    !isLoopbackHostname(hostUrl.hostname) &&
    !isTrustedAuthority(hostUrl, trustedHosts, 'http:')
  ) {
    return false;
  }
  if (headers.get('sec-fetch-site') === 'cross-site') return false;
  const origin = headers.get('origin') ?? undefined;
  if (origin === undefined) return true;
  return isSameAuthorityOrigin(origin, host);
}
