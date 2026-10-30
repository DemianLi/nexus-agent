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
import { CHANNEL_SERVICE, turnCancelSignalOf } from '@nexus/core';
import type {
  AgentMiddleware,
  ApprovalChannel,
  NexusPlugin,
  PluginEntry,
  PluginRegistry,
} from '@nexus/core';
import { createMiddleware } from 'langchain';
import { z } from 'zod';
import { SERVER_NAME_PATTERN, publicToolName } from './names.js';
import { mcpApprovalGate, mcpApprovalSchema, unknownExempt } from './approval.js';
import { attemptsOn, clientOptions } from './connection.js';
import {
  envValueSchema,
  headerValueSchema,
  MCP_CREDENTIALS_SERVICE,
  resolveCredentials,
} from './credentials.js';
import type { ResolvedCredentials } from './credentials.js';
import type { Generation, RequestOptions, SdkClient, ToolCall } from './connection.js';
import { asTurnAbort, callSignalOf, ensureHub } from './hub.js';
import { MCP_POOL_SERVICE } from './pool.js';
import type { Acquired, McpConnectionPool } from './pool.js';
import { Supervisor, reconnectSchema } from './supervisor.js';
import type { ReconnectPolicy } from './supervisor.js';
import type { McpResourceRequest, McpSource } from './hub.js';

export { publicToolName, SERVER_NAME_PATTERN } from './names.js';
export { MCP_HUB_SERVICE, RESOURCE_TOOL_NAMES, UNTRUSTED_CONTENT_PROMPT } from './hub.js';
export { reconnectSchema } from './supervisor.js';
export { approvalReason, mcpApprovalSchema } from './approval.js';
export type { McpApproval } from './approval.js';
export type { ReconnectPolicy } from './supervisor.js';
export { FIRST_CONNECT_WAIT_MS, MCP_POOL_SERVICE, McpConnectionPool } from './pool.js';
export type { Acquired, McpConnectionPoolOptions, SharedConnection } from './pool.js';
export { CREDENTIAL_REF_PATTERN, MCP_CREDENTIALS_SERVICE } from './credentials.js';
export type { McpCredentials } from './credentials.js';

/** 帶出處標頭的 server 指引預設上限（UTF-8 位元組），照 dsh 的 `maxInstructionBytes`。 */
export const DEFAULT_MAX_INSTRUCTION_BYTES = 32_768;

/** 一次 `tools/call` 的預設逾時，照 dsh 的 `toolCallTimeoutMs`。 */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000;

/** 宿主給的 host 服務：把宣告了 `sandbox` 的 stdio 設定換成包過的 command 與 args。不能套就拋。 */
export const MCP_SANDBOX_SERVICE = 'mcpSandbox';

/** {@link MCP_SANDBOX_SERVICE} 收到的東西。 */
export interface McpSandboxRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string | undefined;
  readonly readable: readonly string[];
  readonly writable: readonly string[];
  /** 這條 connection 自己設的 `PATH`，找 `command` 用。 */
  readonly path?: string | undefined;
}

/** 見 {@link MCP_SANDBOX_SERVICE}。 */
export type McpSandboxWrapper = (
  request: McpSandboxRequest,
) => Promise<{ readonly command: string; readonly args: readonly string[] }>;

declare module '@nexus/core' {
  interface NexusServices {
    [MCP_SANDBOX_SERVICE]: McpSandboxWrapper;
  }
}

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
   * 值可以是字串，或 `{ credential: <名字> }`：建連線那一刻向宿主的憑證服務要值、代入（[#1989](https://github.com/DemianLi/nexus-agent/issues/1989)，
   * 見 [`credentials.ts`](./credentials.ts)）。秘密寫成引用，設定裡只有名字。
   */
  env: z.record(z.string(), envValueSchema).optional(),
  /** 子行程的工作目錄。 */
  cwd: z.string().optional(),
  /**
   * 要套沙箱：這個鍵存在就套，`{}` 也算（[#1946](https://github.com/DemianLi/nexus-agent/issues/1946)）。不寫就是直接起。
   * 連不到網路、讀不到這裡沒列的檔；系統目錄、`command`、`cwd` 由宿主補。不看會話模式。沙箱不可用時不連線。
   */
  sandbox: z
    .strictObject({
      /** 另外讀得到的路徑，例如 server 的程式碼。 */
      readable: z.array(z.string().min(1)).optional(),
      /** 寫得進去的路徑。 */
      writable: z.array(z.string().min(1)).optional(),
    })
    .optional(),
});

