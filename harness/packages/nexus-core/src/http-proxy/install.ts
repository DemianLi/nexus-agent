/**
 * 代理的安裝：傳輸這一半（[#746](https://github.com/DemianLi/nexus-agent/issues/746)）。它擁有 undici 的全域派送器，
 * 以及「哪份政策正在生效」的行程層紀錄。
 *
 * 照 dsh 的 `packages/util/http-proxy/src/install.ts`（`477b4f4`）。**不是外掛**：一個行程只有一個答案，
 * 沒有第二種實作可以換，所以入口在第一顆外掛載入之前裝一次（見 `apps/harness` 的各入口）。
 * `undici` 用動態 import，純政策那一半（`policy.ts`）就不會被連帶拉進來。
 *
 * ## 與 dsh 的差異
 *
 * - 只留三個出口：{@link installProxyFromEnvironment}、{@link proxyEnvironmentForChild}，以及給測試與結構檢查用的
 *   政策。dsh 另外兩個（`proxyRouteFor` 給網頁抓取工具、`clearedProxyEnv` 給回放測試的子行程）我們沒有使用者，
 *   哪天有，由那一次改動一起加（見 #746「不在這張」）。
 * - 放在 `@nexus/core` 而不是獨立套件：子行程那一層要讀「行程目前裝了哪份代理」，共用清洗函式住在 core。
 *
 * @module
 */

import type { Dispatcher, Pool } from 'undici';

import {
  isSupportedProxyUrl,
  POLICY_ENV_NAMES,
  proxyForUrl,
  resolveProxyPolicy,
  type EnvLookup,
  type ProxyPolicy,
} from './policy.js';

/** 生效中的政策，安裝之前是 `undefined`。行程層的，跟它追蹤的派送器一樣。 */
let active: ProxyPolicy | undefined;

/**
 * 使用者匯出的代理環境原樣，沒有安裝政策時是 `undefined`。
 *
 * 由**最外層**的安裝持有：疊在啟動器那一層之上的安裝，會把外層政策寫出來的值當成使用者寫的，
 * 然後把一份使用者沒要求的正規化交給每個子行程。
 * {@link proxyEnvironmentForChild} 留的是使用者設的值，不是這個行程解出來的值。
 */
let inheritedProxyEnv: Readonly<Record<string, string | undefined>> | undefined;

/** 把政策寫進代理環境變數，讓讀環境的消費者（`node:http` 的 `proxyEnv`、每個子行程）看到同一個解析結果。 */
function applyPolicyEnv(policy: ProxyPolicy): () => void {
  const previousInherited = inheritedProxyEnv;
  inheritedProxyEnv = previousInherited ?? snapshotProxyEnv();
  const published: Record<string, string | undefined> = {};
  for (const [field, names] of Object.entries(POLICY_ENV_NAMES)) {
    const value = policy[field as keyof typeof POLICY_ENV_NAMES];
    for (const name of names) published[name] = value;
  }
  const restore = writeProxyEnv(published);
  return () => {
    restore();
    inheritedProxyEnv = previousInherited;
  };
}

/** 讀這個檔會寫的每個代理名字，`undefined` 表示沒設。 */
function snapshotProxyEnv(): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const names of Object.values(POLICY_ENV_NAMES)) {
    for (const name of names) snapshot[name] = process.env[name];
  }
  return snapshot;
}

/**
 * 把每個代理名字設成 `values` 給的值，值是 `undefined` 的就移除。
 *
 * @returns 把每個名字還原成這次呼叫之前的樣子的函式。
 */
function writeProxyEnv(values: Readonly<Record<string, string | undefined>>): () => void {
  // 寫任何一個之前先把**所有**名字拍下來：Windows 的環境變數名不分大小寫，寫完小寫再讀大寫會讀回剛寫的值，
  // 還原時還原成政策而不是使用者的環境。
  const previous = snapshotProxyEnv();
  for (const name of Object.keys(previous)) {
    const value = values[name];
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  };
}

/**
 * 依一份政策建全域派送器。
 *
 * 路由每個 origin 都問 {@link proxyForUrl}，所以 `fetch` 與所有問「這個網址走哪」的呼叫端讀到同一個答案。
 * **不用 undici 的 `EnvHttpProxyAgent`**：沒有 `HTTPS_PROXY` 時它會把 HTTP 的代理拿去接 `https:`，
 * 而這份政策在拒絕了使用者替它指名的 SOCKS 或壞網址之後，是刻意讓那個協定直連的——路由與診斷就對不上了。
 */
async function createPolicyDispatcher(policy: ProxyPolicy): Promise<Dispatcher> {
  const { Agent, Pool: PoolClass, ProxyAgent } = await import('undici');
  return new Agent({
    factory(origin, options) {
      // undici 把這個參數宣告成 `Object`，丟掉它實際傳進來的池選項。
      const passed = options as Pool.Options;
      const proxy = proxyForUrl(policy, new URL(origin.toString()));
      if (proxy !== undefined) return new ProxyAgent({ ...passed, uri: proxy });
      // 取代 undici 預設 factory 之後，直連要自己建它原本會建的那個。
      return new PoolClass(origin, passed);
    },
  });
}

/**
 * 把這個行程的對外 HTTP 路由到 `policy`。
 *
 * 安裝會換掉 undici 的全域派送器，也就是 Node 內建 `fetch` 解析的那一個，所以每個直接呼叫 `fetch()` 的地方
 * 都被蓋到，呼叫的人不必知道有這回事。什麼都不代理的政策（`source: 'none'`）**不裝任何派送器、不動環境**。
 *
 * worker thread 有自己的 `globalThis`，也就有自己的派送器；這裡裝的管不到它。我們沒有 worker thread。
 *
 * @returns 還原先前的派送器、政策與環境，再關掉這個 agent 的函式。
 */
