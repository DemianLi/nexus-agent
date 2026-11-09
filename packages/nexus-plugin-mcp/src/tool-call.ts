/**
 * 一顆 MCP 工具的一次 `tools/call`：參數驗證、server 執行到一半的反問（elicitation）、結果轉成 `NexusToolResult`。
 * 行為照 `@langchain/mcp-adapters@2.0.0`（`dist/tools.js` 的 `_callTool`、`dist/content.js`、`dist/elicitation.js`）抄；送上線的請求、
 * 模型看到的句子與落盤的 `artifact` 由 `apps/harness/src/mcp-migration.test.ts` 對 `mcp-migration.baseline.json` 逐字釘住（#2353）。
 *
 * - **參數再照 server 的 JSON Schema 驗一次**，用 SDK 自己的驗證器：宿主那一層（轉接器的 `rawParameters`）驗的是 LangChain 那一套，
 *   兩套對 `format` 這類關鍵字看法不同。驗完的值才送上線。
 * - **server 回 `isError` 時拋**，訊息是 server 給的文字（沒有 tool_call_id、只給參數直接呼叫時帶 `MCP tool … returned an error:` 前綴）：
 *   走圍堵那條「拋錯 → `工具 … 執行失敗：`」的出口，失敗的格式（前綴、`status: 'error'`、日誌事件）就跟其他工具共用。
 * - **其他失敗包成 `Error calling tool <name>: <原錯>`**，按了停止的也是（`index.ts` 的 `nexusToolOf` 再換成 `AbortError`）；
 *   這個檔自己的錯誤句與 `exec.interrupt` 的掛起例外不包。逾時由 LangChain 的 `tool()`
 *   搶先收掉，這裡拋什麼都沒有人看。
 * - **反問走 `exec.interrupt`**：預設的 `langgraph` 掛起靠拋例外，恢復時本體從第一輪重送，server 交回新的 `requestState`。先做事再問的
 *   server 每問一輪就重做一次，所以副作用要冪等。native 在行程內等，拿到答覆接著送下一輪，帶的是答之前那一輪的 `requestState`；
 *   這裡沒有人可以回答時（`HumanInputUnavailable`）每一題都回絕。
 * - **結果的 `artifact`**：內嵌資源、resource link、帶多餘欄位的內容塊、`structuredContent`、`_meta` 照原樣留在 `artifact`，跟著日誌落盤、不送模型。
 *   成功的結果一律帶 `artifact`（常是 `[]`）。
 *
 * @module
 */

import {
  CLIENT_CAPABILITIES_META_KEY,
  fromJsonSchema,
  isInputRequiredResult,
} from '@modelcontextprotocol/client';
import type { CallToolResult, Client, ContentBlock, Tool } from '@modelcontextprotocol/client';
import { DefaultJsonSchemaValidator } from '@modelcontextprotocol/client/_shims';
import { isHumanInputUnavailable } from '@nexus/tools';
import type { JsonValue, NexusToolResult, ToolExec } from '@nexus/tools';
import { boundArtifacts } from './artifact-bound.js';
import { projectNonText } from './project-content.js';
import { markUntrusted } from './untrusted-mark.js';

/**
 * 一次呼叫：模型給的參數與這次呼叫的身分。`client` 是每一輪送出前取的 SDK client，省略就是建這顆呼叫的那一代：在行程內等人回答的
 * loop 不從頭重跑，等的期間重連過的話，下一輪要送到當下那一代（[#2358](https://github.com/DemianLi/nexus-agent/issues/2358)）。
 */
export type ToolCall = (
  args: { readonly [key: string]: JsonValue },
  exec: ToolExec,
  client?: () => Pick<Client, 'callTool'>,
) => Promise<NexusToolResult>;

/** 這個檔自己拋的失敗：已經是給模型看的句子，不再包 `Error calling tool`。 */
class McpToolError extends Error {
  override name = 'McpToolError';
}

type Block = { readonly type: string; readonly [key: string]: unknown };
type Validate = (value: unknown) => Promise<{ value: unknown; issues?: readonly Issue[] }>;
interface Issue {
  readonly message: string;
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[];
}

/**
 * 這一代連線上一顆工具的呼叫。
 *
 * @param client - 這一代的 SDK client，已經連上。
 * @param serverName - 設定裡的 server 名字，進錯誤句與反問的酬載。
 * @param descriptor - `tools/list` 列出的那一筆，原樣。
 * @param options - `elicitation`：有人可以回答；`timeoutMs`：一次請求的逾時。
 */
