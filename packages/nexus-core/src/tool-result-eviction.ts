/**
 * 過大的工具結果搬到 `/large_tool_results/`、模型那一格換成頭尾預覽（[#2415](https://github.com/DemianLi/nexus-agent/issues/2415) W3）。
 *
 * 規則與字串逐字照基座 `FilesystemMiddleware` 的 `wrapToolCall`（`deepagents@1.13.1`，`dist/langsmith-zm0ILQsV.js` 的 `processToolMessage`、
 * `createContentPreview`、`formatContentWithLineNumbers`、`TOO_LARGE_TOOL_MSG`、`TOOLS_EXCLUDED_FROM_EVICTION`），基座沒有匯出它們。
 * 逐字是因為已記下的日誌續接時要重算出模型當時看到的那則；`tool-result-eviction.test.ts` 對著真的基座比，基座升級改了字就紅在那裡。
 *
 * 組裝點（`agent-assembly.ts` 的 `filesystemMiddleware`）建基座那一顆時，把它的 `wrapToolCall` 換成 {@link toolResultEvictionStep}
 * 轉成的那一支，並登記這一步：native 的 root 在這一格直接呼叫它，`langgraph` 與子代理經 `wrapToolCall`，兩邊跑同一份。
 * 名字、工具、`beforeAgent` 仍是基座的（native 的 root 把 `beforeAgent` 換成空函式，見 `native-loop/native-skipped-cells.ts`），
 * `wrapModelCall` 先經過 core 的 `filesystemToolListStep` 再交給基座那一支，洋蔥裡的位置不變。
 * `toolTokenLimitBeforeEvict` 不能拿來關掉基座那一份：`read_file` 本體的截斷也讀同一個選項。
 *
 * 這一格在圍堵外層，所以日誌記的是換之前的全文；推模型歷史的一側照 {@link toolResultEvictionPath} 與
 * {@link evictedToolResultText} 重算模型看到的那則。
 *
 * @module
 */

import { ToolMessage } from '@langchain/core/messages';
import type { MessageContent } from '@langchain/core/messages';
import { Command, isCommand } from '@langchain/langgraph';
import { resolveBackend } from 'deepagents';
import { context } from 'langchain';
import { wrappedRequestOf } from './tool-call-step.js';
import type { ToolCallStep } from './tool-call-step.js';

/** 基座的 `toolTokenLimitBeforeEvict` 預設 `2e4`，乘 4 是字元數。組裝點沒改它。 */
export const TOOL_RESULT_EVICTION_THRESHOLD_CHARS = 2e4 * 4;

/** 搬去的虛擬路徑前綴，基座寫死的那一個。 */
export const TOOL_RESULT_EVICTION_PREFIX = '/large_tool_results';

/** 不搬的那幾顆：基座的 `FILESYSTEM_TOOL_NAMES` 去掉 `execute`。 */
const TOOLS_EXCLUDED_FROM_EVICTION: readonly string[] = [
  'ls',
  'read_file',
  'write_file',
  'edit_file',
  'delete',
  'glob',
  'grep',
];

/** 基座的 `MAX_LINE_LENGTH`。 */
const MAX_LINE_LENGTH = 5e3;

const TOO_LARGE_TOOL_MSG = context`
  Tool result too large, the result of this tool call {tool_call_id} was saved in the filesystem at this path: {file_path}
  You can read the result from the filesystem by using the read_file tool, but make sure to only read part of the result at a time.
  You can do this by specifying an offset and limit in the read_file tool call.
  For example, to read the first ${100} lines, you can use the read_file tool with offset=0 and limit=${100}.

  Here is a preview showing the head and tail of the result (lines of the form
  ... [N lines truncated] ...
  indicate omitted lines in the middle of the content):

  {content_sample}
`;

/**
 * 工具結果的內容攤成一段文字：文字區塊取 `text`，其他區塊 `JSON.stringify`，以換行接起來。
 *
 * @param content - `ToolMessage` 的內容。
 * @returns 量門檻、寫檔、做預覽用的那段文字。
 */
export function stringifyToolContent(content: MessageContent): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block: unknown) =>
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        block.type === 'text' &&
        'text' in block &&
        typeof block.text === 'string'
          ? block.text
          : JSON.stringify(block),
      )
      .join('\n');
  }
  return String(content);
}

