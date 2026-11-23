/**
 * 對外 HTTP 代理（[#746](https://github.com/DemianLi/nexus-agent/issues/746)，照 dsh 的 `dsh-http-proxy`）。
 *
 * Node 內建的 `fetch` 不看 `HTTP_PROXY` 這類環境變數，所以不管使用者匯出了什麼，每個請求都直連。
 * 入口從啟動環境解一份政策，裝成 undici 的全域派送器——內建 `fetch` 解析的就是它，
 * 於是模型、網路上的 MCP 都蓋得到，不必動它們的程式碼。
 *
 * **這是函式庫，不是外掛**：傳輸政策一個行程只有一個答案，沒有東西可以掛、可以換、可以分範圍。
 *
 * @module
 */

export { installProxyFromEnvironment, proxyEnvironmentForChild } from './install.js';
export {
  bypassesProxy,
  DIRECT_POLICY,
  isLoopbackHost,
  isSupportedProxyUrl,
  LOOPBACK_NO_PROXY,
  POLICY_ENV_NAMES,
  proxyForUrl,
  resolveProxyPolicy,
} from './policy.js';
export type { EnvLookup, ProxyDiagnostic, ProxyPolicy, ProxyResolution } from './policy.js';
