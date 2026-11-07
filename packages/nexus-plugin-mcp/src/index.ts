/**
 * `@nexus/plugin-mcp`——把一台外部 MCP server 的工具接進 agent。
 *
 * **樹上的函式插件**（#2533），具名匯出 `name`／`inject`／`Config`／`manifest`／`apply`，**沒有 default**。**一列對一台 server**：
 * 同一顆插件掛多列是合法的，`serverName: 'github'` 與 `serverName: 'linear'` 兩列的工具各在 `mcp__github__*` 與 `mcp__linear__*`
 * 底下。同一條 thread 上兩列用同一個 `serverName`，後來那一列在連線之前就拋（{@link mountServer}）。
 *
 * 連線用 `@modelcontextprotocol/client` 的 SDK client（`connection.ts`），重連監督自己做（`supervisor.ts`）。每顆工具是一個
 * `NexusTool`，`parameters` 是 server 給的 `inputSchema` 原樣（`rawParameters: true`），一次呼叫做什麼見 `tool-call.ts`。
 */

import type { Tool } from '@modelcontextprotocol/client';
import type { Context } from '@nexus/cordis';
import { CHANNEL_SERVICE } from '@nexus/approval-channel';
import type { ApprovalChannel } from '@nexus/approval-channel';
import { defineManifest, injectOf, need, service } from '@nexus/sdk';
import { toolsToken } from '@nexus/tools';
import type { NexusTool, ToolAdmission, ToolThread } from '@nexus/tools';
import { z } from 'zod';
import { SERVER_NAME_PATTERN, publicToolName } from './names.js';
import { mcpApprovalGate, mcpApprovalSchema, unknownExempt } from './approval.js';
import { attemptsOn, closeGeneration, isRequestTimeout, probeLiveness } from './connection.js';
import {
  envValueSchema,
  headerValueSchema,
  MCP_CREDENTIALS_SERVICE,
  resolveCredentials,
} from './credentials.js';
import type { McpCredentials, ResolvedCredentials } from './credentials.js';
import type { Generation, RequestOptions, SdkClient } from './connection.js';
import { ensureHub } from './hub.js';
import { MCP_POOL_SERVICE } from './pool.js';
import type { Acquired, McpConnectionPool } from './pool.js';
import { Supervisor, reconnectSchema } from './supervisor.js';
import type { ReconnectPolicy } from './supervisor.js';
import type { McpResourceRequest, McpSource } from './hub.js';

export { publicToolName, SERVER_NAME_PATTERN } from './names.js';
export { RESOURCE_TOOL_NAMES, UNTRUSTED_CONTENT_PROMPT } from './hub.js';
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

/** 呼叫被放棄之後等探活回應的預設窗口，見 {@link McpConfig.livenessTimeoutMs}。 */
export const DEFAULT_LIVENESS_TIMEOUT_MS = 15_000;

/** {@link McpConfig.livenessTimeoutMs} 的上限：SDK 直接交給 `setTimeout`，超過就溢位成約 1 毫秒，呼叫一逾時就判定卡死。 */
export const MAX_LIVENESS_TIMEOUT_MS = 2_147_483_647;

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

/** 宿主給的 host 服務：沒宣告 `sandbox` 的 stdio 也包一層，宿主行程被硬殺時子行程跟著走（#2197）。包不了回 `undefined`，照舊直接起。 */
export const MCP_GUARD_SERVICE = 'mcpGuard';

/** {@link MCP_GUARD_SERVICE} 收到的東西。 */
export type McpGuardRequest = Pick<McpSandboxRequest, 'command' | 'args' | 'cwd' | 'path'>;

/** 見 {@link MCP_GUARD_SERVICE}。 */
export type McpGuardWrapper = (
  request: McpGuardRequest,
) => Promise<{ readonly command: string; readonly args: readonly string[] } | undefined>;