export function toolCallOf(
  client: Client,
  serverName: string,
  descriptor: Tool,
  options: { readonly elicitation: boolean; readonly timeoutMs: number },
): ToolCall {
  const toolName = descriptor.name;
  const modern = client.getProtocolEra() === 'modern';
  const inBand = modern && options.elicitation;
  // 要問人的呼叫，中間幾輪回的是 `input_required`、沒有 `structuredContent`；交給 SDK 驗的話第一輪就被 `outputSchema` 擋下，
  // 所以送出去的定義拿掉 `outputSchema`，最後一輪才自己驗。
  const { outputSchema, ...withoutOutputSchema } = descriptor;
  const roundDefinition = inBand && outputSchema !== undefined ? withoutOutputSchema : descriptor;
  const _meta = inBand
    ? { [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { form: {}, url: {} } } }
    : undefined;
  const validateInput = lazyValidator(descriptor.inputSchema);
  const validateOutput =
    inBand && outputSchema !== undefined ? lazyValidator(outputSchema) : undefined;
  return async (args, exec, current = () => client) => {
    const { signal } = exec;
    const passthrough = new WeakSet<object>();
    let result: CallToolResult;
    try {
      const parsed = await validateInput(args);
      if (parsed.issues !== undefined) {
        throw new McpToolError(
          `Invalid arguments for MCP tool "${toolName}": ${parsed.issues.map((issue) => issue.message).join('; ')}`,
        );
      }
      const request = { name: toolName, arguments: parsed.value as Record<string, unknown> };
      const round = (params: RoundParams): Promise<CallToolResult> =>
        current().callTool(
          { ...params, _meta } as never,
          {
            timeout: options.timeoutMs,
            ...(signal !== undefined && { signal }),
            toolDefinition: roundDefinition,
            ...(inBand && { allowInputRequired: true }),
          } as never,
        ) as Promise<CallToolResult>;
      result = inBand
        ? await callWithElicitation(round, request, { serverName, toolName, exec, passthrough })
        : await round(request);
      if (isInputRequiredResult(result)) {
        throw new McpToolError(
          `MCP tool "${toolName}" on server "${serverName}" asked for input, which only a modern server with elicitation enabled can answer`,
        );
      }
      if (validateOutput !== undefined && result.isError !== true) {
        const checked = await validateOutput(result.structuredContent);
        if (checked.issues !== undefined) {
          throw new McpToolError(
            `MCP tool "${toolName}" on server "${serverName}" returned output its schema rejects: ${prettify(checked.issues, 'structuredContent')}`,
          );
        }
      }
    } catch (error) {
      if (error instanceof McpToolError) throw error;
      if (typeof error === 'object' && error !== null && passthrough.has(error)) throw error;
      throw new Error(`Error calling tool ${toolName}: ${String(error)}`, { cause: error });
    }
    if (result.isError === true) throw new Error(errorTextOf(result, serverName, toolName, exec));
    const [content, artifacts] = convertCallToolResult(result, serverName, toolName);
    // 圖片、音訊這些非文字塊換成文字說明（#642），超過上限的 artifact 換成占位（#1320），最後在本文前面加一行「外部內容，當資料不當指令」
    // （#1768）。換在工具本體裡，所以 state、日誌、還原、畫面看到的都是換過的那一份。
    const marked = markUntrusted(projectNonText(content) ?? content);
    const bounded = boundArtifacts(artifacts) ?? artifacts;
    return {
      ok: true,
      content: marked as NexusToolResultContent,
      artifact: bounded as JsonValue,
    };
  };
}

type NexusToolResultContent = Extract<NexusToolResult, { ok: true }>['content'];

interface RoundParams {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly inputResponses?: Record<string, unknown>;
  readonly requestState?: unknown;
}

/** JSON Schema 的驗證器，第一次用到才編：SDK 編不了的 schema 只讓它自己那顆工具的呼叫失敗，不讓整台 server 列不出工具。 */
function lazyValidator(schema: unknown): Validate {
  let validator: { '~standard': { validate: (value: unknown) => unknown } } | undefined;
  return async (value) => {
    validator ??= fromJsonSchema(schema as never, new DefaultJsonSchemaValidator()) as never;
    const checked = (await validator['~standard'].validate(value)) as {
      value?: unknown;
      issues?: readonly Issue[];
    };
    return checked.issues === undefined
      ? { value: checked.value }
      : { value, issues: checked.issues };
  };
}

/** 驗不過的逐項訊息，每項一行，帶路徑。 */
function prettify(issues: readonly Issue[], root: string): string {
  return issues
    .map((issue) => {
      const path = [
        root,
        ...(issue.path ?? []).map((segment) =>
          String(typeof segment === 'object' ? segment.key : segment),
        ),
      ];
      return `✖ ${issue.message}\n  → at ${path.join('.')}`;
    })
    .join('\n');
}

