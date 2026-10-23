/**
 * 一台 MCP server 的連線那一段：adapter client 的選項、一代連線的形狀、工具結果的錯誤轉換。plugin 每次組裝自己連（CLI）
 * 與宿主的連線池（serve，[`pool.ts`](./pool.ts)）**共用這一份**，兩邊交給 adapter 的選項因此不會漂移。
 *
 * @module
 */

import { ToolMessage } from '@langchain/core/messages';
import type { StructuredTool } from '@langchain/core/tools';
import type { ClientConfig, Connection, MultiServerMCPClient } from '@langchain/mcp-adapters';
import { scrubbedParentEnv } from '@nexus/core';
import { boundArtifacts } from './artifact-bound.js';
import { projectNonText } from './project-content.js';
import { markUntrusted } from './untrusted-mark.js';
import type { McpConfig } from './index.js';

/**
 * 交給 `MultiServerMCPClient` 的整份選項，只放這一台 server。plugin 自己連與池連都從這裡拿（#1677 第 2 步：池建 client 時沿用
 * 同一份，含 `afterToolCall`）。
 */
export function clientOptions(config: McpConfig, elicitation: boolean): ClientConfig {
  return {
    mcpServers: { [config.serverName]: toAdapterConnection(config, elicitation) },
    // 名字由 `publicToolName` 一個地方說了算，所以 adapter 這邊的前綴全部關掉。
    // 開著的話會有兩份拼名字的邏輯，而其中一份不做正規化。
    prefixToolNameWithServerName: false,
    additionalToolNamePrefix: '',
    // 兩格都拋，失敗才全部走到下面同一個 `catch`，收住還是拋由 `failOnStartupError` 一個地方決定。
    throwOnLoadError: true,
    onConnectionError: 'throw',
    // 圖片、音訊這些非文字塊換成文字說明（#642）：模型那一側的工具訊息只收文字。換在工具本體裡，
    // 所以 state、日誌、還原、畫面看到的都是換過的那一份。
    // 同一個鉤子裡也把超過上限的 artifact 換成占位（#1320，`artifact-bound.ts`）：內嵌資源與 structuredContent 否則整份進日誌。
    // 最後在本文前面加一行「外部內容，當資料不當指令」（#1768，`untrusted-mark.ts`）：換完非文字塊之後才加，進日誌的也是標過的那一份。
    afterToolCall: ({ result: [content, artifacts] }) => {
      const body = projectNonText(content) ?? content;
      const marked = markUntrusted(body);
      const bounded = boundArtifacts(artifacts);
      return marked === body && bounded === undefined
        ? undefined
        : { result: [marked, bounded ?? artifacts] };
    },
  };
}

/**
 * 連一代：`tools/list`、拿 SDK client、查指引上限，三步都過才算連上；任何一步拋就是這次嘗試失敗（指引超過上限也算，同 plugin
 * 首連那條）。池的每一代與 plugin 自己連的首連、重連都走這裡（#1824、#1572 N0516）。工具物件只包一次 {@link throwOnToolError}、
 * 不改名，留給呼叫端建自己的委派物件。
 *
 * **`execution.taskSupport: 'required'` 的工具在這裡就改成當場拒絕**，照 dsh（`mcp-client/src/tools.ts:123` 的 `cacheMode: 'refresh'`、`:137` 判 `taskRequired`、`:280` 拋訊息，`687f282e`）：
 * 這個橋不會用 task 執行，請求送出去只會換回伺服器的協定錯誤碼。偏離：dsh 在自己的 bridge 裡讀 `tool.execution`，這裡的工具是
 * adapter 轉出來的，而 `@langchain/mcp-adapters` 2.0.0 轉工具時丟掉了 `execution`（`dist/tools.js` 沒有 `taskSupport` 的任何處理），
 * 所以多對 SDK client 叫一次 `tools/list`（理由 1：基座表達不出來）。
 */
export async function connectGeneration(
  client: MultiServerMCPClient,
  config: McpConfig,
): Promise<Generation & { readonly listed: Listed }> {
  const calls = new Map<string, ToolCall>();
  const tools: StructuredTool[] = [];
  const listed = await client.getTools();
  const sdk = await client.getClient(config.serverName);
  const taskRequired = await taskRequiredNames(sdk, listed.length);
  for (const tool of listed) {
    throwOnToolError(tool);
    if (taskRequired.has(tool.name)) rejectTaskRequired(tool);
    calls.set(tool.name, callOf(tool));
    tools.push(tool);
  }
  const instructions = instructionsOf(sdk?.getInstructions(), config);
  return generationOf(calls, sdk, { tools, instructions }) as Generation & { listed: Listed };
}

/**
 * 這台 server 公告 `execution.taskSupport === 'required'` 的工具名（raw name）。`count` 是 adapter 列出的工具數：一支都沒有就不必問。
 * 分頁照 `nextCursor` 走完；`cacheMode: 'refresh'` 同 dsh，不讀新協議 client 的列表快取。
 */
async function taskRequiredNames(sdk: SdkClient | undefined, count: number): Promise<Set<string>> {
  const names = new Set<string>();
  if (sdk === undefined || count === 0) return names;
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await sdk.listTools(cursor === undefined ? undefined : { cursor }, {
      cacheMode: 'refresh',
    });
    for (const tool of page.tools) {
      if (tool.execution?.taskSupport === 'required') names.add(tool.name);
    }
    cursor = page.nextCursor;
    if (cursor !== undefined && seen.has(cursor)) break;
    if (cursor !== undefined) seen.add(cursor);
  } while (cursor !== undefined);
  return names;
}

