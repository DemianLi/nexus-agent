/**
 * 一台 MCP server 的連線那一段：開一代 SDK client、一代連線的形狀、這一代每顆工具的呼叫。plugin 每次組裝自己連（CLI）
 * 與宿主的連線池（serve，[`pool.ts`](./pool.ts)）**共用這一份**，兩邊開連線的方式因此不會漂移。
 *
 * **一代一個 SDK client**：重連就是收掉上一代的 client、開一個新的（新子行程、新的 HTTP session）。開連線的做法照
 * `@langchain/mcp-adapters@2.0.0`（`dist/connection.js`、`dist/client.js` 的 `_initializeStreamableHTTPConnection`）：版本協商 `auto`，
 * HTTP 先試 Streamable HTTP，回 404／405 再退回 SSE（先試原網址，再試把結尾的 `mcp` 換成 `sse`），SSE 走舊協議。
 *
 * @module
 */

import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import type { Tool } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { scrubbedParentEnv } from '@nexus/subprocess';
import { redactorFor, substituted } from './credentials.js';
import type { ResolvedCredentials } from './credentials.js';
import type { McpConfig } from './index.js';
import { PLACEHOLDER, scrubbedCopy } from './redact.js';
import type { Redactor } from './redact.js';
import { toolCallOf } from './tool-call.js';
import type { ToolCall } from './tool-call.js';

export type { ToolCall } from './tool-call.js';

/** 握手時報給 server 的 client 身分。 */
const CLIENT_IDENTITY = { name: '@nexus/plugin-mcp', version: '0.6.0' };

/**
 * 連一代：開 SDK client、`tools/list`（分頁走完）、查指引上限，三步都過才算連上；任何一步拋就是這次嘗試失敗（指引超過上限也算，
 * 同 plugin 首連那條）。池的每一代與 plugin 自己連的首連、重連都走這裡（#1824、#1572 N0516）。
 *
 * 一開 client 就建這一代、掛上 `onclose`，並把「真的關掉了」交給 `onAttached`：之後哪一步拋，呼叫端都等得到這次嘗試開的
 * 子行程關掉（[#1835](https://github.com/DemianLi/nexus-agent/issues/1835)）。握手就失敗的嘗試沒有連上的 client，不會叫它。
 *
 * **`execution.taskSupport: 'required'` 的工具一律當場拒絕**，照 dsh（`mcp-client/src/tools.ts:137` 判 `taskRequired`、`:280` 拋訊息，`687f282e`）：
 * 這個橋不會用 task 執行，請求送出去只會換回伺服器的協定錯誤碼。
 *
 * @param redactor - 這一份連線的憑證值：`tools/list` 失敗的訊息與 `cause` 送出前遮掉，經 {@link toolCallOf} 的工具呼叫錯誤與 `rejectTaskRequired` 的錯誤也靠它遮。HTTP 連線要連網址的 query 一起遮（{@link withUrlScrubbing}）；沒有東西要遮就傳 `NO_REDACTION`。
 */
export async function connectGeneration(
  connect: () => Promise<Client>,
  config: McpConfig,
  elicitation: boolean,
  redactor: Redactor,
  onAttached?: (closed: Promise<void>) => void,
): Promise<ListedGeneration> {
  const client = await connect();
  const calls = new Map<string, ToolCall>();
  const generation = generationOf(calls, client);
  onAttached?.(generation.closed);
  const tools = await listAllTools(client, config.serverName, redactor);
  for (const tool of tools) {
    calls.set(
      tool.name,
      tool.execution?.taskSupport === 'required'
        ? rejectTaskRequired(tool.name, redactor)
        : toolCallOf(client, config.serverName, tool, {
            elicitation,
            timeoutMs: config.toolCallTimeoutMs,
            redactor,
          }),
    );
  }
  const instructions = instructionsOf(client.getInstructions(), config);
  // 補在同一個物件上：`onclose` 通報的是建的當下那一個。
  return Object.assign(generation, {
    listed: { tools, instructions },
    ...(config.connection.transport === 'stdio' && {
      livenessTimeoutMs: config.livenessTimeoutMs,
    }),
  });
}

/** {@link connectGeneration} 連成的一代。 */
export type ListedGeneration = Generation & { readonly listed: Listed };