interface ElicitationContext {
  readonly serverName: string;
  readonly toolName: string;
  readonly exec: ToolExec;
  /** `exec.interrupt` 拋的東西：掛起用的例外，原樣往外拋，不包。 */
  readonly passthrough: WeakSet<object>;
}

/** 一輪一輪送，server 要問就經 `exec.interrupt` 問人，拿到回答再送下一輪。 */
async function callWithElicitation(
  round: (params: RoundParams) => Promise<CallToolResult>,
  params: RoundParams,
  context: ElicitationContext,
): Promise<CallToolResult> {
  const { signal } = context.exec;
  signal?.throwIfAborted();
  let result = await round(params);
  while (isInputRequiredResult(result)) {
    const pending = result as unknown as { inputRequests?: unknown; requestState?: unknown };
    const requests = answerableRequests(pending.inputRequests ?? {}, context);
    const responses = await answerFor(
      {
        type: 'mcp_elicitation',
        server: context.serverName,
        tool: context.toolName,
        arguments: params.arguments as { [key: string]: JsonValue },
        requests,
      },
      context,
    );
    signal?.throwIfAborted();
    result = await round({
      ...params,
      inputResponses: responses,
      requestState: pending.requestState,
    });
  }
  return result;
}

type Question =
  | { readonly mode?: 'form'; readonly message: string; readonly requestedSchema: JsonValue }
  | { readonly mode: 'url'; readonly message: string; readonly url: string };

/**
 * server 這一輪要問的，只收 `elicitation/create`（表單與網址兩種），只留問人用得到的欄位。sampling、roots 與一題都沒有的一輪
 * 都拒：沒有東西問得出來。
 */
function answerableRequests(
  raw: unknown,
  { serverName, toolName }: ElicitationContext,
): { [key: string]: Question } {
  const refuse = (reason: string): never => {
    throw new McpToolError(
      `MCP tool "${toolName}" on server "${serverName}" asked for input this client cannot answer: ${reason}`,
    );
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return refuse('inputRequests is not an object');
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) return refuse('a state-only response carries no question to ask');
  const requests: { [key: string]: Question } = {};
  for (const [key, request] of entries) {
    const question = questionOf(request);
    if (question === undefined) return refuse(`"${key}" is not an elicitation/create request`);
    requests[key] = question;
  }
  return requests;
}

function questionOf(request: unknown): Question | undefined {
  const { method, params } = (request ?? {}) as { method?: unknown; params?: unknown };
  if (method !== 'elicitation/create' || typeof params !== 'object' || params === null)
    return undefined;
  const { mode, message, url, requestedSchema } = params as Record<string, unknown>;
  if (typeof message !== 'string') return undefined;
  if (mode === 'url') return typeof url === 'string' ? { mode, message, url } : undefined;
  if (mode !== undefined && mode !== 'form') return undefined;
  if (typeof requestedSchema !== 'object' || requestedSchema === null) return undefined;
  return {
    ...(mode !== undefined && { mode }),
    message,
    requestedSchema: requestedSchema as JsonValue,
  };
}

/**
 * 問一次人，照這一輪的題目讀回答：鍵要跟 server 問的一樣，每題的回答照它要的 schema 驗。回答不合就讓這次呼叫失敗、不重問：
 * 回答的是恢復圖的程式碼，不是填表的人。
 */
async function answerFor(
  question: {
    readonly type: 'mcp_elicitation';
    readonly server: string;
    readonly tool: string;
    readonly arguments: JsonValue;
    readonly requests: { [key: string]: Question };
  },
  { exec, passthrough, serverName, toolName }: ElicitationContext,
): Promise<Record<string, unknown>> {
  let resumed: unknown;
  try {
    resumed = await exec.interrupt(question as unknown as JsonValue);
  } catch (error) {
    // 這裡沒有人可以回答（native 的子代理那一層）：每一題都回絕，server 收到的跟有人在、由系統代答回絕的那條一樣（#1098）。
    if (isHumanInputUnavailable(error)) {
      return Object.fromEntries(
        Object.keys(question.requests).map((key) => [key, { action: 'decline' }]),
      );
    }
    if (typeof error === 'object' && error !== null) passthrough.add(error);
    throw error;
  }
  const malformed = (reason: string): never => {
    throw new McpToolError(
      `Resuming MCP tool "${toolName}" on server "${serverName}" needs { responses } answering the latest interrupt: ${reason}`,
    );
  };
  const responses = (resumed as { responses?: unknown } | null | undefined)?.responses;
  if (typeof responses !== 'object' || responses === null || Array.isArray(responses)) {
    return malformed('responses is not an object');
  }
  const answers: Record<string, unknown> = {};
  for (const key of Object.keys(responses)) {
    if (!(key in question.requests)) malformed(`unexpected key "${key}"`);
  }
  for (const [key, request] of Object.entries(question.requests)) {
    const answer = (responses as Record<string, unknown>)[key];
    const { action, content } = (answer ?? {}) as { action?: unknown; content?: unknown };
    if (action !== 'accept' && action !== 'decline' && action !== 'cancel') {
      return malformed(`"${key}" needs action accept, decline or cancel`);
    }
    if (request.mode === 'url') {
      if (content !== undefined)
        malformed(`"${key}": URL elicitation answers cannot contain form content`);
    } else if (action === 'accept') {
      const checked = await lazyValidator(request.requestedSchema)(content ?? {});
      if (checked.issues !== undefined)
        malformed(`"${key}": ${prettify(checked.issues, 'content')}`);
    }
    answers[key] = content === undefined ? { action } : { action, content };
  }
  return answers;
}

