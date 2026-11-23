/**
 * 對外 HTTP 代理的政策解析：純函式、不碰傳輸（[#746](https://github.com/DemianLi/nexus-agent/issues/746)）。
 * 把啟動環境解成一份 {@link ProxyPolicy}，並回答某個網址走哪個代理。
 *
 * 逐條照 dsh 的 `packages/util/http-proxy/src/policy.ts`（`477b4f4`）。**這個檔不 import `undici`**，
 * 所以要在沒有 Node 傳輸的地方載入也不會拉進它。
 *
 * @module
 */

/**
 * 解析要的唯一一件事：名字進、勝出的值出。`LaunchEnvironment`（`apps/harness/src/launch-env.ts`）結構上
 * 就符合這個形狀，原樣傳進來；測試用物件字面值就建得出一個。
 */
export interface EnvLookup {
  /**
   * 解析一個變數名。
   *
   * @param name - 變數名。
   * @returns 勝出的那一筆；沒有任何一層給值就是 `undefined`。
   */
  get(name: string): { readonly value: string } | undefined;
}

/**
 * 併進每份政策 `noProxy` 的本機項目。代理連 harness 自己的本機流量一起代，就是網頁、連線傳輸與每個本機測試伺服器
 * 的路由迴圈，所以這份放行不是選配。
 *
 * `::1` 與 `[::1]` 兩種寫法都列：解析出來的字串也會交給 undici，它的比對器會把裸的 `::1` 讀成主機 `:`、埠 `1`，
 * 永遠放行不了。
 */
export const LOOPBACK_NO_PROXY: readonly string[] = ['localhost', '127.0.0.1', '::1', '[::1]'];

/** 每個政策欄位擁有的環境變數名，**小寫在前**：undici 先讀小寫，所以兩種寫法永遠一起寫、一起清。 */
export const POLICY_ENV_NAMES = {
  httpProxy: ['http_proxy', 'HTTP_PROXY'],
  httpsProxy: ['https_proxy', 'HTTPS_PROXY'],
  noProxy: ['no_proxy', 'NO_PROXY'],
} as const;

/** 這份程式會路由的代理網址協定。其他的一律報出來，不默默丟掉。 */
const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:']);

/** 認得出來、可以在診斷裡點名的協定（不當成「格式錯」）。 */
const SOCKS_PROTOCOLS = new Set(['socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:']);

/**
 * 一份解析好的對外代理政策。純資料、沒有方法。
 */
export interface ProxyPolicy {
  /** `http:` 來源的代理；沒有就是直連。一定是驗過的 `http(s):` 網址。 */
  readonly httpProxy?: string;
  /** `https:` 來源的代理；沒有就是直連。一定是驗過的 `http(s):` 網址。 */
  readonly httpsProxy?: string;
  /** 放行清單，已併入 {@link LOOPBACK_NO_PROXY}。什麼都不放行時是空字串。 */
  readonly noProxy: string;
  /** 勝出的代理網址從哪來；兩個欄位任一個來自環境就是 `env`。 */
  readonly source: 'env' | 'none';
}

/** 什麼都不代理的政策。 */
export const DIRECT_POLICY: ProxyPolicy = { noProxy: '', source: 'none' };

/** 一個候選值為什麼沒被用。呼叫端決定這是警告還是讓啟動失敗。 */
export interface ProxyDiagnostic {
  /** `socks`：SOCKS 或 PAC 網址，路由不了；`invalid`：其他解析不了的。 */
  readonly kind: 'socks' | 'invalid';
  /** 提供被拒值的環境變數名。 */
  readonly origin: string;
  /** 給操作者的一句話：講被拒的原因與下一步。**不帶任何值**（值裡可能有帳密）。 */
  readonly message: string;
}

/** 解析好的政策，加上一路上被拒的每個候選值。 */
export interface ProxyResolution {
  /** 要裝的政策。永遠不含被拒的值。 */
  readonly policy: ProxyPolicy;
  /** 被拒的候選，照考慮的順序。乾淨解析時是空的。 */
  readonly diagnostics: readonly ProxyDiagnostic[];
}

/**
 * 依 undici 的優先序讀一個名字：小寫在前、大寫墊底，**空白值當沒設**。空白要緊：undici 自己的 `??` 鏈
 * 會讓空的小寫名蓋住有值的大寫名。
 *
 * @param env - 要讀的啟動環境。
 * @param lower - 小寫變數名。
 * @returns 修剪過的值與提供它的名字；兩個都沒設就是 `undefined`。
 */
function readEnv(env: EnvLookup, lower: string): { value: string; name: string } | undefined {
  for (const name of [lower, lower.toUpperCase()]) {
    const value = env.get(name)?.value.trim();
    if (value !== undefined && value !== '') return { value, name };
  }
  return undefined;
}

/**
 * 一個環境變數給了什麼。**被拒的槽位跟沒填的槽位是兩件事**：使用者替這個協定指名了代理，退回去用別的協定的代理，
 * 請求會走到他從沒要求的地方，而診斷卻說它是直連。
 */