/** 一份設定上的連線嘗試，見 {@link attemptsOn}。 */
export interface Attempts {
  /** 第一次連線。 */
  first(): Promise<ListedGeneration>;
  /** 重連：先收掉上一次開的 client，再連一代。 */
  connect(): Promise<ListedGeneration>;
  /** 這份連線的遮蔽器：憑證值，加上 HTTP 網址的帳密、query、fragment（{@link withUrlScrubbing}）。連線之後送出的錯誤用它遮；重連日誌記的是 `connect()` 拋出、已遮過的錯誤文字。 */
  readonly redactor: Redactor;
  /**
   * 收掉剛失敗的那次嘗試：關掉它開的 client，再等那次開的子行程真的關掉
   * （[#1835](https://github.com/DemianLi/nexus-agent/issues/1835)）。握手就失敗的嘗試沒有東西可等，立刻落定。不拋。
   */
  abandon(): Promise<void>;
  /** 收掉最近一次開的 client，連還在握手的也算。不拋。 */
  close(): Promise<void>;
}

/**
 * 一份設定上的連線嘗試：每次都開一個新的 SDK client，記下它與那一次的 close 訊號，給 {@link Attempts.abandon} 等。CLI 與池共用。
 *
 * @param open - 開一個 client 並連上；省略就是 {@link openClient}。測試換成假的。
 */
export function attemptsOn(
  config: McpConfig,
  elicitation: boolean,
  credentials: ResolvedCredentials,
  open?: (track: (client: Client) => void) => Promise<Client>,
): Attempts {
  const redactor = withUrlScrubbing(config, redactorFor(config, credentials));
  const openOne =
    open ?? ((track: (client: Client) => void) => openClient(config, credentials, track, redactor));
  let latest: Client | undefined;
  let closed: Promise<void> = Promise.resolve();
  const close = async (): Promise<void> => {
    const client = latest;
    latest = undefined;
    await client?.close().catch(() => {});
  };
  const first = (): Promise<ListedGeneration> => {
    closed = Promise.resolve();
    return connectGeneration(
      () =>
        openOne((client) => {
          latest = client;
        }),
      config,
      elicitation,
      redactor,
      (signal) => {
        closed = signal;
      },
    );
  };
  return {
    redactor,
    first,
    async connect() {
      await close();
      return first();
    },
    async abandon() {
      // 監督者的 hook 契約是不拋；收不乾淨的由監督者的期限與 dispose 的 `release` 接手。
      await close();
      await closed;
    },
    close,
  };
}