/** 走 Streamable HTTP 的 MCP server。 */
export const mcpHttpConnectionSchema = z.strictObject({
  transport: z.literal('http'),
  /** server 的網址。 */
  url: z.string().min(1),
  /**
   * 額外的標頭，例如授權用的。值可以是字串，或 `{ credential: <名字>, prefix?: <前綴> }`：建連線時代入成 `<前綴><值>`
   * （例如 `{ credential: MCP_TOKEN, prefix: 'Bearer ' }`），同 `env`。
   */
  headers: z.record(z.string(), headerValueSchema).optional(),
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
   * 之後失敗次數歸零）、`maxAttempts`（10）。掛上之後才掉的線照這份重連；掛上那一刻就連不上的列，serve（有連線池）照同一份在背景
   * 重試，CLI 不重連（見 `supervisor.ts` 檔頭偏離 5）。
   */
  reconnect: reconnectSchema.default(() => reconnectSchema.parse({})),
  /**
   * 要不要接住 server 執行到一半的反問（elicitation，[#1098](https://github.com/DemianLi/nexus-agent/issues/1098)）。**超出 dsh**：
   * dsh 的 client 宣告的 capabilities 是 `{}`（`packages/mcp/mcp-client/src/connection.ts:261`，`5badb15009`），沒有這個功能。
   *
   * `true`（預設）**不等於一定開**：只有這次組裝有人可以回答（`channel.kind === 'human'`，同 `ask_user_question`）才開，其餘照舊關著，
   * 那次呼叫落成普通的工具錯誤。**連線建起來時決定、不留到呼叫時**——新協定把這個 client 能力帶在每次呼叫的 `_meta` 裡，但值是
   * adapter 在 `getTools` 建工具時就定死的（`@langchain/mcp-adapters` 2.0.0 `dist/tools.js` 的 `createToolInvocation`），呼叫時改不了。
   * serve 的連線池因此把實際的旗標放進鍵（[#1677](https://github.com/DemianLi/nexus-agent/issues/1677)），旗標不同的組裝不共用連線。
   * 寫 `false` 是明著關掉。
   */
  elicitation: z.boolean().default(true),
  /**
   * 哪些工具要先讓人核准（[#1622](https://github.com/DemianLi/nexus-agent/issues/1622)），形狀與偏離見 [`approval.ts`](./approval.ts)。
   * **省略即 `{ default: ask }`：整台都問**。唯讀的 server 寫 `{ default: allow }`；`default: ask` 時用 `exempt` 列免問的工具
   * （server 自己公告的名字）。
   */
  approval: mcpApprovalSchema.default(() => mcpApprovalSchema.parse({})),
});

/** 驗過的設定。 */
export type McpConfig = z.infer<typeof mcpConfigSchema>;

/** 工廠收的東西：schema 的輸入面。 */
export type McpPluginOptions = z.input<typeof mcpConfigSchema>;

