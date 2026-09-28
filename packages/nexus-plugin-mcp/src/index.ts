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
import { scrubbedParentEnv } from '@nexus/core';
import type { NexusPlugin, PluginEntry, PluginRegistry } from '@nexus/core';
import { z } from 'zod';
import { SERVER_NAME_PATTERN, publicToolName } from './names.js';
import { projectNonText } from './project-content.js';

export { publicToolName, SERVER_NAME_PATTERN } from './names.js';

/**
 * 這個 plugin 宣告的能力名。要相依「有 MCP 工具在」的 plugin 把它放進自己的 `requires`。**連上、工具也註冊好了才宣告**：
 * 連不上而照樣掛上的那一列沒有工具，不宣告（見 {@link mcpPlugin}）。
 */
export const MCP_CAPABILITY = 'mcp';

/** 一次 `tools/call` 的預設逾時，照 dsh 的 `toolCallTimeoutMs`。 */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000;

/** 以子行程方式啟動的 MCP server。 */
export const mcpStdioConnectionSchema = z.strictObject({
  transport: z.literal('stdio'),
  /** 要執行的程式。 */
  command: z.string().min(1),
  /** 傳給它的參數。 */
  args: z.array(z.string()).optional(),
  /**
   * 額外的環境變數，**疊在清洗過的父環境上**（#726，照 dsh）：子行程拿到的是這個行程的環境扣掉名字像憑證的
   * （`/KEY|PASSWORD|SECRET|TOKEN/i`）與 `NEXUS_*`，再疊這一格。所以語系、代理、CA 這類不必逐個填；要交給
   * server 的憑證（例如 `GITHUB_TOKEN`）得明著寫在這裡，同名時這一格的值蓋過父環境的。
   *
   * **秘密只從呼叫端的環境變數來**（`docs/standards.md`）：這裡收的是值，寫死 token 的
   * 地方不在這個型別裡，而在填它的那一行。
   */
  env: z.record(z.string(), z.string()).optional(),
  /** 子行程的工作目錄。 */
  cwd: z.string().optional(),
});

/** 走 Streamable HTTP 的 MCP server。 */
export const mcpHttpConnectionSchema = z.strictObject({
  transport: z.literal('http'),
  /** server 的網址。 */
  url: z.string().min(1),
  /** 額外的標頭，例如授權用的。 */
  headers: z.record(z.string(), z.string()).optional(),
});

/**
 * 怎麼連上它。
 *
 * **判別式聯集，不是一般聯集**：`transport` 選定分支之後，錯誤訊息指得到是哪一格打錯；
 * 一般聯集會把兩個分支的抱怨一起印出來，而其中一半必然是無關的。
 */
export const mcpConnectionSchema = z.discriminatedUnion('transport', [
  mcpStdioConnectionSchema,
  mcpHttpConnectionSchema,
]);

/** 以子行程方式啟動的 MCP server。 */
export type McpStdioConnection = z.infer<typeof mcpStdioConnectionSchema>;

/** 走 Streamable HTTP 的 MCP server。 */
export type McpHttpConnection = z.infer<typeof mcpHttpConnectionSchema>;

/** 這個 plugin 的設定。 */
export const mcpConfigSchema = z.strictObject({
  /**
   * 這一台 server 的命名空間，會成為工具名的一段。
   *
   * 形狀照 dsh：`[A-Za-z0-9_-]{1,32}`。它會成為工具名的一段（`mcp__<serverName>__…`），
   * 而供應商的 function name 契約不收其他字元。
   */
  serverName: z.string().regex(SERVER_NAME_PATTERN, 'serverName 只能是 1 到 32 個 [A-Za-z0-9_-]'),
  /** 怎麼連上它。 */
  connection: mcpConnectionSchema,
  /** 一次 `tools/call` 的逾時。省略即 {@link DEFAULT_TOOL_CALL_TIMEOUT_MS}。 */
  toolCallTimeoutMs: z.number().int().positive().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
  /**
   * 掛上那一刻連不上、列不出工具、或工具註冊不上時，要不要讓這一列失敗。照 dsh 的 `failOnStartupError`，**預設
   * `false`**：那一列照樣掛上、這台伺服器沒有工具、交出一則警告。寫 `true` 就在 `apply` 裡拋——清單上的可少掛列
   * 因此掉了（啟動時的警告指名它），手搭清單則整個載入失敗（dsh `packages/mcp/mcp-client/src/index.ts:194-202`，
   * `477b4f4`）。
   */
  failOnStartupError: z.boolean().default(false),
});

/** 驗過的設定。 */
export type McpConfig = z.infer<typeof mcpConfigSchema>;

/** 工廠收的東西：schema 的輸入面。 */
export type McpPluginOptions = z.input<typeof mcpConfigSchema>;