/** `tools/list` 分頁走完，沒有名字的略過。`cacheMode: 'refresh'`：不讀新協議 client 的列表快取。 */
async function listAllTools(
  client: Client,
  serverName: string,
  redactor: Redactor,
): Promise<Tool[]> {
  const tools: Tool[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  try {
    do {
      const page = await client.listTools(cursor === undefined ? undefined : { cursor }, {
        cacheMode: 'refresh',
      });
      for (const tool of page.tools) if (tool.name !== '') tools.push(tool);
      cursor = page.nextCursor;
      if (cursor !== undefined && seen.has(cursor)) break;
      if (cursor !== undefined) seen.add(cursor);
    } while (cursor !== undefined);
  } catch (error) {
    throw new Error(
      redactor.scrubText(`Failed to load tools from server "${serverName}": ${String(error)}`),
      { cause: redactor.empty ? error : scrubbedCopy(error, redactor.scrubText) },
    );
  }
  return tools;
}

/** 這個工具的呼叫當場拋 dsh 那一句、不送請求（訊息逐字照抄 `tools.ts:280`）。 */
function rejectTaskRequired(rawName: string, redactor: Redactor): ToolCall {
  return () =>
    Promise.reject(
      new Error(
        redactor.scrubText(
          `Tool "${rawName}" requires task-based execution, which this bridge does not support`,
        ),
      ),
    );
}

/**
 * 開一個 SDK client 並連上這台 server。`track` 在連線之前就拿到 client：握手卡住時，呼叫端收得掉它。連不上就收掉 client 與 transport 再拋，
 * 拋的錯誤訊息與 `cause` 已遮掉網址的帳密、query、fragment 與這份連線的憑證值。`redactor` 省略就照 `credentials` 現建。
 */
export async function openClient(
  config: McpConfig,
  credentials: ResolvedCredentials,
  track: (client: Client) => void = () => {},
  redactor: Redactor = withUrlScrubbing(config, redactorFor(config, credentials)),
): Promise<Client> {
  const { serverName, connection } = config;
  if (connection.transport === 'stdio') {
    try {
      return await connected(
        new StdioClientTransport({
          command: connection.command,
          args: [...(connection.args ?? [])],
          // **一律傳整份**，照 dsh 的 `buildChildEnv`（`packages/mcp/mcp-client/src/transport.ts:22`，`477b4f4`）：清洗過的
          // 父環境在前、設定的在後。不傳的話底由 SDK（`getDefaultEnvironment()`，六個名字）決定，語系與代理都到不了子行程。
          env: { ...scrubbedParentEnv(), ...substituted(connection.env ?? {}, credentials) },
          ...(connection.cwd !== undefined && { cwd: connection.cwd }),
        }),
        'auto',
        track,
      );
    } catch (error) {
      throw new Error(
        redactor.scrubText(
          `Failed to connect to stdio server "${serverName}" in auto mode: ${String(error)}`,
        ),
        { cause: redactor.empty ? error : scrubbedCopy(error, redactor.scrubText) },
      );
    }
  }
  const url = connection.url;
  const shown = redactedUrl(url);
  const fail = (message: string, cause: unknown, ...urls: string[]): Error =>
    new Error(scrubbed(message, [url, ...urls], redactor), {
      cause: scrubbedCopy(cause, (text) => scrubbed(text, [url, ...urls], redactor)),
    });
  const headers =
    connection.headers === undefined ? undefined : substituted(connection.headers, credentials);
  const requestInit = headers === undefined ? {} : { requestInit: { headers } };
  try {
    return await connected(
      new StreamableHTTPClientTransport(new URL(url), {
        ...requestInit,
        reconnectionOptions: {
          maxRetries: 0,
          initialReconnectionDelay: 1_000,
          maxReconnectionDelay: 30_000,
          reconnectionDelayGrowFactor: 1.5,
        },
      }),
      'auto',
      track,
    );
  } catch (error) {
    const code = httpErrorCode(error);
    if (code !== 404 && code !== 405) {
      throw fail(
        `Failed to connect to streamable HTTP server "${serverName}, url: ${shown}" in auto mode: ${String(error)}`,
        error,
      );
    }
    const sse = (target: string): Promise<Client> =>
      connected(new SSEClientTransport(new URL(target), requestInit), 'legacy', track).catch(
        (sseError: unknown) => {
          throw fail(
            `Failed to create SSE transport for server "${serverName}, url: ${redactedUrl(target)}": ${String(sseError)}`,
            sseError,
            target,
          );
        },
      );
    try {
      return await sse(url);
    } catch (firstSseError) {
      const sseUrl = sseUrlOf(url);
      if (sseUrl === url) {
        throw fail(
          `Failed to connect to streamable HTTP server after trying to fall back to SSE: "${serverName}, url: ${shown}": ${String(error)} (SSE fallback failed with error ${String(firstSseError)})`,
          firstSseError,
        );
      }
      try {
        return await sse(sseUrl);
      } catch (secondSseError) {
        throw fail(
          `Failed to connect to streamable HTTP server "${serverName}, url: ${shown}": ${String(error)}. Additionally, tried falling back to SSE at ${shown} and ${redactedUrl(sseUrl)}, but this also failed: ${String(secondSseError)}`,
          secondSseError,
          sseUrl,
        );
      }
    }
  }
}

/**
 * 錯誤訊息與日誌裡的網址：只留 scheme、host、port、path。帳密、query、fragment 整段不印（它們常帶 token）；
 * 解析不了就印固定字串，絕不回傳原文。
 */
export function redactedUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return '<invalid url>';
  }
}

/** 單獨換掉密碼時的最短長度：更短的字串在訊息裡太容易誤傷別的字。帶 `user:password@` 的整段不受此限。 */
const MIN_STANDALONE_PASSWORD_LENGTH = 4;

/**
 * 把文字裡出現的網址換成 {@link redactedUrl}；SDK 與 fetch 的錯誤訊息會自己帶網址。
 *
 * 先換完整網址（原字串與正規化後的），再兜底：網址若以別的形式被帶出來（去掉 fragment、重新編碼、只剩 path 加 query），
 * 整段 `user:password@`、query（含 `?`）、fragment（含 `#`）、長度夠的密碼也各自換成 `[redacted]`。使用者名稱不單獨換，太短、易誤傷。
 */
