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
import { createWireClient } from '@nexus/wire';

export interface AgentClientOptions {
  /** 預設同源（空字串＝相對路徑），開發時用 `VITE_AGENT_BASE_URL` 指到 harness。 */
  readonly baseUrl?: string;
  /** 注入用；預設是全域的 `fetch`。 */
  readonly fetch?: typeof globalThis.fetch;
}

/** 設定裡指定的 agent 來源；沒設就是同源。 */
export function agentBaseUrl(): string {
  const configured: unknown = import.meta.env.VITE_AGENT_BASE_URL;
  return typeof configured === 'string' ? configured : '';
}

export function createAgentClient(options: AgentClientOptions = {}): WireClient {
  return createWireClient({
    baseUrl: options.baseUrl ?? agentBaseUrl(),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}