function sanitizeToolCallId(toolCallId: string): string {
  return toolCallId.replace(/\./g, '_').replace(/\//g, '_').replace(/\\/g, '_');
}

function formatContentWithLineNumbers(content: readonly string[], startLine: number): string {
  const resultLines: string[] = [];
  for (const [index, line] of content.entries()) {
    const lineNum = index + startLine;
    if (line.length <= MAX_LINE_LENGTH) {
      resultLines.push(`${lineNum.toString().padStart(6)}\t${line}`);
      continue;
    }
    const numChunks = Math.ceil(line.length / MAX_LINE_LENGTH);
    for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx += 1) {
      const start = chunkIdx * MAX_LINE_LENGTH;
      const chunk = line.substring(start, Math.min(start + MAX_LINE_LENGTH, line.length));
      const marker = chunkIdx === 0 ? lineNum.toString() : `${lineNum}.${chunkIdx}`;
      resultLines.push(`${marker.padStart(6)}\t${chunk}`);
    }
  }
  return resultLines.join('\n');
}

function createContentPreview(contentStr: string, headLines = 5, tailLines = 5): string {
  const lines = contentStr.split('\n');
  // 基座兩支都傳陣列進去，所以結尾的空行照留（它的字串版才會去掉）。
  if (lines.length <= headLines + tailLines) {
    return formatContentWithLineNumbers(
      lines.map((line) => line.substring(0, 1e3)),
      1,
    );
  }
  const head = lines.slice(0, headLines).map((line) => line.substring(0, 1e3));
  const tail = lines.slice(-tailLines).map((line) => line.substring(0, 1e3));
  const truncationNotice = `\n... [${lines.length - headLines - tailLines} lines truncated] ...\n`;
  return (
    formatContentWithLineNumbers(head, 1) +
    truncationNotice +
    formatContentWithLineNumbers(tail, lines.length - tailLines + 1)
  );
}

/**
 * 這則工具結果會搬到哪個檔：沒過門檻或那顆工具不搬的回 `undefined`。
 *
 * @param message - 工具的輸出：名字、內容、呼叫編號。
 * @param fallbackToolCallId - 請求上的呼叫編號；有值時路徑用它，同基座。
 * @returns 搬去的虛擬路徑；不搬是 `undefined`。
 */
export function toolResultEvictionPath(
  message: {
    readonly name?: string;
    readonly content: MessageContent;
    readonly tool_call_id: string;
  },
  fallbackToolCallId?: string,
): string | undefined {
  if (
    message.name !== undefined &&
    message.name !== '' &&
    TOOLS_EXCLUDED_FROM_EVICTION.includes(message.name)
  ) {
    return undefined;
  }
  if (stringifyToolContent(message.content).length <= TOOL_RESULT_EVICTION_THRESHOLD_CHARS) {
    return undefined;
  }
  const id =
    fallbackToolCallId !== undefined && fallbackToolCallId !== ''
      ? fallbackToolCallId
      : message.tool_call_id;
  return `${TOOL_RESULT_EVICTION_PREFIX}/${sanitizeToolCallId(id)}.txt`;
}

/**
 * 搬走之後模型看到的那段文字。
 *
 * 三次 `.replace` 的先後與字串樣式同基座：內容裡的 `$&`、`$'` 這類樣式照 `String.prototype.replace` 的規則展開。
 *
 * @param text - {@link stringifyToolContent} 攤出來的全文。
 * @param toolCallId - 這則訊息的 `tool_call_id`。
 * @param filePath - {@link toolResultEvictionPath} 給的路徑。
 * @returns 換上的內容。
 */
export function evictedToolResultText(text: string, toolCallId: string, filePath: string): string {
  return TOO_LARGE_TOOL_MSG.replace('{tool_call_id}', toolCallId)
    .replace('{file_path}', filePath)
    .replace('{content_sample}', createContentPreview(text));
}

/** {@link toolResultEvictionWrap} 收的請求：用得到的那幾格。 */
interface EvictionRequest {
  readonly toolCall?: { readonly name?: string; readonly id?: string };
  readonly runtime?: object;
  readonly state?: unknown;
}

interface Processed {
  readonly message: ToolMessage;
  readonly filesUpdate: Record<string, unknown> | null;
}

