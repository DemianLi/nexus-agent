/**
 * 輸出 schema 校驗：工具**成功**回來的那個值，合不合它註冊時宣告的形狀。
 *
 * ## 它為什麼住在 core 而不是某個 plugin
 *
 * dsh 那側這一步是**註冊表執行管線自己做的**：`createSuccessResult` 對
 * `tool.output.schema` 驗成功值，不合拋 `INVALID_TOOL_OUTPUT`
 * （`packages/core/tools/src/index.ts:1783-1786`、`:511`，SHA `c291e79`），`tools/post-execute`
 * 的 listener 在它**之後**才跑（`:1721-1771`）。所以它是性質不是功能——論證與圍堵搬家那次
 * 逐字相同（[#159](https://github.com/DemianLi/nexus-agent/issues/159)，見 {@link ./containment.ts}）。
 * 這一版之前它住在 `@nexus/plugin-validation`，而那個 plugin 不在任何一份正式清單裡，樹上也
 * 沒有一顆工具宣告過 schema——產品路徑上的輸出校驗是空的
 * （[#252](https://github.com/DemianLi/nexus-agent/issues/252)）。
 *
 * **宣告跟著工具走**：`registry.tools.register(tool, { outputSchema })`，同 dsh「`output` 是
 * `defineTool` 的一個欄位」。fold 打底一份實例進 root 與每個 subagent，每次呼叫從
 * `request.tool`（那一顆工具實例）查它註冊時帶的 schema，沒宣告的原樣放行。**以實例查，
 * 不以名字查**：同名的工具在不同層可以是不同的東西，fold 換上去的拒絕樁也是另一顆實例。
 *
 * **時刻：dsh 的 `createSuccessResult`，在 `tools/post-execute` 之前。** 載體是掛在
 * `tools/execute` 位置的一個 `wrapToolCall`，真正做事的是 `await handler()` **之後**那一段——
 * 兩個時刻在我們這側共用一個載體，索引見 `apps/harness/src/interception-index.test.ts`。
 * 位置由 fold 決定——每一個
 * plugin middleware 的內側，所以看到的是工具原本的輸出，不是外層改過的版本。以前那個
 * 「只有 `prepend` 一根槓桿、最內只能靠註冊在最後」的缺口因此不在了。
 *
 * ## 兩條對 dsh 的偏離
 *
 * 1. **強制不了。** LangChain 的 `StructuredTool` 沒有輸出 schema 這個欄位
 *    （`@langchain/core@1.2.9` 的 `ToolParams` 只有 `responseFormat`），`register` 收的就是
 *    `StructuredTool`。→ 註冊時選帶，**沒宣告的明文放行**。這是選加，不是全覆蓋。
 * 2. **拿不到那個 canonical value。** dsh 在渲染成 content **之前**驗值；基座的 `ToolNode`
 *    先 `JSON.stringify` 再交出來（`ToolNode.js:244-248`），值救不回來。→ 退到對 content
 *    字串 `JSON.parse` 再驗。宣告了 schema 卻不是合法 JSON，本身即失敗——這是宣告的代價，
 *    所以只有回 JSON 的工具宣告得了。
 *
 * ## 失敗長什麼樣
 *
 * 照 dsh 的 `ToolOutputError`：一則帶更正回饋的 error ToolMessage，碼 `INVALID_TOOL_OUTPUT`，
 * **原輸出不跟著送出去**。已經是錯誤的結果不再驗——它沒有值可驗，重寫只會蓋掉真正的原因。
 * 校驗器自己壞掉是 fail-closed：一則錯誤，不是放行（dsh 的渲染器／投影器失敗同樣
 * 「转为 JSON 安全的 `isError`」）。
 *
 * @module
 */

import { ToolMessage } from '@langchain/core/messages';
import { Command, isCommand } from '@langchain/langgraph';
import { createMiddleware } from 'langchain';
import type { ZodType } from 'zod';
import type { AgentMiddleware } from './base-types.js';
import { resolveToolName } from './containment.js';
import { INVALID_TOOL_OUTPUT, markToolError } from './tool-events.js';

/** 校驗 middleware 的名字。 */
export const OUTPUT_SCHEMA_MIDDLEWARE_NAME = 'nexusToolOutputSchema';

/** 一顆工具實例 → 它註冊時宣告的輸出 schema；沒宣告就是 `undefined`。 */
export type OutputSchemaLookup = (tool: unknown) => ZodType | undefined;

/**
 * 輸出不合宣告的 schema 時給模型的那句話。
 *
 * 這些字串**會送進模型的 context**：不帶堆疊、不帶原始參數，理由見 {@link ./containment.ts}
 * 的 `formatToolFailure`。
 *
 * @param toolName - 工具名。
 * @param issues - 逐條的不合之處。
 * @returns 那一句話。
 */
export function formatSchemaViolation(toolName: string, issues: readonly string[]): string {
  const body = issues.length === 0 ? '（沒有可讀的原因）' : issues.join('；');
  return `工具 ${toolName} 的輸出不合它宣告的 schema：${body}`;
}