/**
 * MCP plugin。
 *
 * `apply` 是 async 的，裡面做五件事：預留這台伺服器的名字、宣告了 `sandbox` 就包進沙箱、連上 server、`tools/list` 拿工具、逐個註冊。四件事
 * **都在載入期**——agent 跑起來的時候工具集合已經定了。
 *
 * **失敗照 dsh 分兩類**（[#751](https://github.com/DemianLi/nexus-agent/issues/751)）：
 *
 * - **同一個 `serverName` 掛兩次**：不管 {@link McpConfig.failOnStartupError}，這一列 `apply` 拋錯。dsh 在連線之前
 *   先預留名字、重複就讓那一個實例失敗（`packages/mcp/mcp-client/src/index.ts:160-176`）。預留用一個服務名
 *   （`mcp:server:<serverName>`）：服務是單一佔位、重名就拋，而且訊息指名兩個 plugin。
 * - **套不上沙箱、連不上、列不出工具、工具註冊不上**：預設收住——撤掉這一列已經註冊的工具、收掉連線、交出一則警告
 *   （`registry.logger`），那一列照樣掛上、這台伺服器沒有工具。寫 `failOnStartupError: true` 才拋。dsh 在初次
 *   同步時也是三種一起管（連線與列工具經 `ready`，註冊經 `registrationFailure`，`connection.ts:130-140`）。
 *
 * 收住的做法是自己 `catch`，不是把 adapter 換成 `onConnectionError: 'ignore'`：那一格只管連線，列不出工具照樣拋，
 * 蓋不到 dsh 的三種。
 *
 * **偏離登記（掛上那一刻就連不上的列）**：dsh 連不上之後在背景重連、連上就把工具補上。我們一次組裝之內工具就定了
 * （deepagents 建好就不可變，`packages/nexus-core/src/load.ts` 檔頭），補不了工具。serve 有連線池（[`pool.ts`](./pool.ts)，
 * [#1677](https://github.com/DemianLi/nexus-agent/issues/1677)），照 dsh 在背景重試，連上之後組的對話有工具，之前組好的沒有；CLI 一次組裝
 * 就是整個行程，不重連。
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
  async apply(registry: PluginRegistry, declared: McpConfig): Promise<void> {
    const { serverName } = declared;
    // 名字先佔住，在連線之前：重名是設定寫錯，不是伺服器不在，照 dsh 讓這一列失敗、不收成警告。
    registry.services.provide(`mcp:server:${serverName}`, { serverName });
    // 包裝在連線、池之前：拿掉 `sandbox` 鍵之後就是一條 command 換過的 stdio 設定，之後的路徑不必知道沙箱。
    let config: McpConfig;
    try {
      config = await confined(declared, registry.services.get(MCP_SANDBOX_SERVICE));
    } catch (error) {
      unreachable(registry, declared, error);
      return;
    }
    // 有人可以回答才宣告 elicitation 能力；沒人提供 channel 就是沒有答題者（同 ask-user，#669）。
    const channel: ApprovalChannel | undefined = registry.services.get(CHANNEL_SERVICE);
    const elicitation = config.elicitation && channel?.kind === 'human';
    // 憑證引用在連線之前解析（#1989）：解析不了就是這一列連不上，池裡不留東西。
    let credentials: ResolvedCredentials;
    try {
      credentials = resolveCredentials(config, registry.services.get(MCP_CREDENTIALS_SERVICE));
    } catch (error) {
      unreachable(registry, config, error);
      return;
    }
    // 宿主給了連線池（serve，#1677）就向池取用，一份設定整台一份連線；沒給（CLI）照舊這次組裝自己連。
    const pool: McpConnectionPool | undefined = registry.services.get(MCP_POOL_SERVICE);
    if (pool !== undefined) {
      await applyShared(registry, config, await pool.acquire(config, elicitation, credentials));
      return;
    }
    const client = new MultiServerMCPClient(clientOptions(config, elicitation, credentials));
    const label = `mcp-client(${serverName})`;
    const registered: (() => void)[] = [];
    let supervisor: Supervisor<Generation> | undefined;
    let unregisterSource: (() => void) | undefined;
    // 進度（掉線、第 n 次重連、放棄、連回來）交給 `registry.logger`：`bind()` 在 `apply` 裡把「是誰」綁進去，重連發生在組裝之後
    // 也叫得動。外掛不自己寫標準錯誤，印在哪由 CLI 與 serve 決定。
    const logger = registry.logger.bind();
    const report = (message: string): void => {
      logger.warn(message);
    };
    // dsh 這幾句是 error 級；插件 logger 只有 warn，所以退成 warn（`supervisor.ts` 檔頭偏離 6）。
    const error = report;
    try {
      // 首連與重連、池走同一個 `connectGeneration`（#1572 N0516）：`taskSupport: 'required'` 的拒絕與指引上限只寫一處。
      const attempts = attemptsOn(client, config);
      const first = await attempts.first();
      const names: string[] = [];
      // 核准閘門用的對照：模型叫的是 public name，宣告寫的是 raw name。
      const rawNameOf = new Map<string, string>();
      for (const tool of first.listed.tools) {
        const rawName = tool.name;
        // **呼叫已在 `connectGeneration` 收進這一代，這裡才把註冊的物件換成委派**——否則第 0 代的呼叫會指到自己，無窮遞迴。
        // 改的是**註冊給模型看的**名字。`tools/call` 送上線的是 adapter 在建這個工具時
        // 就閉包住的 raw name（`convertMcpTools` 裡的 `toolName: tool.name`），不是這個欄位——所以改它不會讓
        // 呼叫送到不存在的工具上。
        tool.name = publicToolName(serverName, rawName);
        delegateTo(tool, rawName, label, () => supervisor);
        names.push(tool.name);
        rawNameOf.set(tool.name, rawName);
        registered.push(registry.tools.register(tool as StructuredTool));
      }
      // 閘門跟工具一起進 `registered`：下面任何一步收住或拋，它跟工具一起撤掉，不留一位擋著不存在的工具的 listener。
      const gate = mcpApprovalGate(serverName, config.approval, rawNameOf);
      if (gate !== undefined) registered.push(registry.approvals.gate(gate));
      const unknown = unknownExempt(config.approval, rawNameOf.values());
      if (unknown.length > 0) {
        registry.logger.warn(
          `MCP 伺服器 "${serverName}" 的 approval.exempt 有 tools/list 沒列出的名字：${unknown.join('、')}` +
            `（要寫 server 自己公告的名字；沒對到的照 default 被問）`,
        );
      }
      // 指引與資源走同一條已經連上的 SDK client，不再經 `MultiServerMCPClient` 開新連線。指引上限已在 `connectGeneration` 查過：
      // 超過上限算連線失敗，跟列不出工具走同一個出口（撤工具、收連線、警告或拋）。
      const { instructions } = first.listed;
      const policy: ReconnectPolicy = config.reconnect;
      const current = (supervisor = new Supervisor<Generation>(
        {
          label,
          policy,
          // 重連 = 把整個 adapter client 收掉再重新列工具：同一個 `MultiServerMCPClient` 在 `close()` 之後再 `getTools()` 會開新連線、
          // 新子行程、新的 SDK client（實測）。舊的工具物件永遠綁著死掉的 client，所以只取它們的呼叫，不取物件。
          // 跟池共用 `connectGeneration`：每次重連都查指引上限，超過就算這次嘗試失敗，照 dsh（`mcp-client/src/connection.ts:318-322`，
          // #1824）。新指引只拿來查，不換掉載入期定下的那一份（#1820 偏離 3）。
          connect: () => attempts.connect(),
          abandon: () => attempts.abandon(),
          close: () => client.close(),
          closed: (generation) => generation.closed,
          // dispose 最後把整個 adapter 收掉：被期限丟下、還在握手的嘗試，或 abandon 沒收乾淨的殘留，連一次都沒連上的也算。
          release: () => client.close(),
          watch(generation, onDown) {
            generation.onDown = onDown;
          },
          report,
          error,
        },
        first,
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
      unreachable(registry, config, error);
      return;
    }

    registry.lifecycle.onDispose(async () => {
      unregisterSource?.();
      // 取消待跑的重連、等進行中的那次收斂、收掉 adapter client，整段一個期限（#1543）。不要在後面再 `await client.close()`：
      // adapter 的 `close()` 也先等進行中的握手，會把期限白白疊上去。
      await supervisor.dispose();
    });
  },
};

export default mcpPlugin;

/** 宣告了 `sandbox` 的 stdio 換成包過的；沒宣告原樣回。宿主沒給包裝就拋，不退回直接起。 */
async function confined(
  config: McpConfig,
  wrap: McpSandboxWrapper | undefined,
): Promise<McpConfig> {
  const { connection } = config;
  if (connection.transport !== 'stdio' || connection.sandbox === undefined) return config;
  if (wrap === undefined) throw new Error('這個宿主沒有沙箱，宣告了 sandbox 的 server 不連線');
  const { sandbox, ...rest } = connection;
  const path = connection.env?.['PATH'];
  const wrapped = await wrap({
    command: connection.command,
    args: connection.args ?? [],
    cwd: connection.cwd,
    readable: sandbox.readable ?? [],
    writable: sandbox.writable ?? [],
    path: typeof path === 'string' ? path : undefined,
  });
  return { ...config, connection: { ...rest, command: wrapped.command, args: [...wrapped.args] } };
}