/**
 * 基座那一格的 `wrapToolCall`：結果過大就把全文寫進 backend、換成預覽。
 *
 * - 請求上的工具名在不搬名單裡：直接往內交，不看結果。
 * - 結果是 `ToolMessage`：照規則換；寫入回了 `filesUpdate`（以 runtime 建的 `StateBackend`）就包成 `Command`。
 *   寫不進去時換成「存不進去」那句，不留全文。
 * - 結果是帶 `messages` 的 `Command`（`task`）：逐則照規則處理，只有某一則的寫入回了 `filesUpdate` 才交回新的
 *   `Command`；否則交回原來那個——backend 不回 `filesUpdate` 時檔照寫、寫不進去時不寫，兩種模型看到的都是全文。
 *
 * @param backend - 建基座那一顆時交的 backend（實例或工廠）；某一則結果過了門檻才解析，每則解析一次。
 * @returns 換上去的 `wrapToolCall`。
 */
export function toolResultEvictionWrap(
  backend: unknown,
): (
  request: EvictionRequest,
  handler: (request: EvictionRequest) => Promise<unknown>,
) => Promise<unknown> {
  async function processToolMessage(
    msg: ToolMessage,
    runtime: object | undefined,
    state: unknown,
    fallbackToolCallId: string | undefined,
  ): Promise<Processed> {
    const evictPath = toolResultEvictionPath(
      {
        ...(msg.name !== undefined && { name: msg.name }),
        content: msg.content,
        tool_call_id: msg.tool_call_id,
      },
      fallbackToolCallId,
    );
    if (evictPath === undefined) return { message: msg, filesUpdate: null };
    const textContent = stringifyToolContent(msg.content);
    const resolvedBackend = await resolveBackend(backend as never, { ...runtime, state } as never);
    const writeResult = (await resolvedBackend.write(evictPath, textContent)) as {
      readonly error?: string;
      readonly filesUpdate?: Record<string, unknown> | null;
    };
    const replacementText = writeResult.error
      ? `Tool result too large, but the result could not be saved to the filesystem: ${writeResult.error}`
      : evictedToolResultText(textContent, msg.tool_call_id, evictPath);
    return {
      message: new ToolMessage({
        content: replacementText,
        tool_call_id: msg.tool_call_id,
        name: msg.name,
        id: msg.id,
        artifact: msg.artifact,
        status: msg.status,
        metadata: msg.metadata,
        additional_kwargs: msg.additional_kwargs,
        response_metadata: msg.response_metadata,
      } as ConstructorParameters<typeof ToolMessage>[0]),
      filesUpdate: writeResult.error ? null : (writeResult.filesUpdate ?? null),
    };
  }

  return async (request, handler) => {
    const toolName = request.toolCall?.name;
    if (toolName && TOOLS_EXCLUDED_FROM_EVICTION.includes(toolName)) return handler(request);
    const result = await handler(request);
    if (ToolMessage.isInstance(result)) {
      const processed = await processToolMessage(
        result,
        request.runtime,
        request.state,
        request.toolCall?.id,
      );
      if (processed.filesUpdate) {
        return new Command({
          update: { files: processed.filesUpdate, messages: [processed.message] },
        });
      }
      return processed.message;
    }
    if (isCommand(result)) {
      const update = result.update as
        { messages?: unknown[]; files?: Record<string, unknown> } | undefined;
      if (!update?.messages) return result;
      let hasLargeResults = false;
      const accumulatedFiles: Record<string, unknown> = update.files ? { ...update.files } : {};
      const processedMessages: unknown[] = [];
      for (const msg of update.messages) {
        if (ToolMessage.isInstance(msg)) {
          const processed = await processToolMessage(
            msg,
            request.runtime,
            request.state,
            request.toolCall?.id,
          );
          processedMessages.push(processed.message);
          if (processed.filesUpdate) {
            hasLargeResults = true;
            Object.assign(accumulatedFiles, processed.filesUpdate);
          }
        } else processedMessages.push(msg);
      }
      if (hasLargeResults) {
        return new Command({
          update: { ...update, messages: processedMessages, files: accumulatedFiles },
        });
      }
    }
    return result;
  };
}

/**
 * {@link toolResultEvictionWrap} 換成工具那一步，給組裝點登記（`withToolCallStep`）。
 *
 * 往內交時不換任何格，內層拿到的是原本那個請求。解析 backend 用的 runtime 是 `wrappedRequestOf` 造的那一份，只有
 * `configurable` 與 `signal`：`resolveBackend` 只在 backend 是工廠時才讀 runtime，組裝點交的是實例。
 *
 * @param backend - 同 {@link toolResultEvictionWrap}。
 * @returns 那一步。
 */
export function toolResultEvictionStep(backend: unknown): ToolCallStep {
  const wrap = toolResultEvictionWrap(backend);
  return (call, next) => wrap(wrappedRequestOf(call), () => next());
}