/** 讓這個工具的呼叫當場拋 dsh 那一句、不送請求（訊息逐字照抄 `tools.ts:280`）。 */
function rejectTaskRequired(tool: StructuredTool): void {
  const rawName = tool.name;
  (tool as unknown as { func: (...args: unknown[]) => Promise<unknown> }).func = () =>
    Promise.reject(
      new Error(
        `Tool "${rawName}" requires task-based execution, which this bridge does not support`,
      ),
    );
}

/** SDK client 上，這個檔會用到的那幾個方法；結構型別，不直接依賴 `@modelcontextprotocol/client`。 */
export interface SdkClient {
  onclose?: () => void;
  getInstructions(): string | undefined;
  listTools(params?: { cursor: string }, options?: RequestOptions): Promise<ListToolsPage>;
  listResources(params?: { cursor: string }, options?: RequestOptions): Promise<unknown>;
  listResourceTemplates(params?: { cursor: string }, options?: RequestOptions): Promise<unknown>;
  readResource(params: { uri: string }, options?: RequestOptions): Promise<unknown>;
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeout?: number;
  cacheMode?: 'refresh';
}

/** `tools/list` 的一頁，只列這個檔讀的欄位。 */
export interface ListToolsPage {
  readonly tools: readonly { name: string; execution?: { taskSupport?: string } }[];
  readonly nextCursor?: string | undefined;
}

/**
 * 帶出處標頭的 server 指引，照 dsh（`mcp-client/src/connection.ts:318-322`）：空白就沒有；有就是
 * `### MCP server: <name>\n\n<內容>`，**位元組數**（不是字數）超過上限就拋。大括號原樣。
 */
export function instructionsOf(raw: string | undefined, config: McpConfig): string {
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
export interface Generation {
  readonly calls: ReadonlyMap<string, ToolCall>;
  readonly sdk: SdkClient | undefined;
  /** transport 真的關掉了才落定（stdio 是子行程的 close 事件）；沒有 SDK client 的一代沒有東西可等，立刻落定。 */
  readonly closed: Promise<void>;
  /** 監督者掛上的「這一代斷了」通報。 */
  onDown?: () => void;
  /**
   * {@link connectGeneration} 建的一代才有（[#1677](https://github.com/DemianLi/nexus-agent/issues/1677)）：這一代 `tools/list` 列出的
   * adapter 工具物件（已經過 {@link throwOnToolError}、名字仍是 raw name）與帶出處標頭的指引。池的每份組裝照它們建自己的委派物件，
   * 不改這些物件；plugin 自己連的重連也帶著它，但沒有人讀（那條的工具與指引在載入期定了）。
   */
  readonly listed?: Listed;
}

/** {@link connectGeneration} 建的一代多帶的東西，見 {@link Generation.listed}。 */
export interface Listed {
  readonly tools: readonly StructuredTool[];
  readonly instructions: string;
}

/**
 * 建一代，**建的當下**就掛 `onclose`：沒被採用的那一代（dispose 期間才連上的）也要等得到它關掉。先記「關掉了」，再通報斷線。
 */
export function generationOf(
  calls: ReadonlyMap<string, ToolCall>,
  sdk: SdkClient | undefined,
  listed?: Listed,
): Generation {
  if (sdk === undefined)
    return { calls, sdk, closed: Promise.resolve(), ...(listed && { listed }) };
  let markClosed!: () => void;
  const generation: Generation = {
    calls,
    sdk,
    ...(listed && { listed }),
    closed: new Promise<void>((resolve) => {
      markClosed = resolve;
    }),
  };
  sdk.onclose = () => {
    markClosed();
    generation.onDown?.();
  };
  return generation;
}

export type ToolCall = (...args: unknown[]) => Promise<unknown>;

/** 一個工具目前的呼叫（已經過 {@link throwOnToolError} 的那一層）。 */
export function callOf(tool: StructuredTool): ToolCall {
  const func = (tool as unknown as { func: ToolCall }).func;
  return (...args) => func.call(tool, ...args);
}

/**
 * 把 server 回的 `isError` 結果改成**拋**，照 dsh（`throw new Error(text)`）。
 *
 * adapter 2.0.0 在有 `tool_call_id` 時不拋，回一則 `status: 'error'` 的 `ToolMessage`，文字是 server 給的原文、
 * 沒有前綴；1.1.4 是拋 `ToolException`。回訊息的話不經過圍堵（`containment.ts`）那條「拋錯 → `Error: 工具 … 執行失敗：`」
 * 的路，而 Chat Completions 的轉換器只送 content，模型就只看到一段裸文字，分不出這是失敗。拋回去，
 * 失敗的格式（前綴、`status: 'error'`、日誌事件）就跟其他工具共用同一個出口。
 */
export function throwOnToolError(tool: StructuredTool): void {
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
export function textOf(content: ToolMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter((text) => text !== '')
    .join('\n');
}

/** 把我們的連線設定翻成 adapter 收的形狀。 */
export function toAdapterConnection(config: McpConfig, elicitation: boolean): Connection {
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
      // 2.0.0 的現代協定 server 要問使用者（elicitation）時走 LangGraph interrupt，等一次 resume。**有人可以回答才開**
      // （{@link McpConfig.elicitation}）：沒人的話開著會讓那一輪停在沒人接的 interrupt 上；關掉之後 adapter 把這種呼叫當工具失敗，
      // 走一般的錯誤出口。舊協定 server 要問的話需要 `onElicitation`，我們不給，所以它不會宣告這個能力。
      elicitation,
      defaultToolTimeout: timeout,
    };
  }
  return {
    transport: 'http',
    url: connection.url,
    ...(connection.headers !== undefined && { headers: { ...connection.headers } }),
    elicitation,
    defaultToolTimeout: timeout,
  };
}