/**
 * 校驗器自己壞掉時給模型的那句話。**它是一則錯誤，不是放行**——一個壞掉的校驗器靜默放行，
 * 等於把「驗過了」變成一句不能信的話。
 *
 * @param toolName - 工具名。
 * @param error - 校驗器拋出來的東西。
 * @returns 那一句話。
 */
export function formatValidatorFailure(toolName: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `工具 ${toolName} 的輸出校驗本身失敗了，因此這次結果不予採信：${detail}`;
}

/** 一次校驗的結果：通過，或者一句要給模型看的話。 */
type Verdict = { readonly ok: true } | { readonly ok: false; readonly feedback: string };

/** 驗一則 ToolMessage 的 content。 */
function verify(toolName: string, content: unknown, schema: ZodType): Verdict {
  if (typeof content !== 'string') {
    // 非字串 content（content blocks）救不回原值，也不該假裝驗過了。
    return {
      ok: false,
      feedback: formatSchemaViolation(toolName, ['輸出不是字串，無法對它做 schema 校驗']),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, feedback: formatSchemaViolation(toolName, ['輸出不是合法的 JSON']) };
  }
  const result = schema.safeParse(parsed);
  if (result.success) return { ok: true };
  const issues = result.error.issues.map(
    (issue) => `${issue.path.join('.') || '(根)'}: ${issue.message}`,
  );
  return { ok: false, feedback: formatSchemaViolation(toolName, issues) };
}

/** 造一則取代原輸出的 error ToolMessage。 */
function reject(feedback: string, toolCallId: string, toolName: string): ToolMessage {
  return new ToolMessage({
    content: feedback,
    tool_call_id: toolCallId,
    name: toolName,
    status: 'error',
  });
}

/**
 * 同 {@link reject}，**另外標上 `INVALID_TOOL_OUTPUT`**，給會話日誌的 `tool/result` 讀
 * （[#264](https://github.com/DemianLi/nexus-agent/issues/264)）。只有 schema 真的不合才標；
 * 校驗器自己壞掉那一格不標——那是我們的 bug，不是工具的輸出不合。
 */
function rejectOutput(feedback: string, toolCallId: string, toolName: string): ToolMessage {
  return markToolError(reject(feedback, toolCallId, toolName), {
    name: 'ToolOutputError',
    code: INVALID_TOOL_OUTPUT,
  });
}

/**
 * 造一個驗工具輸出的 middleware。fold 打底一份，root 與每個 subagent 共用——它無狀態，
 * schema 每次從那一顆工具實例現查。
 *
 * @param schemaOf - 工具實例 → 它宣告的 schema。
 * @returns 交給 fold 排位置的 middleware。
 */
export function createOutputSchemaMiddleware(schemaOf: OutputSchemaLookup): AgentMiddleware {
  return createMiddleware({
    name: OUTPUT_SCHEMA_MIDDLEWARE_NAME,
    wrapToolCall: async (request, handler) => {
      const result = await handler(request);
      const schema = schemaOf(request.tool);
      if (schema === undefined) return result;
      const toolName = resolveToolName(request);
      const toolCallId = request.toolCall.id ?? '';
      try {
        if (ToolMessage.isInstance(result)) {
          if (result.status === 'error') return result;
          const verdict = verify(toolName, result.content, schema);
          return verdict.ok ? result : rejectOutput(verdict.feedback, toolCallId, toolName);
        }
        if (isCommand(result)) {
          // **`Command` 是一行字就能造出來的靜默旁路。** 工具回 `Command` 時這裡收到的
          // 就是 `Command`，ToolMessage 埋在 `update.messages` 裡。基座自己的
          // `FilesystemMiddleware.wrapToolCall` 兩個分支都處理，照抄它。
          return validateCommand(result, toolName, toolCallId, schema);
        }
        return result;
      } catch (error) {
        return reject(formatValidatorFailure(toolName, error), toolCallId, toolName);
      }
    },
  }) as AgentMiddleware;
}

/**
 * 驗一個 `Command` 裡夾帶的 ToolMessage。**不通過就整個 Command 不採用**：Command 除了訊息
 * 還可能帶 state 更新，而那些更新正是那個不合格的輸出算出來的——只換掉訊息會留下半套。
 */
function validateCommand(
  command: Command,
  toolName: string,
  toolCallId: string,
  schema: ZodType,
): Command | ToolMessage {
  const update: unknown = command.update;
  const messages =
    typeof update === 'object' && update !== null && 'messages' in update
      ? (update as { messages: unknown }).messages
      : undefined;
  if (!Array.isArray(messages)) return command;
  for (const message of messages) {
    if (!ToolMessage.isInstance(message)) continue;
    if (message.status === 'error') continue;
    const verdict = verify(toolName, message.content, schema);
    if (!verdict.ok) return rejectOutput(verdict.feedback, toolCallId, toolName);
  }
  return command;
}