/**
 * 這一列連不上（沙箱包裝不了，憑證解析不了，或自己連時連不上、列不出工具、註冊不上）的出口：寫了 `failOnStartupError` 就拋，否則警告、
 * 這一次沒有工具。
 *
 * 資源 provider 的登記不看連線成敗：名字照列，呼叫時才報不可用。**沒有 `failOnStartupError` 的這一列才登記**——寫了 `true`
 * 的那一列拋出去，不在 hub 留任何東西。
 */
function unreachable(registry: PluginRegistry, config: McpConfig, error: unknown): void {
  const { serverName } = config;
  if (config.failOnStartupError) throw error;
  const reason = error instanceof Error ? error.message : String(error);
  registry.logger.warn(
    `MCP 伺服器 "${serverName}" 套不上沙箱、連不上、列不出工具或工具註冊不上，這一次沒有它的工具` +
      `（要讓這一列失敗就寫 failOnStartupError: true）：${reason}`,
  );
  const hubUndo = ensureHub(registry).add(
    resourceSource(serverName, '', config.toolCallTimeoutMs, () => undefined),
  );
  registry.lifecycle.onDispose(hubUndo);
}

/**
 * 有池時的 `apply`（[#1677](https://github.com/DemianLi/nexus-agent/issues/1677)）。向池取來的那一份連線**不屬於這次組裝**：這裡
 * 只登記、只撤這份註冊表的東西，收住或拋都不關連線，`onDispose` 也只撤登記。
 *
 * **一次組裝從頭到尾綁取用當下的那個監督者**：委派、放棄後隱藏、資源三處讀的都是它。池替已放棄的那一份重開之後，開著的 thread
 * 照舊停在舊的監督者上（工具隱藏、呼叫說已放棄），新 thread 拿到新的（Q5 (b)）。三處讀不同的來源的話，工具會藏起來卻叫得動。
 *
 * **斷線空窗裡照最近一代的工具清單登記**（照 dsh，見 `pool.ts` 檔頭）：委派讀目前這一代，空窗期呼叫回 `server is disconnected`，
 * 重連之後叫得動。
 *
 * 失敗的分法同自己連的那條：一代都還沒連上過（第一次就連不上、或還在連而等到了期限）、註冊不上，都是撤掉這份註冊表已經登記的、
 * 交出警告，寫了 `failOnStartupError: true` 就拋。
 */
