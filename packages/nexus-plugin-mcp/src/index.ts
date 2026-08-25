/**
 * `@nexus/plugin-mcp`——把一台外部 MCP server 的工具接進 agent。
 *
 * **一個 plugin 實例對一台 server**，照 dsh 的 `mcp-client`。同一個工廠掛載多次是合法的
 * （`NexusPlugin.name` 不唯一）：`createMcpPlugin({ serverName: 'github', ... })` 與
 * `createMcpPlugin({ serverName: 'linear', ... })` 兩個都叫 `mcp`，各自的工具在
 * `mcp__github__*` 與 `mcp__linear__*` 兩個命名空間下井水不犯河水。兩次用同一個
 * `serverName`，會在 registry 那一層以「同層同名工具」撞掉——那正是撞名該發生的地方。
 *
 * **與 dsh 的偏離**（AGENTS.md 的偏離規則）：dsh 直接用 `@modelcontextprotocol/sdk`
 * 自己接連線、自己做重連監督。我們走 `@langchain/mcp-adapters`——它產出的是
 * `DynamicStructuredTool`，也就是 `registry.tools.register()` 本來就收的東西，而自己接
 * SDK 等於把 MCP 的 content block 翻成 LangChain 工具結果這一段重寫一次。三項因此
 * 跟著 adapter 而不是 dsh，逐條記在 [README](../README.md) 的明文限制裡。
 *
 * **這裡沒有內建 MCP 這回事。** 計劃第 0、2、4 節寫「deepagentsjs 已內建 MCP 工具接入」
 * 是錯的——`deepagents@1.13.1` 整包 grep `mcp` 零命中，MCP 在 LangChain JS 這一側是
 * `@langchain/mcp-adapters` 這個獨立套件。修訂隨本 PR 一併落地。
 */

import type { StructuredTool } from '@langchain/core/tools';
import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import type { Connection } from '@langchain/mcp-adapters';
import type { NexusPlugin, PluginRegistry } from '@nexus/core';
import { SERVER_NAME_PATTERN, publicToolName } from './names.js';

export { publicToolName, SERVER_NAME_PATTERN } from './names.js';

/** 這個 plugin 宣告的能力名。要相依「有 MCP 工具在」的 plugin 把它放進自己的 `requires`。 */
export const MCP_CAPABILITY = 'mcp';

/** 一次 `tools/call` 的預設逾時，照 dsh 的 `toolCallTimeoutMs`。 */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000;

/** 以子行程方式啟動的 MCP server。 */
export interface McpStdioConnection {
  readonly transport: 'stdio';
  /** 要執行的程式。 */
  readonly command: string;
  /** 傳給它的參數。 */
  readonly args?: readonly string[];
  /**
   * 額外的環境變數。
   *
   * **秘密只從呼叫端的環境變數來**（`docs/standards.md`）：這裡收的是值，寫死 token 的
   * 地方不在這個型別裡，而在填它的那一行。
   */
  readonly env?: Readonly<Record<string, string>>;
  /** 子行程的工作目錄。 */
  readonly cwd?: string;
}

