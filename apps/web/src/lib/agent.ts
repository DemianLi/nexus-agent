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
  /** 預設同源（空字串＝相對路徑），開發時用 `VITE_AGENT_BASE_URL` 指到 harness。 */
  readonly baseUrl?: string;
  /** 注入用；給了就兩條下行也走它，不開 socket。預設是全域的 `fetch` 包一層、順手記下回應的 `Date` 標頭（{@link clockedFetch}，換算時鐘差用），下行走 WebSocket。 */
  readonly fetch?: typeof globalThis.fetch;
}

/** 設定裡指定的 agent 來源；沒設就是同源。 */
export function agentBaseUrl(): string {
  const configured: unknown = import.meta.env.VITE_AGENT_BASE_URL;
  return typeof configured === 'string' ? configured : '';
}

/** 升級請求的網址：跟 agent 同一個來源，`http` 換成 `ws`。 */
export function agentMuxUrl(baseUrl: string, pageUrl: string): string {
  const url = new URL(`${baseUrl.replace(/\/+$/u, '')}${WIRE_MUX_PATH}`, pageUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

/** 沒注入 `fetch` 時兩條下行走 WebSocket，要有 `window`（升級網址從頁面算）；socket 到第一條下行才開。 */
export function createAgentClient(options: AgentClientOptions = {}): WireClient {
  const baseUrl = options.baseUrl ?? agentBaseUrl();
  const fetch = options.fetch ?? clockedFetch();
  return createWireClient({
    baseUrl,
    fetch,
    ...(options.fetch === undefined && {
      streamFetch: createMuxFetch({
        url: agentMuxUrl(baseUrl, window.location.href),
        createSocket: (url) => new WebSocket(url),
        fallback: fetch,
      }),
    }),
  });
}