function scrubbed(text: string, urls: readonly string[], redactor: Redactor): string {
  let result = text;
  const pieces: string[] = [];
  for (const url of urls) {
    const shown = redactedUrl(url);
    const forms = new Set([url]);
    try {
      const parsed = new URL(url);
      forms.add(parsed.href);
      if (parsed.password !== '') {
        pieces.push(`${parsed.username}:${parsed.password}@`);
        if (parsed.password.length >= MIN_STANDALONE_PASSWORD_LENGTH) pieces.push(parsed.password);
      }
      pieces.push(parsed.search, parsed.hash);
    } catch {
      // 解析不了的只換得了原字串。
    }
    for (const form of forms) result = result.split(form).join(shown);
  }
  // 長的先換，短的是長的的子字串時不會留下半截。
  for (const piece of pieces
    .filter((piece) => piece.length > 1)
    .sort((a, b) => b.length - a.length)) {
    result = result.split(piece).join(PLACEHOLDER);
  }
  // 憑證值最後換：先換會切斷整段網址與 query 片段的比對。
  return redactor.scrubText(result);
}

/**
 * 連線之後送出的錯誤與診斷也要遮網址：server 會把請求行（含 query 的 token）寫進錯誤回應，SDK 原樣帶出（#2669）。
 * 遮法同連線建立時那一套（{@link scrubbed}，同一個函式）；HTTP 以外的連線沒有網址，原樣回傳。
 * 只換 {@link Redactor.scrubText}；成功結果的 {@link Redactor.redactText} 不動，網址不是憑證值。
 */
export function withUrlScrubbing(config: McpConfig, base: Redactor): Redactor {
  const { connection } = config;
  if (connection.transport === 'stdio') return base;
  const { url } = connection;
  return {
    scrubText: (text) => scrubbed(text, [url], base),
    redactText: base.redactText,
    empty: false,
  };
}

type Transport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;

/** 開 client、連上 transport；失敗就兩個都收掉再拋。 */
async function connected(
  transport: Transport,
  mode: 'auto' | 'legacy',
  track: (client: Client) => void,
): Promise<Client> {
  const client = new Client(CLIENT_IDENTITY, { versionNegotiation: { mode } });
  track(client);
  try {
    await client.connect(transport);
    // 新協議的 server 宣告了 `tools.listChanged` 就開一條常駐的 `subscriptions/listen`，照 `@langchain/mcp-adapters@2.0.0`
    // （`dist/connection.js` 的 `#connect`），server 看到的連線形狀因此跟它一樣；收掉這一代時這條跟著收。工具在組裝時就定了，
    // 收到的 `tools/list_changed` 不處理（沒掛處理器，SDK 直接丟掉）。
    if (
      client.getProtocolEra() === 'modern' &&
      client.getServerCapabilities()?.tools?.listChanged === true
    ) {
      await client.listen({
        toolsListChanged: true,
        promptsListChanged: false,
        resourcesListChanged: false,
        resourceSubscriptions: [],
      });
    }
  } catch (error) {
    await Promise.allSettled([client.close(), transport.close()]);
    throw error;
  }
  return client;
}

/** 錯誤上的 HTTP 狀態碼：`status`、`code`，或訊息裡的 `(HTTP 404)`。 */
function httpErrorCode(error: unknown): number | undefined {
  const { status, code, message } = (error ?? {}) as {
    status?: unknown;
    code?: unknown;
    message?: unknown;
  };
  const valid = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
      ? value
      : undefined;
  const matched = typeof message === 'string' ? /\(HTTP (\d{3})\)/u.exec(message)?.[1] : undefined;
  return valid(status) ?? valid(code) ?? valid(Number(matched));
}

/** SSE 的退回網址：路徑結尾是 `mcp` 就換成 `sse`。 */
function sseUrlOf(url: string): string {
  const parsed = new URL(url);
  const parts = parsed.pathname.split('/');
  if (parts.at(-1) === 'mcp') parts[parts.length - 1] = 'sse';
  parsed.pathname = parts.join('/');
  return parsed.toString();
}