type ProxyCandidate =
  | { readonly kind: 'accepted'; readonly value: string }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'absent' };

const ABSENT: ProxyCandidate = { kind: 'absent' };

/**
 * 驗一個候選代理網址。
 *
 * @param candidate - 原始值與診斷要點名的來源。
 * @param diagnostics - 被拒時追加進去的收集器。
 * @returns 候選的可用性，分得出「被拒」與「沒填」。
 */
function acceptProxyUrl(
  candidate: { value: string; name: string } | undefined,
  diagnostics: ProxyDiagnostic[],
): ProxyCandidate {
  if (candidate === undefined) return ABSENT;
  const parsed = URL.parse(candidate.value);
  if (parsed === null) {
    diagnostics.push({
      kind: 'invalid',
      origin: candidate.name,
      message: `${candidate.name} 不是合法的網址，這個協定改直連`,
    });
    return { kind: 'rejected' };
  }
  if (SOCKS_PROTOCOLS.has(parsed.protocol)) {
    diagnostics.push({
      kind: 'socks',
      origin: candidate.name,
      message: `${candidate.name} 指到 SOCKS 代理，這裡不支援；這個協定改直連——請改設 http:// 或 https:// 的代理網址`,
    });
    return { kind: 'rejected' };
  }
  if (!SUPPORTED_PROTOCOLS.has(parsed.protocol)) {
    diagnostics.push({
      kind: 'invalid',
      origin: candidate.name,
      message: `${candidate.name} 用了不支援的 ${parsed.protocol}// 協定；這個協定改直連——請改設 http:// 或 https:// 的代理網址`,
    });
    return { kind: 'rejected' };
  }
  return { kind: 'accepted', value: candidate.value };
}

/**
 * 代理網址是不是這裡收得下的：解析得了、協定是 `http:` 或 `https:`。跟 {@link acceptProxyUrl} 同一條判準，只是不出診斷。
 *
 * @param value - 環境變數裡的代理網址。
 * @returns 收得下就是 `true`。
 */
export function isSupportedProxyUrl(value: string): boolean {
  const parsed = URL.parse(value);
  return parsed !== null && SUPPORTED_PROTOCOLS.has(parsed.protocol);
}

/**
 * 解析一個協定的代理：先看它自己的槽位，再看退路——**只在自己的槽位是空的時候**。被拒的槽位讓這個協定維持直連，
 * 診斷與路由才說同一件事。
 *
 * @param own - 這個協定自己的名字給了什麼。
 * @param fallbacks - `own` 沒填時依序試的值。
 * @returns 這個協定的代理網址；直連就是 `undefined`。
 */
function resolveScheme(
  own: ProxyCandidate,
  ...fallbacks: (string | undefined)[]
): string | undefined {
  if (own.kind === 'accepted') return own.value;
  if (own.kind === 'rejected') return undefined;
  return fallbacks.find((value) => value !== undefined);
}

/**
 * 把 {@link LOOPBACK_NO_PROXY} 併進放行清單，保留呼叫端的項目與順序。整份清單是 `*` 就已經全放行，原樣回傳。
 *
 * @param noProxy - 環境給的放行清單。
 * @returns 有效的放行清單。
 */
function withLoopback(noProxy: string | undefined): string {
  const entries = (noProxy ?? '')
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  if (entries.includes('*')) return '*';
  const present = new Set(entries.map((entry) => entry.toLowerCase()));
  return [...entries, ...LOOPBACK_NO_PROXY.filter((entry) => !present.has(entry))].join(',');
}

/**
 * 把一個放行項目拆成主機與（可有的）埠。裸的 IPv6 位址有好幾個冒號、沒有埠，所以只有「單一冒號」的項目才拆；
 * 有中括號的從括號後面取埠。拆錯就是 undici 把 `::1` 讀成主機 `:`、埠 `1` 的原因。
 *
 * @param entry - 一個已修剪的放行項目。
 * @returns 主機與埠。
 */
function splitHostPort(entry: string): { host: string; port?: string } {
  if (entry.startsWith('[')) {
    const close = entry.indexOf(']');
    if (close !== -1) {
      const rest = entry.slice(close + 1);
      const host = entry.slice(1, close);
      return rest.startsWith(':') ? { host, port: rest.slice(1) } : { host };
    }
  }
  const colon = entry.indexOf(':');
  if (colon !== -1 && entry.indexOf(':', colon + 1) === -1) {
    return { host: entry.slice(0, colon), port: entry.slice(colon + 1) };
  }
  return { host: entry };
}

/** IPv4 的一個位元組，所以 `127.999.1.1` 不會被當成本機。 */
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';

/** 整段 `127.0.0.0/8`，不只第一個位址。 */
const LOOPBACK_IPV4 = new RegExp(`^127\\.${OCTET}\\.${OCTET}\\.${OCTET}$`);