/**
 * MCP plugin。
 *
 * `apply` 是 async 的，裡面做四件事：預留這台伺服器的名字、連上 server、`tools/list` 拿工具、逐個註冊。四件事
 * **都在載入期**——agent 跑起來的時候工具集合已經定了。
 *
 * **失敗照 dsh 分兩類**（[#751](https://github.com/DemianLi/nexus-agent/issues/751)）：
 *
 * - **同一個 `serverName` 掛兩次**：不管 {@link McpConfig.failOnStartupError}，這一列 `apply` 拋錯。dsh 在連線之前
 *   先預留名字、重複就讓那一個實例失敗（`packages/mcp/mcp-client/src/index.ts:160-176`）。預留用一個服務名
 *   （`mcp:server:<serverName>`）：服務是單一佔位、重名就拋，而且訊息指名兩個 plugin。
 * - **連不上、列不出工具、工具註冊不上**：預設收住——撤掉這一列已經註冊的工具、收掉連線、交出一則警告
 *   （`registry.logger`），那一列照樣掛上、這台伺服器沒有工具。寫 `failOnStartupError: true` 才拋。dsh 在初次
 *   同步時也是三種一起管（連線與列工具經 `ready`，註冊經 `registrationFailure`，`connection.ts:130-140`）。
 *
 * 收住的做法是自己 `catch`，不是把 adapter 換成 `onConnectionError: 'ignore'`：那一格只管連線，列不出工具照樣拋，
 * 蓋不到 dsh 的三種。
 *
 * **偏離登記**：dsh 連不上之後在背景重連、連上就把工具補上。我們一次組裝之內工具就定了（deepagents 建好就不可變，
 * `packages/nexus-core/src/load.ts` 檔頭），不重連；serve 下一條對話重新組裝時會再連一次。
 *
 * **模組層級的一顆常數**，給 [#454](https://github.com/DemianLi/nexus-agent/issues/454)
 * 從設定檔 import。設定走 {@link Config} 進來，所以同一顆可以被好幾次組裝各 `apply` 一次
 * ——**每次掛載才有的狀態一律活在 `apply` 裡**。
 */
export const mcpPlugin: NexusPlugin<McpConfig> = {
  name: 'mcp',
  Config: mcpConfigSchema,
  async apply(registry: PluginRegistry, config: McpConfig): Promise<void> {
    const { serverName } = config;
    // 名字先佔住，在連線之前：重名是設定寫錯，不是伺服器不在，照 dsh 讓這一列失敗、不收成警告。
    registry.services.provide(`mcp:server:${serverName}`, { serverName });
    const client = new MultiServerMCPClient({
      mcpServers: { [serverName]: toAdapterConnection(config) },
      // 名字由 `publicToolName` 一個地方說了算，所以 adapter 這邊的前綴全部關掉。
      // 開著的話會有兩份拼名字的邏輯，而其中一份不做正規化。
      prefixToolNameWithServerName: false,
      additionalToolNamePrefix: '',
      // 兩格都拋，失敗才全部走到下面同一個 `catch`，收住還是拋由 `failOnStartupError` 一個地方決定。
      throwOnLoadError: true,
      onConnectionError: 'throw',
      // 圖片、音訊這些非文字塊換成文字說明（#642）：模型那一側的工具訊息只收文字。換在工具本體裡，
      // 所以 state、日誌、還原、畫面看到的都是換過的那一份。
      afterToolCall: ({ result: [content, artifacts] }) => {
        const projected = projectNonText(content);
        return projected === undefined ? undefined : { result: [projected, artifacts] };
      },
    });

    const registered: (() => void)[] = [];
    try {
      for (const tool of await client.getTools()) {
        // 改的是**註冊給模型看的**名字。`tools/call` 送上線的是 adapter 在建這個工具時
        // 就閉包住的 raw name（`dist/tools.js:456`），不是這個欄位——所以改它不會讓
        // 呼叫送到不存在的工具上。
        tool.name = publicToolName(serverName, tool.name);
        registered.push(registry.tools.register(tool as StructuredTool));
      }
    } catch (error) {
      // **模型看到的是整台伺服器的工具或一個都沒有**，照 dsh：註冊到一半撞了，已經註冊的撤掉（撤銷是冪等的，
      // 之後載入器因為別的理由再撤一次也沒事）。
      for (const undo of registered.reverse()) undo();
      // 回滾期的資源釋放是 plugin 自己的事——`lifecycle` 通道只管關機，而這裡是
      // `apply` 還沒跑完就壞掉，登記根本還沒發生。連線已經開了就得收掉，否則這個
      // 子行程會活過整個行程。收住的那條路也一樣：沒有工具就沒有理由留著它。
      await client.close().catch(() => {});
      if (config.failOnStartupError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      registry.logger.warn(
        `MCP 伺服器 "${serverName}" 連不上、列不出工具或工具註冊不上，這一次沒有它的工具` +
          `（要讓這一列失敗就寫 failOnStartupError: true）：${reason}`,
      );
      // 不宣告 `MCP_CAPABILITY`：它說的是「有 MCP 工具在」，這台一個都沒有。
      return;
    }

    registry.capabilities.provide(MCP_CAPABILITY);
    registry.lifecycle.onDispose(() => client.close());
  },
};

export default mcpPlugin;

/**
 * 建一個條目。**薄薄一層**：設定不在這裡驗，驗在載入的時候——那時候才有 id 可以指名。
 *
 * @param options - 設定，形狀見 {@link mcpConfigSchema}。
 * @returns 可以放進組裝點清單的條目。
 */
export function createMcpPlugin(options: McpPluginOptions): PluginEntry {
  return { plugin: mcpPlugin, config: options };
}

/** 把我們的連線設定翻成 adapter 收的形狀。 */
function toAdapterConnection(config: McpConfig): Connection {
  const timeout = config.toolCallTimeoutMs;
  const connection = config.connection;
  if (connection.transport === 'stdio') {
    return {
      transport: 'stdio',
      command: connection.command,
      // adapter 的 stdio schema 把 `args` 列為必填，沒有參數的 server 也要給一個空陣列。
      args: [...(connection.args ?? [])],
      // **一律傳整份**，照 dsh 的 `buildChildEnv`（`packages/mcp/mcp-client/src/transport.ts:22`，`477b4f4`）：清洗過的
      // 父環境在前、設定的在後。不傳或只傳設定那幾格的話，底由 adapter（只補 `PATH`）與 SDK
      // （`getDefaultEnvironment()`，六個名字）決定，語系與代理都到不了子行程。
      env: { ...scrubbedParentEnv(), ...connection.env },
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