/**
 * 一個呼叫逾時或被停止之後，在背景探一次這一代還活不活著（[#2194](https://github.com/DemianLi/nexus-agent/issues/2194)），不擋那個呼叫回去。
 * 探的是 `tools/list`：新協議（`2026-07-28`）拿掉了 `ping`，SDK 當場拒絕、根本不送，而每台 server 都要回 `tools/list`。
 * 只有探活本身逾時才算卡死，交給 `stalled` 收掉重連；任何回應都算活著，錯誤回應也是（代表有人在讀）。連線掉了的 reject 由
 * `onclose` 那條管。同一代一次只探一個：卡死時不往讀不動的 stdin 再塞。只探 stdio：HTTP 沒有子行程可收，重連救不了對端。
 */
export function probeLiveness(generation: Generation, stalled: () => void): void {
  const { sdk, livenessTimeoutMs: timeout } = generation;
  if (sdk === undefined || timeout === undefined || generation.probing === true) return;
  generation.probing = true;
  sdk.listTools(undefined, { timeout, cacheMode: 'refresh' }).then(
    () => {
      generation.probing = false;
    },
    (error: unknown) => {
      generation.probing = false;
      if (isRequestTimeout(error)) stalled();
    },
  );
}

/** 請求是逾時或被中止放棄的：SDK 兩者都拋 `REQUEST_TIMEOUT`，經 LangChain 的訊號來的是 `TimeoutError`。沿 `cause` 往下找。 */
export function isRequestTimeout(error: unknown): boolean {
  for (let current = error, depth = 0; current !== undefined && depth < 5; depth += 1) {
    const { code, name, cause } = (current ?? {}) as {
      code?: unknown;
      name?: unknown;
      cause?: unknown;
    };
    if (code === 'REQUEST_TIMEOUT' || name === 'TimeoutError') return true;
    current = cause;
  }
  return false;
}

/** SDK client 上，探活、資源與工具呼叫會用到的那幾個方法；結構型別，測試換成假的。 */
export interface SdkClient extends Pick<Client, 'callTool'> {
  onclose?: () => void;
  close?(): Promise<void>;
  getInstructions(): string | undefined;
  /** 探活用：只要它回來，不讀內容。 */
  listTools(params?: { cursor: string }, options?: RequestOptions): Promise<unknown>;
  listResources(params?: { cursor: string }, options?: RequestOptions): Promise<unknown>;
  listResourceTemplates(params?: { cursor: string }, options?: RequestOptions): Promise<unknown>;
  readResource(params: { uri: string }, options?: RequestOptions): Promise<unknown>;
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeout?: number;
  cacheMode?: 'refresh';
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
  /** 探活等多久（毫秒）；只有 stdio 的一代有，見 {@link probeLiveness}。 */
  readonly livenessTimeoutMs?: number;
  /** 這一代有一次探活還沒落定。 */
  probing?: boolean;
  /**
   * {@link connectGeneration} 建的一代才有（[#1677](https://github.com/DemianLi/nexus-agent/issues/1677)）：這一代 `tools/list` 列出的
   * 工具描述（server 給的原樣）與帶出處標頭的指引。每份組裝照它們建自己的 `NexusTool`；plugin 自己連的重連也帶著它，但沒有人讀
   * （那條的工具與指引在載入期定了）。
   */
  readonly listed?: Listed;
}

/** {@link connectGeneration} 建的一代多帶的東西，見 {@link Generation.listed}。 */
export interface Listed {
  readonly tools: readonly Tool[];
  readonly instructions: string;
}

/** 收掉一代的 SDK client。冪等，不拋：監督者忽略它的錯誤。 */
export async function closeGeneration(generation: Generation): Promise<void> {
  await generation.sdk?.close?.().catch(() => {});
}

/**
 * 建一代，**建的當下**就掛 `onclose`：沒被採用的那一代（dispose 期間才連上的）也要等得到它關掉。先記「關掉了」，再通報斷線。
 */
export function generationOf(
  calls: ReadonlyMap<string, ToolCall>,
  sdk: SdkClient | undefined,
): Generation {
  if (sdk === undefined) return { calls, sdk, closed: Promise.resolve() };
  let markClosed!: () => void;
  const generation: Generation = {
    calls,
    sdk,
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