/**
 * 主機是不是這台機器。代理連不到它：代理會在自己的網路裡解析位址，而跑在本機的代理則會替呼叫端連上只聽 loopback 的服務。
 * 放行清單裡的 {@link LOOPBACK_NO_PROXY} 是給讀環境變數的消費者用的，只有四個字面項目；只比它們，
 * `127.0.0.2`、其餘的 `127.0.0.0/8` 與 IPv4-mapped 寫法都會走代理。
 *
 * @param hostname - 網址的主機名，有沒有中括號都行。
 * @returns 是 loopback 或未指定位址就是 `true`。
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '::' || host === '0.0.0.0') return true;
  // IPv4-mapped 位址可以保留點分的尾巴，也可以在網址正規化之後變成兩組十六進位：`::ffff:127.0.0.1` 與
  // `::ffff:7f00:1` 是同一個位址。
  const mappedHigh = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(host)?.[1];
  if (mappedHigh !== undefined) return Number.parseInt(mappedHigh, 16) >>> 8 === 127;
  return LOOPBACK_IPV4.test(host.startsWith('::ffff:') ? host.slice('::ffff:'.length) : host);
}

/**
 * 放行清單放不放行某個網址。一個項目指名一個主機，同時比對它底下的每個子網域——`example.com` 也放行
 * `api.example.com`；開頭的 `.` 或 `*.` 視為同一件事；項目可以帶 `:埠`；`*` 放行全部。
 * **不比對 CIDR**：作業系統的放行清單常有 `10.0.0.0/8`，要改寫成網域尾巴。
 *
 * @param noProxy - 有效的放行清單。
 * @param url - 請求網址。
 * @returns 必須繞過代理就是 `true`。
 */
export function bypassesProxy(noProxy: string, url: URL): boolean {
  // `URL.hostname` 的 IPv6 位址帶中括號，而放行項目兩種寫法都可能，所以兩邊都先去掉再比。
  const host = url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  const port = url.port !== '' ? url.port : url.protocol === 'https:' ? '443' : '80';
  for (const raw of noProxy.split(/[,\s]+/)) {
    const entry = raw.trim().toLowerCase();
    if (entry === '') continue;
    if (entry === '*') return true;
    const split = splitHostPort(entry);
    if (split.port !== undefined && split.port !== port) continue;
    const candidate = split.host.replace(/^\*?\./, '').replace(/\.$/, '');
    if (candidate === '') continue;
    if (host === candidate || host.endsWith(`.${candidate}`)) return true;
  }
  return false;
}

/**
 * 解析這個行程的對外代理政策。
 *
 * 一個協定自己的變數贏，其次 `ALL_PROXY`，最後（只有 HTTPS）退回 HTTP 的代理——跟 undici 一致，
 * 這個函式與裝上去的派送器對同一個網址就不會意見不同。
 *
 * @param env - 啟動環境；它自己的分層已經讓真正的環境變數勝過 `.env`。
 * @returns 要裝的政策，加上所有被拒的候選。
 */
export function resolveProxyPolicy(env: EnvLookup): ProxyResolution {
  const diagnostics: ProxyDiagnostic[] = [];
  const all = acceptProxyUrl(readEnv(env, 'all_proxy'), diagnostics);
  const allValue = all.kind === 'accepted' ? all.value : undefined;
  const envHttp = acceptProxyUrl(readEnv(env, 'http_proxy'), diagnostics);
  const envHttps = acceptProxyUrl(readEnv(env, 'https_proxy'), diagnostics);
  const httpProxy = resolveScheme(envHttp, allValue);
  // HTTPS 最後才退回 HTTP 的代理，跟 undici 一致——但不會越過「使用者替 HTTPS 指名、而我們拒絕了」的值。
  const httpsProxy = resolveScheme(envHttps, allValue, httpProxy);
  if (httpProxy === undefined && httpsProxy === undefined) {
    return { policy: DIRECT_POLICY, diagnostics };
  }
  return {
    policy: {
      ...(httpProxy === undefined ? {} : { httpProxy }),
      ...(httpsProxy === undefined ? {} : { httpsProxy }),
      noProxy: withLoopback(readEnv(env, 'no_proxy')?.value),
      source: 'env',
    },
    diagnostics,
  };
}

/**
 * 某個網址在某份政策下走哪個代理。
 *
 * 裝上去的派送器與其他要先知道「這個請求走不走代理」的呼叫端都問這一個答案，所以一個網址不會被一邊釘住位址、
 * 另一邊又走隧道。
 *
 * @param policy - 生效中的政策。
 * @param url - 請求網址。
 * @returns 要走隧道的代理網址；直連就是 `undefined`。
 */
export function proxyForUrl(policy: ProxyPolicy, url: URL): string | undefined {
  const proxy =
    url.protocol === 'https:'
      ? policy.httpsProxy
      : url.protocol === 'http:'
        ? policy.httpProxy
        : undefined;
  if (proxy === undefined) return undefined;
  if (isLoopbackHost(url.hostname)) return undefined;
  return bypassesProxy(policy.noProxy, url) ? undefined : proxy;
}
