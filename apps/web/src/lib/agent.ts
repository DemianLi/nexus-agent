/**
 * 瀏覽器這一端連 agent 的接點。
 *
 * 這裡**沒有 UI**，也刻意不 import 任何 agent 的東西：協定與 client 都在
 * `@nexus/wire`，它只 `import type` 基座的 `@langchain/protocol`，沒有執行期相依。
 * agent 那一半跑在 Node（backend、MCP 的 stdio 子行程、QuickJS 的組裝都在那側），
 * 中間就是這條線——`deepagents` 的 `./browser` 進入點少掉 16 個 Node 專屬匯出，
 * 而我們的 `ContainedFilesystemBackend` 繼承的正是其中的 `FilesystemBackend`。
 */

import type { WireClient } from '@nexus/wire';
import { WIRE_MUX_PATH, createMuxFetch, createWireClient } from '@nexus/wire';

import { clockedFetch } from '@/lib/server-clock';

export interface AgentClientOptions {
  /** agent 的位置，預設是 {@link agentBaseUrl}，開發時用 `VITE_AGENT_BASE_URL` 指到 harness。 */
  readonly baseUrl?: string;
  /** 接在 `baseUrl` 後面的 serve 路徑，例如嵌入版的 `/embed`。 */
  readonly routePrefix?: string;
  /** 注入用；給了就兩條下行也走它，不開 socket。預設是全域的 `fetch` 包一層、順手記下回應的 `Date` 標頭（{@link clockedFetch}，換算時鐘差用），下行走 WebSocket。 */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * agent 的位置：設定了 `VITE_AGENT_BASE_URL` 就用它，沒設就是 `from` 所在目錄的路徑，結尾不帶 `/`。
 * 掛在反向代理的子路徑底下時，這個目錄就是前綴（`/nexus/` 算出 `/nexus`），掛在根路徑是空字串（#2426）。
 *
 * @param from - 從哪個網址算。獨立頁面是 `document.baseURI`；嵌入元件跑在宿主頁上，要傳 `embed.js` 自己的網址。
 */
export function agentBaseUrl(from: string = document.baseURI): string {
  const configured: unknown = import.meta.env.VITE_AGENT_BASE_URL;
  if (typeof configured === 'string') return configured;
  return new URL('.', from).pathname.replace(/\/+$/u, '');
}

/** 升級請求的網址：跟 agent 同一個來源，`http` 換成 `ws`。 */
export function agentMuxUrl(baseUrl: string, pageUrl: string): string {
  const url = new URL(`${baseUrl.replace(/\/+$/u, '')}${WIRE_MUX_PATH}`, pageUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

/**
 * WebSocket 下行：每條串流的 `path` 是 serve 看到的路徑。反向代理只剝得掉升級網址上的前綴，剝不到 socket 裡的訊息，
 * 所以送進 socket 之前先剝掉 `mount` 的路徑；退回 SSE 時是一般請求，前綴接回去（#2426）。`mount` 在根路徑時原樣不包。
 */
export function mountedMuxFetch(
  mount: string,
  baseUrl: string,
  pageUrl: string,
  fetch: typeof globalThis.fetch,
): typeof globalThis.fetch {
  const prefix = new URL(`${mount}/`, pageUrl).pathname.replace(/\/$/u, '');
  const moved = (input: RequestInfo | URL, from: string, to: string): string => {
    const url = new URL(String(input), pageUrl);
    if (url.pathname.startsWith(`${from}/`))
      url.pathname = `${to}${url.pathname.slice(from.length)}`;
    return url.href;
  };
  const mux = createMuxFetch({
    url: agentMuxUrl(baseUrl, pageUrl),
    createSocket: (url) => new WebSocket(url),
    fallback: prefix === '' ? fetch : (input, init) => fetch(moved(input, '', prefix), init),
  });
  return prefix === '' ? mux : (input, init) => mux(moved(input, prefix, ''), init);
}

/** 沒注入 `fetch` 時兩條下行走 WebSocket，要有 `window`（升級網址從頁面算）；socket 到第一條下行才開。 */
export function createAgentClient(options: AgentClientOptions = {}): WireClient {
  const mount = (options.baseUrl ?? agentBaseUrl()).replace(/\/+$/u, '');
  const baseUrl = `${mount}${options.routePrefix ?? ''}`;
  const fetch = options.fetch ?? clockedFetch();
  return createWireClient({
    baseUrl,
    fetch,
    ...(options.fetch === undefined && {
      streamFetch: mountedMuxFetch(mount, baseUrl, window.location.href, fetch),
    }),
  });
}