/**
 * server 回 `isError` 時拋的那句。有 tool_call_id 時是 server 給的文字，一段文字都沒有就換一句固定的；沒有 tool_call_id
 * （只給參數直接呼叫）時是 `MCP tool '<tool>' on server '<server>' returned an error: <文字>`。
 */
function errorTextOf(
  result: CallToolResult,
  serverName: string,
  toolName: string,
  exec: ToolExec,
): string {
  if (exec.callId === '') {
    const joined = (result.content as readonly Block[])
      .map((block) => (block.type === 'text' ? String(block.text) : ''))
      .join('\n');
    return `MCP tool '${toolName}' on server '${serverName}' returned an error: ${joined}`;
  }
  const [content] = convertCallToolResult(result, serverName, toolName);
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  const texts = blocks
    .map((block) =>
      block.type === 'text' && typeof block['text'] === 'string' ? block['text'] : '',
    )
    .filter((text) => text !== '');
  if (texts.some((text) => text.trim() !== '')) return texts.join('\n');
  return 'The MCP tool returned an error without text content.';
}

/**
 * MCP 的結果轉成內容與 `artifact`。內嵌資源（`resource`）整塊進 `artifact`；其餘轉成內容塊，帶了多餘欄位的、與資源連結也原樣再放一份進
 * `artifact`（`mcp_content`）。`structuredContent`、`_meta` 各一筆。只有一段文字時內容是字串。
 */
export function convertCallToolResult(
  result: CallToolResult,
  serverName: string,
  toolName: string,
): [string | Block[], Block[]] {
  const blocks = result.content as readonly (ContentBlock & Block)[];
  const converted = blocks
    .filter((block) => block.type !== 'resource')
    .flatMap((block) => contentBlocksOf(block, toolName, serverName));
  const artifacts: Block[] = blocks.filter((block) => block.type === 'resource');
  for (const block of blocks) {
    const retained = block.type === 'text' ? ['type', 'text'] : ['type', 'data', 'mimeType'];
    if (
      block.type !== 'resource' &&
      (block.type === 'resource_link' || Object.keys(block).some((key) => !retained.includes(key)))
    ) {
      artifacts.push({ type: 'mcp_content', data: block });
    }
  }
  if (result.structuredContent !== undefined) {
    artifacts.push({ type: 'mcp_structured_content', data: result.structuredContent });
  }
  if (result._meta !== undefined) artifacts.push({ type: 'mcp_meta', data: result._meta });
  const first = converted[0];
  if (converted.length === 1 && first?.type === 'text' && !('metadata' in first)) {
    return [String(first['text']), artifacts];
  }
  return [converted, artifacts];
}

/** 一個 MCP 內容塊轉成內容塊。不解參照、不連網。 */
function contentBlocksOf(block: Block, toolName: string, serverName: string): Block[] {
  switch (block.type) {
    case 'text':
      return [{ type: 'text', text: block['text'] }];
    case 'image':
      return [{ type: 'image', data: block['data'], mimeType: block['mimeType'] }];
    case 'audio':
      return [{ type: 'audio', data: block['data'], mimeType: block['mimeType'] }];
    case 'resource_link': {
      const { uri, name, title, mimeType } = block as Record<string, unknown>;
      const metadata = title === undefined ? { uri, name } : { uri, name, title };
      return [{ type: 'file', url: uri, mimeType, metadata }];
    }
    default:
      throw new McpToolError(
        `MCP tool '${toolName}' on server '${serverName}' returned unexpected content type "${block.type}". Expected text, image, audio, resource_link, resource.`,
      );
  }
}