async function applyShared(
  registry: PluginRegistry,
  config: McpConfig,
  { shared, error: connectError }: Acquired,
): Promise<void> {
  const { serverName } = config;
  const { label, supervisor } = shared;
  const registered: (() => void)[] = [];
  let instructions = '';
  try {
    const listing = shared.listed();
    if (listing === undefined) {
      throw connectError ?? new Error(`${label}: server is disconnected`);
    }
    const names: string[] = [];
    const rawNameOf = new Map<string, string>();
    for (const listed of listing.tools) {
      const rawName = listed.name;
      // 池裡的物件每份組裝共用，不改；改名與委派都做在這份組裝自己的那一個上。
      const tool = borrowed(listed);
      tool.name = publicToolName(serverName, rawName);
      delegateTo(tool, rawName, label, () => supervisor);
      names.push(tool.name);
      rawNameOf.set(tool.name, rawName);
      registered.push(registry.tools.register(tool));
    }
    // 閘門一份註冊表一顆，同自己連的那條（#1622）；共用的只有連線。
    const gate = mcpApprovalGate(serverName, config.approval, rawNameOf);
    if (gate !== undefined) registered.push(registry.approvals.gate(gate));
    const unknown = unknownExempt(config.approval, rawNameOf.values());
    if (unknown.length > 0) {
      registry.logger.warn(
        `MCP 伺服器 "${serverName}" 的 approval.exempt 有 tools/list 沒列出的名字：${unknown.join('、')}` +
          `（要寫 server 自己公告的名字；沒對到的照 default 被問）`,
      );
    }
    registered.push(registry.middleware.use(hideTools(serverName, names, () => supervisor.gaveUp)));
    instructions = listing.instructions;
  } catch (error) {
    for (const undo of registered.reverse()) undo();
    if (config.failOnStartupError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    registry.logger.warn(
      `MCP 伺服器 "${serverName}" 套不上沙箱、連不上、列不出工具或工具註冊不上，這一次沒有它的工具` +
        `（要讓這一列失敗就寫 failOnStartupError: true）：${reason}`,
    );
  }
  // 資源的登記不看連線成敗（照 dsh，同自己連的那條）；讀的是同一個監督者目前這一代，背景連上之後這次組裝的資源也叫得動。
  const unregisterSource = ensureHub(registry).add(
    resourceSource(serverName, instructions, config.toolCallTimeoutMs, () => {
      const generation = supervisor.current();
      return generation?.sdk === undefined
        ? undefined
        : {
            sdk: generation.sdk,
            lost: () => {
              supervisor.down(generation);
            },
          };
    }),
  );
  registry.lifecycle.onDispose(unregisterSource);
}

/**
 * 這份組裝自己的工具物件：原型照池裡那一個、自有欄位**淺拷貝**一份。之後只改這一份的 `name` 與 `func`，池裡的不動——直接改的話，
 * 第二份組裝會再包一層委派、名字也已經被第一份改過。
 *
 * **淺拷貝**：欄位裡的物件（`schema`、`metadata`、`tags`、`lc_kwargs`、`defaultConfig`）每份組裝與池裡那一個共用同一份。今天沒有
 * 人就地改它們（只換 `name` 與 `func` 這兩格本身）；要改的話先換成自己的一份，不要就地改。
 */
function borrowed(tool: StructuredTool): StructuredTool {
  return Object.assign(
    Object.create(Object.getPrototypeOf(tool) as object) as StructuredTool,
    tool,
  );
}

/**
 * 建一個條目。**薄薄一層**：設定不在這裡驗，驗在載入的時候——那時候才有 id 可以指名。
 *
 * @param options - 設定，形狀見 {@link mcpConfigSchema}。
 * @returns 可以放進組裝點清單的條目。
 */
export function createMcpPlugin(options: McpPluginOptions): PluginEntry {
  return { plugin: mcpPlugin, config: options };
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
 * client，所以呼叫要繞到目前這一代去。斷線期間（沒有目前這一代）工具照樣列著、呼叫失敗。
 *
 * **這一輪的停止訊號在這裡併進交給 adapter 的 config**（[#1985](https://github.com/DemianLi/nexus-agent/issues/1985)，見
 * {@link callSignalOf}）。adapter 的工具不拿 `config.signal` 跟本體競速，所以放在這一層不會丟下呼叫。按了停止之後，呼叫的 reject
 * 換成 `AbortError`（{@link asTurnAbort}），斷線判斷在換之前做。
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
      return await call(...withTurnSignal(args));
    } catch (error) {
      if (isConnectionLost(error)) supervisor.down(generation);
      throw asTurnAbort(error, args[2]);
    }
  };
}

/**
 * `func` 的參數（輸入、run manager、config）裡，把 config 的 `signal` 換成 {@link callSignalOf}（併上這一輪的停止訊號）。
 * 換一份新的 config，不改呼叫端那份。
 * @param args - 工具物件交給 `func` 的參數，原樣。
 * @returns 換過訊號的參數；這一輪沒有停止訊號時原樣回去。
 */
function withTurnSignal(args: unknown[]): unknown[] {
  const config = args[2] as object | undefined;
  if (turnCancelSignalOf(config) === undefined) return args;
  return [args[0], args[1], { ...config, signal: callSignalOf(config) }, ...args.slice(3)];
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
