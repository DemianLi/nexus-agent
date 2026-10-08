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

import { ToolMessage } from '@langchain/core/messages';
import type { StructuredTool } from '@langchain/core/tools';
import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import type { Connection } from '@langchain/mcp-adapters';
import { scrubbedParentEnv } from '@nexus/core';
import type { AgentMiddleware, NexusPlugin, PluginEntry, PluginRegistry } from '@nexus/core';
import { createMiddleware } from 'langchain';
import { z } from 'zod';
import { SERVER_NAME_PATTERN, publicToolName } from './names.js';
import { projectNonText } from './project-content.js';
import { ensureHub } from './hub.js';
import { Supervisor, reconnectSchema } from './supervisor.js';
import type { ReconnectPolicy } from './supervisor.js';
import type { McpResourceRequest, McpSource } from './hub.js';

export { publicToolName, SERVER_NAME_PATTERN } from './names.js';
export { MCP_HUB_SERVICE, RESOURCE_TOOL_NAMES } from './hub.js';
export { reconnectSchema } from './supervisor.js';
export type { ReconnectPolicy } from './supervisor.js';

/** 帶出處標頭的 server 指引預設上限（UTF-8 位元組），照 dsh 的 `maxInstructionBytes`。 */
export const DEFAULT_MAX_INSTRUCTION_BYTES = 32_768;

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
  /**
   * server 指引（`initialize` 回的 `instructions`）連同出處標頭 `### MCP server: <name>` 的 UTF-8 位元組上限，
   * 照 dsh 的 `maxInstructionBytes`，預設 {@link DEFAULT_MAX_INSTRUCTION_BYTES}。**超過就算這一列連線失敗**（走
   * `failOnStartupError` 那條：預設撤掉工具、收連線、交出警告，寫 `true` 就拋），不截斷——截一半的指引比沒有更糟。
   */
  maxInstructionBytes: z.number().int().positive().default(DEFAULT_MAX_INSTRUCTION_BYTES),
  /**
   * 連線掉了之後的自動重連（[#1099](https://github.com/DemianLi/nexus-agent/issues/1099)），欄位與預設照 dsh 的
   * `reconnect`：`enabled`（`true`）、`initialDelayMs`（500，每次連續失敗加倍）、`maxDelayMs`（30000，退避上限，也是穩定多久
   * 之後失敗次數歸零）、`maxAttempts`（10）。**只管掛上之後才掉的線**；掛上那一刻就連不上的列不重連（見 `supervisor.ts` 檔頭偏離 5）。
   */
  reconnect: reconnectSchema.default(() => reconnectSchema.parse({})),
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
 * **偏離登記（掛上那一刻就連不上的列）**：dsh 連不上之後在背景重連、連上就把工具補上。我們一次組裝之內工具就定了
 * （deepagents 建好就不可變，`packages/nexus-core/src/load.ts` 檔頭），補不了工具，所以這一種不重連；serve 下一條對話重新組裝時會再連一次。
 *
 * **掛上之後才掉的線會自動重連**（[#1099](https://github.com/DemianLi/nexus-agent/issues/1099)），政策照 dsh，實作與偏離見
 * [`supervisor.ts`](./supervisor.ts) 檔頭：已註冊的工具物件換不掉，所以註冊的物件把呼叫委派給目前這一代連線。
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

    const label = `mcp-client(${serverName})`;
    const registered: (() => void)[] = [];
    let supervisor: Supervisor<Generation> | undefined;
    let unregisterSource: (() => void) | undefined;
    // 進度（掉線、第 n 次重連、放棄、連回來）往 `console.warn` 講，照 `session-log.ts`、`sessions.ts` 等執行期通報的慣例（伺服器的
    // stderr 就是 `serve` 的日誌）。**不能走 `registry.logger`**：它只在 `apply` 裡呼叫得動（要指名是誰交的警告），而重連發生在組裝之後。
    const report = (message: string): void => {
      console.warn(message);
    };
    try {
      const first = new Map<string, ToolCall>();
      const names: string[] = [];
      for (const tool of await client.getTools()) {
        const rawName = tool.name;
        throwOnToolError(tool);
        // **先收走這一代的呼叫，再把註冊的物件換成委派**——否則第 0 代的呼叫會指到自己，無窮遞迴。
        first.set(rawName, callOf(tool));
        // 改的是**註冊給模型看的**名字。`tools/call` 送上線的是 adapter 在建這個工具時
        // 就閉包住的 raw name（`convertMcpTools` 裡的 `toolName: tool.name`），不是這個欄位——所以改它不會讓
        // 呼叫送到不存在的工具上。
        tool.name = publicToolName(serverName, rawName);
        delegateTo(tool, rawName, label, () => supervisor);
        names.push(tool.name);
        registered.push(registry.tools.register(tool as StructuredTool));
      }
      // 指引與資源走同一條已經連上的 SDK client，不再經 `MultiServerMCPClient` 開新連線。放在 `try` 裡：
      // 超過上限的指引算連線失敗，要跟列不出工具走同一個出口（撤工具、收連線、警告或拋）。
      const sdk = await client.getClient(serverName);
      const instructions = instructionsOf(sdk?.getInstructions(), config);
      const policy: ReconnectPolicy = config.reconnect;
      const current = (supervisor = new Supervisor<Generation>(
        {
          label,
          policy,
          // 重連 = 把整個 adapter client 收掉再重新列工具：同一個 `MultiServerMCPClient` 在 `close()` 之後再 `getTools()` 會開新連線、
          // 新子行程、新的 SDK client（實測）。舊的工具物件永遠綁著死掉的 client，所以只取它們的呼叫，不取物件。
          async connect() {
            await client.close();
            const calls = new Map<string, ToolCall>();
            for (const tool of await client.getTools()) {
              throwOnToolError(tool);
              calls.set(tool.name, callOf(tool));
            }
            return { calls, sdk: await client.getClient(serverName) };
          },
          close: () => client.close(),
          watch(generation, onDown) {
            if (generation.sdk !== undefined) generation.sdk.onclose = onDown;
          },
          report,
        },
        { calls: first, sdk },
      ));
      // 放棄重連之後，這一台的工具對模型隱藏（dsh 此時把工具從註冊表撤掉；我們的註冊表在組裝之後撤了沒有效果，
      // 所以改在每次模型呼叫前把它們從請求的工具清單拿掉，見 `supervisor.ts` 檔頭偏離 4）。
      registered.push(registry.middleware.use(hideTools(serverName, names, () => current.gaveUp)));
      unregisterSource = ensureHub(registry).add(
        resourceSource(serverName, instructions, config.toolCallTimeoutMs, () => {
          const generation = current.current();
          return generation?.sdk === undefined
            ? undefined
            : {
                sdk: generation.sdk,
                lost: () => {
                  current.down(generation);
                },
              };
        }),
      );
    } catch (error) {
      // **模型看到的是整台伺服器的工具或一個都沒有**，照 dsh：註冊到一半撞了，已經註冊的撤掉（撤銷是冪等的，
      // 之後載入器因為別的理由再撤一次也沒事）。
      for (const undo of registered.reverse()) undo();
      // 回滾期的資源釋放是 plugin 自己的事——`lifecycle` 通道只管關機，而這裡是
      // `apply` 還沒跑完就壞掉，登記根本還沒發生。連線已經開了就得收掉，否則這個
      // 子行程會活過整個行程。收住的那條路也一樣：沒有工具就沒有理由留著它。
      await supervisor?.dispose();
      await client.close().catch(() => {});
      if (config.failOnStartupError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      registry.logger.warn(
        `MCP 伺服器 "${serverName}" 連不上、列不出工具或工具註冊不上，這一次沒有它的工具` +
          `（要讓這一列失敗就寫 failOnStartupError: true）：${reason}`,
      );
      // 照 dsh：資源 provider 的登記不看連線成敗，名字照列、呼叫時才報不可用。**沒有 `failOnStartupError` 的這一列
      // 才登記**——寫了 `true` 的那一列拋出去，不留任何東西在 hub 裡。
      const hubUndo = ensureHub(registry).add(
        resourceSource(serverName, '', config.toolCallTimeoutMs, () => undefined),
      );
      registry.lifecycle.onDispose(hubUndo);
      return;
    }

    registry.lifecycle.onDispose(async () => {
      unregisterSource?.();
      // 先取消待跑的重連、等進行中的那次收斂，再把 adapter client 收掉（連一次都沒連上的間隙也要收）。
      await supervisor.dispose();
      await client.close();
    });
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

/** SDK client 上，這個檔會用到的那幾個方法；結構型別，不直接依賴 `@modelcontextprotocol/client`。 */
interface SdkClient {
  onclose?: () => void;
  getInstructions(): string | undefined;
  listResources(params?: { cursor: string }, options?: RequestOptions): Promise<unknown>;
  listResourceTemplates(params?: { cursor: string }, options?: RequestOptions): Promise<unknown>;
  readResource(params: { uri: string }, options?: RequestOptions): Promise<unknown>;
}

interface RequestOptions {
  signal?: AbortSignal;
  timeout?: number;
}

/**
 * 帶出處標頭的 server 指引，照 dsh（`mcp-client/src/connection.ts:318-322`）：空白就沒有；有就是
 * `### MCP server: <name>\n\n<內容>`，**位元組數**（不是字數）超過上限就拋。大括號原樣。
 */
function instructionsOf(raw: string | undefined, config: McpConfig): string {
  const text = raw?.trimEnd() ?? '';
  if (text.trim() === '') return '';
  const attributed = `### MCP server: ${config.serverName}\n\n${text}`;
  if (Buffer.byteLength(attributed) > config.maxInstructionBytes) {
    throw new Error(
      `server instructions exceed maxInstructionBytes (${String(config.maxInstructionBytes)})`,
    );
  }
  return attributed;
}

/** 一代連線：這一代每個工具的呼叫（以 raw name 為鍵）與它的 SDK client。 */
interface Generation {
  readonly calls: ReadonlyMap<string, ToolCall>;
  readonly sdk: SdkClient | undefined;
}

type ToolCall = (...args: unknown[]) => Promise<unknown>;

/** 一個工具目前的呼叫（已經過 {@link throwOnToolError} 的那一層）。 */
function callOf(tool: StructuredTool): ToolCall {
  const func = (tool as unknown as { func: ToolCall }).func;
  return (...args) => func.call(tool, ...args);
}

/**
 * 連線斷了的錯誤長相：SDK 在 transport 已經關掉之後送請求是 `Not connected`，請求進行到一半被關是 `Connection closed`
 * （MCP 錯誤碼 -32000）。沿 `cause` 往下找。逾時、server 回的 `isError` 都不算。
 */
export function isConnectionLost(error: unknown): boolean {
  for (let current = error, depth = 0; current !== undefined && depth < 5; depth += 1) {
    const message = current instanceof Error ? current.message : String(current);
    if (/\bNot connected\b|\bConnection closed\b|MCP error -32000/u.test(message)) return true;
    current = (current as { cause?: unknown } | null)?.cause;
  }
  return false;
}

/**
 * 把已註冊的工具物件的 `func` 換成「委派給目前這一代同名工具」。註冊表裡的物件換不掉，而 adapter 重連之後它們仍綁著死掉的
 * client，所以呼叫要繞到目前這一代去。照 dsh：斷線期間（沒有目前這一代）工具照樣列著、呼叫失敗。
 */
function delegateTo(
  tool: StructuredTool,
  rawName: string,
  label: string,
  supervisorOf: () => Supervisor<Generation> | undefined,
): void {
  (tool as unknown as { func: ToolCall }).func = async (...args) => {
    const supervisor = supervisorOf();
    const generation = supervisor?.current();
    if (supervisor === undefined || generation === undefined) {
      throw new Error(
        supervisor?.gaveUp === true
          ? `${label}: server is disconnected and reconnection was given up — assemble the plugin again to reconnect`
          : `${label}: server is disconnected`,
      );
    }
    const call = generation.calls.get(rawName);
    if (call === undefined) {
      throw new Error(`${label}: tool "${rawName}" is no longer offered by the server`);
    }
    try {
      return await call(...args);
    } catch (error) {
      if (isConnectionLost(error)) supervisor.down(generation);
      throw error;
    }
  };
}

/** 放棄重連之後，把這一台的工具從每次模型請求的工具清單拿掉；沒放棄就原樣穿過。 */
function hideTools(
  serverName: string,
  names: readonly string[],
  gaveUp: () => boolean,
): AgentMiddleware {
  const hidden = new Set(names);
  return createMiddleware({
    // 每一列一個名字：同名的兩顆 middleware 會在基座那邊撞名。
    name: `mcp-tools-guard:${serverName}`,
    wrapModelCall: (request, handler) => {
      if (!gaveUp()) return handler(request);
      const tools = request.tools.filter(
        (tool) => !hidden.has((tool as { name?: string }).name ?? ''),
      );
      return handler({ ...request, tools });
    },
  }) as AgentMiddleware;
}

/**
 * 一台 server 登記進 hub 的那一份。`acquire` 回目前這一代的 SDK client 與「這一代斷了」的通報；沒有（連不上、掉線等待重連、
 * 已放棄、已關閉）就是 dsh 那句 `server is disconnected`。
 */
function resourceSource(
  serverName: string,
  instructions: string,
  timeout: number,
  acquire: () => { sdk: SdkClient; lost: () => void } | undefined,
): McpSource {
  return {
    serverName,
    instructions,
    async request(request: McpResourceRequest, signal: AbortSignal | undefined): Promise<unknown> {
      const held = acquire();
      if (held === undefined) throw new Error(`mcp-client(${serverName}): server is disconnected`);
      const { sdk } = held;
      const options: RequestOptions = { timeout, ...(signal !== undefined && { signal }) };
      try {
        switch (request.method) {
          case 'resources/list':
            return await sdk.listResources(cursorParams(request.cursor), options);
          case 'resources/templates/list':
            return await sdk.listResourceTemplates(cursorParams(request.cursor), options);
          case 'resources/read':
            return await sdk.readResource({ uri: request.uri }, options);
        }
      } catch (error) {
        if (isConnectionLost(error)) held.lost();
        throw error;
      }
    },
  };
}

function cursorParams(cursor: string | undefined): { cursor: string } | undefined {
  return cursor === undefined ? undefined : { cursor };
}

/**
 * 把 server 回的 `isError` 結果改成**拋**，照 dsh（`throw new Error(text)`）。
 *
 * adapter 2.0.0 在有 `tool_call_id` 時不拋，回一則 `status: 'error'` 的 `ToolMessage`，文字是 server 給的原文、
 * 沒有前綴；1.1.4 是拋 `ToolException`。回訊息的話不經過圍堵（`containment.ts`）那條「拋錯 → `Error: 工具 … 執行失敗：`」
 * 的路，而 Chat Completions 的轉換器只送 content，模型就只看到一段裸文字，分不出這是失敗。拋回去，
 * 失敗的格式（前綴、`status: 'error'`、日誌事件）就跟其他工具共用同一個出口。
 */
function throwOnToolError(tool: StructuredTool): void {
  const inner = (tool as unknown as { func: (...args: unknown[]) => Promise<unknown> }).func;
  (tool as unknown as { func: typeof inner }).func = async (...args) => {
    const result = await inner.call(tool, ...args);
    const message = Array.isArray(result) ? result[0] : result;
    if (ToolMessage.isInstance(message) && message.status === 'error') {
      throw new Error(textOf(message.content));
    }
    return result;
  };
}

/** 一則訊息 content 裡的文字塊，換行接起來。 */
function textOf(content: ToolMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter((text) => text !== '')
    .join('\n');
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
      // 2.0.0 的現代協定 server 要問使用者（elicitation）時，預設走 LangGraph interrupt，等一次 resume。nexus 沒有這條
      // resume 路徑（ask-user 是另一套），開著會讓那一輪停在沒人接的 interrupt 上。關掉之後 adapter 把這種呼叫當工具失敗，
      // 走一般的錯誤出口。舊協定 server 要問的話需要 `onElicitation`，我們不給，所以它不會宣告這個能力。
      elicitation: false,
      defaultToolTimeout: timeout,
    };
  }
  return {
    transport: 'http',
    url: connection.url,
    ...(connection.headers !== undefined && { headers: { ...connection.headers } }),
    elicitation: false,
    defaultToolTimeout: timeout,
  };
}