declare module '@nexus/core' {
  interface NexusServices {
    [MCP_SANDBOX_SERVICE]: McpSandboxWrapper;
    [MCP_GUARD_SERVICE]: McpGuardWrapper;
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
   * 要套沙箱：這個鍵存在就套，`{}` 也算（[#1946](https://github.com/DemianLi/nexus-agent/issues/1946)）。不寫就不套沙箱。
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
   * stdio 的呼叫逾時或被停止之後，等探活回應多久（毫秒）；沒回應就判定 server 卡死，收掉重連。省略即
   * {@link DEFAULT_LIVENESS_TIMEOUT_MS}。一次只處理一個請求的 server，把它調到比最長的呼叫還久。
   */
  livenessTimeoutMs: z
    .number()
    .int()
    .positive()
    .max(MAX_LIVENESS_TIMEOUT_MS)
    .default(DEFAULT_LIVENESS_TIMEOUT_MS),
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
   * 那次呼叫落成普通的工具錯誤。**連線建起來時決定、不留到呼叫時**——新協定把這個 client 能力帶在每次呼叫的 `_meta` 裡，值在
   * 每一代連上、建這一代的工具呼叫時就定了（`tool-call.ts` 的 `toolCallOf`）。serve 的連線池因此把實際的旗標放進鍵（[#1677](https://github.com/DemianLi/nexus-agent/issues/1677)），旗標不同的組裝不共用連線。
   * 寫 `false` 是明著關掉。
   */
  elicitation: z.boolean().default(true),
  /**
   * 哪些工具要先讓人核准（[#1622](https://github.com/DemianLi/nexus-agent/issues/1622)），形狀見 [`approval.ts`](./approval.ts)。
   * **省略即 `{ default: ask }`：整台都問**。唯讀的 server 寫 `{ default: allow }`；`default: ask` 時用 `exempt` 列免問的工具
   * （server 自己公告的名字）。
   */
  approval: mcpApprovalSchema.default(() => mcpApprovalSchema.parse({})),
});

/** 驗過的設定。 */
export type McpConfig = z.infer<typeof mcpConfigSchema>;

/** 一列 mcp 的 config 輸入面（`Config` 解析之前）：清單與測試照這個形狀寫。 */
export type McpPluginOptions = z.input<typeof mcpConfigSchema>;

/** `thread.shared` 上放已預留的 `serverName` 的那一格。 */
const SERVERS = Symbol('mcp:servers');

/**
 * 在一條 thread 上掛一台 server。
 *
 * async 的，裡面做五件事：預留這台伺服器的名字、包裝 command（宣告了 `sandbox` 包進沙箱，其餘 stdio 交給 guard）、連上 server、
 * `tools/list` 拿工具、逐個註冊。五件事**都在組這條 thread 時**——agent 跑起來的時候工具集合已經定了。
 *
 * **失敗分兩類**（[#751](https://github.com/DemianLi/nexus-agent/issues/751)）：
 *
 * - **同一條 thread 上同一個 `serverName` 掛兩次**：不管 {@link McpConfig.failOnStartupError}，後來那一列在連線之前就拋。
 *   名字預留在 `thread.shared`，那一列收掉（或在組裝裡失敗）時釋放。
 * - **套不上沙箱、連不上、列不出工具、工具註冊不上**：預設收住——撤掉這一列已經註冊的工具、收掉連線、經 `thread.logger`
 *   交出一則警告，那一列照樣掛上、這台伺服器沒有工具。寫 `failOnStartupError: true` 才拋。
 *
 * **掛上那一刻就連不上的列，這一條 thread 補不了工具**：一條 thread 組好之後工具就定了（`packages/nexus-core/src/load.ts` 檔頭）。
 * serve 有連線池（[`pool.ts`](./pool.ts)，[#1677](https://github.com/DemianLi/nexus-agent/issues/1677)）在背景重試，連上之後組的 thread 有工具，
 * 之前組好的沒有；CLI 不在背景重試首連。
 *
 * **掛上之後才掉的線會自動重連**（[#1099](https://github.com/DemianLi/nexus-agent/issues/1099)），見 [`supervisor.ts`](./supervisor.ts) 檔頭：
 * 已註冊的工具物件換不掉，所以註冊的物件把呼叫委派給目前這一代連線。
 *
 * **每條 thread 才有的狀態一律活在這裡**：行程級的 {@link apply} 只登記來源；工具、閘門、隱藏規則與 hub 每條
 * thread 各一份。連線在沒有池時（CLI）每條 thread 一份，有池時（serve）向池取用、同一份設定整個行程共用（`pool.ts` 檔頭）。
 *
 * @param thread - 這條 thread。
 * @param declared - 驗過的設定。
 * @throws 同一條 thread 上已有一列掛了同一個 `serverName`；寫了 `failOnStartupError: true` 而這一列起不來。
 */
export async function mountServer(thread: ToolThread, declared: McpConfig): Promise<void> {
  const { serverName } = declared;
  // 名字先佔住，在連線之前：重名是設定寫錯，不是伺服器不在，這一列失敗、不收成警告。
  const slots = thread.shared as { [SERVERS]?: Set<string> };
  const reserved = (slots[SERVERS] ??= new Set());
  if (reserved.has(serverName)) {
    throw new Error(
      `MCP 伺服器 "${serverName}" 在這條 thread 上已經有一列掛了，同一個 serverName 不能掛兩次`,
    );
  }
  reserved.add(serverName);
  thread.onDispose(() => {
    reserved.delete(serverName);
  });
  // 包裝在連線、池之前：之後就是一條 command 換過的 stdio 設定，後面的路徑不必知道沙箱。
  let config: McpConfig;
  try {
    config = await wrapStdio(
      declared,
      thread.services.get(MCP_SANDBOX_SERVICE) as McpSandboxWrapper | undefined,
      thread.services.get(MCP_GUARD_SERVICE) as McpGuardWrapper | undefined,
    );
  } catch (error) {
    unreachable(thread, declared, error);
    return;
  }
  // 有人可以回答才宣告 elicitation 能力；沒人提供 channel 就是沒有答題者（同 ask-user，#669）。
  const channel = thread.services.get(CHANNEL_SERVICE) as ApprovalChannel | undefined;
  const elicitation = config.elicitation && channel?.kind === 'human';
  // 憑證引用在連線之前解析（#1989）：解析不了就是這一列連不上，池裡不留東西。
  let credentials: ResolvedCredentials;
  try {
    credentials = resolveCredentials(
      config,
      thread.services.get(MCP_CREDENTIALS_SERVICE) as McpCredentials | undefined,
    );
  } catch (error) {
    unreachable(thread, config, error);
    return;
  }
  // 宿主給了連線池（serve，#1677）就向池取用，一份設定整台一份連線；沒給（CLI）照舊這次組裝自己連。
  const pool = thread.services.get(MCP_POOL_SERVICE) as McpConnectionPool | undefined;
  if (pool !== undefined) {
    await applyShared(thread, config, await pool.acquire(config, elicitation, credentials));
    return;
  }
  const attempts = attemptsOn(config, elicitation, credentials);
  const label = `mcp-client(${serverName})`;
  const registered: (() => void)[] = [];
  let supervisor: Supervisor<Generation> | undefined;
  let unregisterSource: (() => void) | undefined;
  // 進度（掉線、第 n 次重連、放棄、連回來）交給 `thread.logger`：它記在這一列名下，重連發生在組裝之後也叫得動。外掛不自己寫
  // 標準錯誤，印在哪由 CLI 與 serve 決定。
  const logger = thread.logger;
  const report = (message: string): void => {
    logger.warn(message);
  };
  // dsh 這幾句是 error 級；插件 logger 只有 warn，所以退成 warn（`supervisor.ts` 檔頭偏離 6）。
  const error = report;
  try {
    // 首連與重連、池走同一個 `connectGeneration`（#1572 N0516）：`taskSupport: 'required'` 的拒絕與指引上限只寫一處。
    const first = await attempts.first();
    const names: string[] = [];
    // 核准閘門用的對照：模型叫的是 public name，宣告寫的是 raw name。
    const rawNameOf = new Map<string, string>();
    for (const descriptor of first.listed.tools) {
      const tool = nexusToolOf(descriptor, config, label, () => supervisor);
      names.push(tool.name);
      rawNameOf.set(tool.name, descriptor.name);
      registered.push(thread.register(tool));
    }
    // 閘門跟工具一起進 `registered`：下面任何一步收住或拋，它跟工具一起撤掉，不留一位擋著不存在的工具的 listener。
    const gate = mcpApprovalGate(serverName, config.approval, rawNameOf);
    if (gate !== undefined) registered.push(thread.gate(gate));
    const unknown = unknownExempt(config.approval, rawNameOf.values());
    if (unknown.length > 0) {
      thread.logger.warn(
        `MCP 伺服器 "${serverName}" 的 approval.exempt 有 tools/list 沒列出的名字：${unknown.join('、')}` +
          `（要寫 server 自己公告的名字；沒對到的照 default 被問）`,
      );
    }
    // 指引與資源走同一條已經連上的 SDK client，不另開連線。指引上限已在 `connectGeneration` 查過：
    // 超過上限算連線失敗，跟列不出工具走同一個出口（撤工具、收連線、警告或拋）。
    const { instructions } = first.listed;
    const policy: ReconnectPolicy = config.reconnect;
    const current = (supervisor = new Supervisor<Generation>(
      {
        label,
        policy,
        // 重連 = 收掉上一代的 SDK client、開一個新的再重新列工具：新子行程、新的 HTTP session。註冊的工具不綁哪一代，呼叫時才查目前這一代。
        // 跟池共用 `connectGeneration`：每次重連都查指引上限，超過就算這次嘗試失敗，照 dsh（`mcp-client/src/connection.ts:318-322`，
        // #1824）。新指引只拿來查，不換掉載入期定下的那一份（#1820 偏離 3）。
        connect: () => attempts.connect(),
        abandon: () => attempts.abandon(),
        close: closeGeneration,
        closed: (generation) => generation.closed,
        // dispose 最後收掉最近開的 client：被期限丟下、還在握手的嘗試，或 abandon 沒收乾淨的殘留，連一次都沒連上的也算。
        release: () => attempts.close(),
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
    registered.push(
      thread.admit(
        hiddenAfterGiveUp(names, () => current.gaveUp),
        {
          name: `mcp-tools-guard:${serverName}`,
        },
      ),
    );
    unregisterSource = ensureHub(thread).add(
      resourceSource(serverName, instructions, config.toolCallTimeoutMs, () => {
        const generation = current.current();
        return generation?.sdk === undefined
          ? undefined
          : {
              sdk: generation.sdk,
              lost: () => {
                current.down(generation);
              },
              suspect: () => {
                probeLiveness(generation, () => {
                  current.stalled(generation);
                });
              },
            };
      }),
    );
  } catch (error) {
    // **模型看到的是整台伺服器的工具或一個都沒有**，照 dsh：註冊到一半撞了，已經註冊的撤掉（撤銷是冪等的，
    // 之後載入器因為別的理由再撤一次也沒事）。
    for (const undo of registered.reverse()) undo();
    // 這裡的資源要自己收：`thread.onDispose` 在 try 之後才登記，還沒有人接得到它。連線已經開了就得收掉，否則這個
    // 子行程會活過整個行程。收住的那條路也一樣：沒有工具就沒有理由留著它。
    await supervisor?.dispose();
    await attempts.close();
    unreachable(thread, config, error);
    return;
  }

  thread.onDispose(async () => {
    unregisterSource?.();
    // 取消待跑的重連、等進行中的那次收斂、收掉 client，整段一個期限（#1543）。收 client 在監督者的 `release` 裡，算在同一個期限內；
    // 期限到了還在握手的嘗試，見 `supervisor.ts` 偏離 6。
    await supervisor.dispose();
  });
}

/** 宣告了 `sandbox` 的 stdio 換成包過的，宿主沒給包裝就拋，不退回直接起。沒宣告的 stdio 交給 guard，包不了原樣回；非 stdio 原樣回。 */
async function wrapStdio(
  config: McpConfig,
  wrap: McpSandboxWrapper | undefined,
  guard: McpGuardWrapper | undefined,
): Promise<McpConfig> {
  const { connection } = config;
  if (connection.transport !== 'stdio') return config;
  const path = connection.env?.['PATH'];
  if (connection.sandbox === undefined) {
    const guarded = await guard?.({
      command: connection.command,
      args: connection.args ?? [],
      cwd: connection.cwd,
      path: typeof path === 'string' ? path : undefined,
    });
    if (guarded === undefined) return config;
    return { ...config, connection: { ...connection, ...guarded, args: [...guarded.args] } };
  }
  if (wrap === undefined) throw new Error('這個宿主沒有沙箱，宣告了 sandbox 的 server 不連線');
  const { sandbox, ...rest } = connection;
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
function unreachable(thread: ToolThread, config: McpConfig, error: unknown): void {
  const { serverName } = config;
  if (config.failOnStartupError) throw error;
  const reason = error instanceof Error ? error.message : String(error);
  thread.logger.warn(
    `MCP 伺服器 "${serverName}" 套不上沙箱、連不上、列不出工具或工具註冊不上，這一次沒有它的工具` +
      `（要讓這一列失敗就寫 failOnStartupError: true）：${reason}`,
  );
  const hubUndo = ensureHub(thread).add(
    resourceSource(serverName, '', config.toolCallTimeoutMs, () => undefined),
  );
  thread.onDispose(hubUndo);
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
  thread: ToolThread,
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
    for (const descriptor of listing.tools) {
      // 池裡共用的是工具描述；`NexusTool` 每份組裝建自己的，轉接器照物件身分快取轉出來的 LangChain 工具。
      const tool = nexusToolOf(descriptor, config, label, () => supervisor);
      names.push(tool.name);
      rawNameOf.set(tool.name, descriptor.name);
      registered.push(thread.register(tool));
    }
    // 閘門一份註冊表一顆，同自己連的那條（#1622）；共用的只有連線。
    const gate = mcpApprovalGate(serverName, config.approval, rawNameOf);
    if (gate !== undefined) registered.push(thread.gate(gate));
    const unknown = unknownExempt(config.approval, rawNameOf.values());
    if (unknown.length > 0) {
      thread.logger.warn(
        `MCP 伺服器 "${serverName}" 的 approval.exempt 有 tools/list 沒列出的名字：${unknown.join('、')}` +
          `（要寫 server 自己公告的名字；沒對到的照 default 被問）`,
      );
    }
    registered.push(
      thread.admit(
        hiddenAfterGiveUp(names, () => supervisor.gaveUp),
        {
          name: `mcp-tools-guard:${serverName}`,
        },
      ),
    );
    instructions = listing.instructions;
  } catch (error) {
    for (const undo of registered.reverse()) undo();
    if (config.failOnStartupError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    thread.logger.warn(
      `MCP 伺服器 "${serverName}" 套不上沙箱、連不上、列不出工具或工具註冊不上，這一次沒有它的工具` +
        `（要讓這一列失敗就寫 failOnStartupError: true）：${reason}`,
    );
  }
  // 資源的登記不看連線成敗（照 dsh，同自己連的那條）；讀的是同一個監督者目前這一代，背景連上之後這次組裝的資源也叫得動。
  const unregisterSource = ensureHub(thread).add(
    resourceSource(serverName, instructions, config.toolCallTimeoutMs, () => {
      const generation = supervisor.current();
      return generation?.sdk === undefined
        ? undefined
        : {
            sdk: generation.sdk,
            lost: () => {
              supervisor.down(generation);
            },
            suspect: () => {
              probeLiveness(generation, () => {
                supervisor.stalled(generation);
              });
            },
          };
    }),
  );
  thread.onDispose(unregisterSource);
}

/** 樹上那一列的插件名：橋接列的 `origin.name` 取它，embed 的審批靠它認出 mcp 的工具。 */
export const name = 'mcp';

/** 要宿主的工具接縫 `^2.6.0`：`threadSource` 從 2.5.0 起、`ToolThread.section` 從 2.6.0 起。 */
export const inject = injectOf(need(toolsToken, '^2.6.0'));

/** 這一列的設定。 */
export const Config = mcpConfigSchema;

/** 樹上的宣告：不提供服務，只用工具接縫；每條 thread 組的時候才掛 server，改設定從下一條 thread 起生效。 */
export const manifest = defineManifest({
  id: 'mcp',
  version: '0.6.0',
  owner: '平台團隊',
  provides: [],
  consumes: [{ token: toolsToken.name, range: '^2.6.0' }],
  config: mcpConfigSchema,
  reload: { code: 'restart', config: 'next-thread' },
  capabilities: [],
});

/** {@link mountServer} 讀的宿主服務：`threadSource` 要先宣告，`thread.services.get` 才給。 */
const HOST_SERVICES = [
  CHANNEL_SERVICE,
  MCP_POOL_SERVICE,
  MCP_CREDENTIALS_SERVICE,
  MCP_SANDBOX_SERVICE,
  MCP_GUARD_SERVICE,
] as const;

/**
 * 行程級的那一次：只登記一個逐條 thread 的來源，每條 thread 組的時候才 {@link mountServer}。
 *
 * @param ctx - 這一列的 context。
 * @param config - 驗過的設定。
 * @throws 宿主的工具接縫沒有 `threadSource`。
 */
export function apply(ctx: Context, config: McpConfig): void {
  const tools = service(ctx, toolsToken);
  if (tools.threadSource === undefined) {
    throw new Error('mcp 要宿主的 tools.threadSource()，這個宿主沒有提供');
  }
  tools.threadSource((thread) => mountServer(thread, config), { services: HOST_SERVICES });
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
 * 一顆工具的 `NexusTool`：名字是 public name，`parameters` 是 server 給的 `inputSchema` 原樣，本體「委派給目前這一代同名工具」。
 * 工具不綁哪一代：重連之後的呼叫走新的那一代；斷線期間（沒有目前這一代）工具照樣列著、呼叫失敗。
 *
 * **按了停止之後，呼叫的 reject 換成 `AbortError`**（[#1985](https://github.com/DemianLi/nexus-agent/issues/1985)），斷線判斷在換之前做。
 * `exec.signal` 是這一輪的停止訊號併上 LangGraph 的；LangGraph 那一顆（含 `timeoutMs` 的逾時）舉起時，LangChain 的 `tool()` 已經先 reject
 * 這次呼叫，這裡換不換都沒有人看。
 *
 * **逾時不算斷線**：工具永遠不回的 server 還活著，同一條連線上別的呼叫照常。呼叫被放棄之後才探活，沒回應才收掉重連（#2194）；
 * 收掉時進行中的呼叫回連線關閉、不重送，重連期間的呼叫當場回 `server is disconnected`。
 */
function nexusToolOf(
  descriptor: Tool,
  config: McpConfig,
  label: string,
  supervisorOf: () => Supervisor<Generation> | undefined,
): NexusTool {
  const rawName = descriptor.name;
  return {
    name: publicToolName(config.serverName, rawName),
    description: descriptor.description ?? '',
    parameters: structuredClone(descriptor.inputSchema) as NexusTool['parameters'],
    rawParameters: true,
    timeoutMs: config.toolCallTimeoutMs,
    async execute(args, exec) {
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
        return await call(args, exec);
      } catch (error) {
        if (isConnectionLost(error)) supervisor.down(generation);
        else if (isRequestTimeout(error)) {
          probeLiveness(generation, () => {
            supervisor.stalled(generation);
          });
        }
        throw exec.signal?.aborted === true ? asAbort(error) : error;
      }
    },
  };
}

/** 一次呼叫的 reject 換成 `AbortError`（原錯放在 `cause`），讓圍堵照既有分類記成 `ABORTED`。 */
function asAbort(error: unknown): Error {
  const aborted = new Error(error instanceof Error ? error.message : String(error), {
    cause: error,
  });
  aborted.name = 'AbortError';
  return aborted;
}

/**
 * 放棄重連之後不放行這一台的工具，別的名字一律放行；放棄與否每次問 `gaveUp`，不拍快照。
 *
 * @param names - 這一台註冊的工具名（public name）。
 * @param gaveUp - 監督者是否已放棄重連。
 * @returns 這一台的放行決定。
 */
export function hiddenAfterGiveUp(names: readonly string[], gaveUp: () => boolean): ToolAdmission {
  const hidden = new Set(names);
  return { admits: (name) => !(gaveUp() && hidden.has(name)) };
}

/**
 * 一台 server 登記進 hub 的那一份。`acquire` 回目前這一代的 SDK client 與「這一代斷了」的通報；沒有（連不上、掉線等待重連、
 * 已放棄、已關閉）就是 dsh 那句 `server is disconnected`。逾時或被停止的請求要探活，同工具呼叫（{@link nexusToolOf}）。
 */
function resourceSource(
  serverName: string,
  instructions: string,
  timeout: number,
  acquire: () => { sdk: SdkClient; lost: () => void; suspect: () => void } | undefined,
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
        else if (isRequestTimeout(error)) held.suspect();
        throw error;
      }
    },
  };
}

function cursorParams(cursor: string | undefined): { cursor: string } | undefined {
  return cursor === undefined ? undefined : { cursor };
}