async function installGlobalProxy(policy: ProxyPolicy): Promise<() => Promise<void>> {
  const previousPolicy = active;
  if (policy.source === 'none') {
    // 直連政策疊在已裝的政策之上，必須真的停止代理：只記政策的話，底下那個 agent 仍是全域派送器，
    // 純 `fetch()` 還在走隧道，而查詢說直連。底下什麼都沒裝就沒有東西要取代。
    if (previousPolicy === undefined) {
      active = policy;
      return () => {
        active = previousPolicy;
        return Promise.resolve();
      };
    }
    // 底下那個安裝把它正規化的政策寫進了 `process.env`，而子行程複製的就是那個；沒有生效的政策就沒有正規化
    // 可以撐腰，這段期間使用者自己的值回來，外層結束時再放回去。
    const restoreEnv =
      inheritedProxyEnv === undefined ? undefined : writeProxyEnv(inheritedProxyEnv);
    const undici = await import('undici');
    const previous = undici.getGlobalDispatcher();
    const direct = new undici.Agent();
    undici.setGlobalDispatcher(direct);
    active = policy;
    return async () => {
      undici.setGlobalDispatcher(previous);
      active = previousPolicy;
      restoreEnv?.();
      await direct.close();
    };
  }
  const restoreEnv = applyPolicyEnv(policy);
  const { getGlobalDispatcher, setGlobalDispatcher } = await import('undici');
  const previousDispatcher = getGlobalDispatcher();
  const agent = await createPolicyDispatcher(policy);
  setGlobalDispatcher(agent);
  active = policy;
  return async () => {
    setGlobalDispatcher(previousDispatcher);
    active = previousPolicy;
    restoreEnv();
    await agent.close();
  };
}

/**
 * 子行程需要的代理環境。
 *
 * 子行程繼承父環境，而這個行程已經把它改寫成自己解出來的政策。原樣交出去會取代使用者為別的工具設的值，
 * 所以**使用者匯出的每個代理名字還原成他寫的樣子**：`curl` 用的 SOCKS 代理不會被換成這裡替那個協定退回的 HTTP 代理。
 *
 * 使用者兩種寫法都沒指名的協定，帶**解析出來的值**而不是移除：`NODE_USE_ENV_PROXY` 不讀 `ALL_PROXY`，
 * 從那個名字解出代理的父行程，它的子行程會直連。
 *
 * 放行清單永遠是解析後的：它只會在使用者寫的東西之上加 loopback，所以什麼都沒少，子行程也不再把本機流量送給連不到的代理。
 *
 * 旗標只有 Node 22.21 以上與 24 以上有用，更舊的執行環境讓那個子行程直連；那樣的子行程比對放行項目用的是 Node 自己的
 * `NO_PROXY` 規則，分隔符與 IPv4 範圍跟這裡不同。非 Node 的子行程（curl、git、pnpm）不理旗標、自己讀變數。
 *
 * 子行程收到的代理值只要有一個是我們拒絕的，就**不補旗標**：Node 在該旗標下會在跑程式之前解析
 * `HTTP_PROXY` 與 `HTTPS_PROXY`，遇到 `http:`／`https:` 以外的協定會直接結束——為了留給 `curl` 的 SOCKS 值，
 * 所有 Node 子行程都起不來。
 *
 * @returns 要疊在子行程環境上的名字，`undefined` 表示移除；沒有代理生效時是空物件。
 */
export function proxyEnvironmentForChild(): Readonly<Record<string, string | undefined>> {
  const policy = active;
  const inherited = inheritedProxyEnv;
  if (policy === undefined || policy.source === 'none' || inherited === undefined) return {};
  const overlay: Record<string, string | undefined> = { NODE_USE_ENV_PROXY: '1' };
  for (const [field, names] of Object.entries(POLICY_ENV_NAMES)) {
    const resolved = policy[field as keyof typeof POLICY_ENV_NAMES];
    // 任一種寫法點了名，這個協定就是使用者的：子行程拿到他寫的原樣與大小寫，不是替這個行程推導出來的值。
    const named = field !== 'noProxy' && names.some((name) => inherited[name] !== undefined);
    for (const name of names) overlay[name] = named ? inherited[name] : resolved;
  }
  const parsedByNode = [...POLICY_ENV_NAMES.httpProxy, ...POLICY_ENV_NAMES.httpsProxy];
  const refused = parsedByNode.some((name) => {
    const value = overlay[name];
    return value !== undefined && !isSupportedProxyUrl(value);
  });
  if (refused) delete overlay.NODE_USE_ENV_PROXY;
  return overlay;
}

/**
 * 從 `env` 解析這個行程的代理政策並安裝。
 *
 * 解析、回報、安裝是一個操作，因為沒有呼叫端需要把它們分開：啟動器在第一顆外掛掛上之前依序做完三件事，
 * 解析了沒裝就什麼都路由不了。
 *
 * 環境給了、但這裡用不了的值**回報並跳過，不拋**：那個變數可能是為別的工具匯出的，
 * 我們用不了的代理不該讓 agent 起不來。
 *
 * @param env - 啟動環境；它自己的分層已經讓真正的環境變數勝過 `.env`。
 * @param report - 每個被拒的值收到一則訊息，照考慮的順序。訊息只講變數名，不帶值。
 * @returns 還原先前派送器、政策與環境的函式。
 */
export async function installProxyFromEnvironment(
  env: EnvLookup,
  report: (message: string) => void,
): Promise<() => Promise<void>> {
  const { policy, diagnostics } = resolveProxyPolicy(env);
  for (const diagnostic of diagnostics) report(diagnostic.message);
  return await installGlobalProxy(policy);
}