/** 走 Streamable HTTP 的 MCP server。 */
export interface McpHttpConnection {
  readonly transport: 'http';
  /** server 的網址。 */
  readonly url: string;
  /** 額外的標頭，例如授權用的。 */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface McpPluginOptions {
  /**
   * 這一台 server 的命名空間，會成為工具名的一段。
   * 形狀照 dsh：`[A-Za-z0-9_-]{1,32}`，不合法當場報錯。
   */
  readonly serverName: string;
  /** 怎麼連上它。 */
  readonly connection: McpStdioConnection | McpHttpConnection;
  /** 一次 `tools/call` 的逾時。省略即 {@link DEFAULT_TOOL_CALL_TIMEOUT_MS}。 */
  readonly toolCallTimeoutMs?: number;
}

/**
 * 建一個 MCP plugin。
 *
 * `apply` 是 async 的，裡面做三件事：連上 server、`tools/list` 拿工具、逐個註冊。三件
 * 事**都在載入期**——agent 跑起來的時候工具集合已經定了，這是共同軸線的「載入期失敗」
 * 在這個 plugin 上的樣子。連不上、列不出、註冊撞名，任何一件事發生都讓整份清單載入
 * 失敗，而不是安靜地少幾個工具。
 *
 * **這一條是刻意偏離 dsh 的**：dsh 的 `failOnStartupError` 預設 `false`（連不上照樣啟動、
 * 沒有工具）。nexus 的共同軸線是 fail-closed、載入期失敗，而
 * `@langchain/mcp-adapters` 的預設（`onConnectionError: 'throw'`、
 * `throwOnLoadError: true`）本來就站在同一邊，所以照 adapter 的預設走。理由是 repo
 * 層級的軸線，不是套件層級的預設值偏好。
 *
 * @param options - 這一台 server 的身分與連線方式。
 * @returns 可以放進組裝點清單的 plugin。
 * @throws `serverName` 不合法時當場報錯——那是寫錯清單，不必等到連線才發現。
 */
export function createMcpPlugin(options: McpPluginOptions): NexusPlugin {
  const { serverName } = options;
  if (!SERVER_NAME_PATTERN.test(serverName)) {
    throw new Error(
      `serverName "${serverName}" 不合法：只能是 1 到 32 個 [A-Za-z0-9_-]。` +
        `它會成為工具名的一段（mcp__${serverName}__…），而供應商的 function name ` +
        `契約不收其他字元。`,
    );
  }

  return {
    name: 'mcp',
    async apply(registry: PluginRegistry): Promise<void> {
      const client = new MultiServerMCPClient({
        mcpServers: { [serverName]: toAdapterConnection(options) },
        // 名字由 `publicToolName` 一個地方說了算，所以 adapter 這邊的前綴全部關掉。
        // 開著的話會有兩份拼名字的邏輯，而其中一份不做正規化。
        prefixToolNameWithServerName: false,
        additionalToolNamePrefix: '',
        throwOnLoadError: true,
        onConnectionError: 'throw',
      });

      try {
        for (const tool of await client.getTools()) {
          // 改的是**註冊給模型看的**名字。`tools/call` 送上線的是 adapter 在建這個工具時
          // 就閉包住的 raw name（`dist/tools.js:456`），不是這個欄位——所以改它不會讓
          // 呼叫送到不存在的工具上。
          tool.name = publicToolName(serverName, tool.name);
          registry.tools.register(tool as StructuredTool);
        }
      } catch (error) {
        // 回滾期的資源釋放是 plugin 自己的事——`lifecycle` 通道只管關機，而這裡是
        // `apply` 還沒跑完就壞掉，登記根本還沒發生。連線已經開了就得收掉，否則這個
        // 子行程會活過整個行程。
        await client.close().catch(() => {});
        throw error;
      }

      registry.capabilities.provide(MCP_CAPABILITY);
      registry.lifecycle.onDispose(() => client.close());
    },
  };
}

/** 把我們的連線設定翻成 adapter 收的形狀。 */
function toAdapterConnection(options: McpPluginOptions): Connection {
  const timeout = options.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS;
  const connection = options.connection;
  if (connection.transport === 'stdio') {
    return {
      transport: 'stdio',
      command: connection.command,
      // adapter 的 stdio schema 把 `args` 列為必填，沒有參數的 server 也要給一個空陣列。
      args: [...(connection.args ?? [])],
      ...(connection.env !== undefined && { env: { ...connection.env } }),
      ...(connection.cwd !== undefined && { cwd: connection.cwd }),
      defaultToolTimeout: timeout,
    };
  }
  return {
    transport: 'http',
    url: connection.url,
    ...(connection.headers !== undefined && { headers: { ...connection.headers } }),
    defaultToolTimeout: timeout,
  };
}
