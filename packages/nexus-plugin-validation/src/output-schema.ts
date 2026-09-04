/**
 * 輸出 schema 校驗：工具**成功**回來的那個值，合不合它宣告的形狀。
 *
 * 基座缺的是這一半。輸入那一半一直是好的——參數不合工具自己的 zod schema 會拋
 * `ToolInputParsingException`，被包成 `ToolInvocationError`，而 `ToolNode.#handleError`
 * 沿 `.cause` 走到根、認出它就 un-mark，於是照樣變成一則回饋（實測）。成功的回傳值
 * 則沒有任何人看：`toolRetryMiddleware` 與 `toolErrorMiddleware` 都只 `catch`，
 * 兩者都不碰 `handler()` 的回傳。
 *
 * ## 兩條對 dsh 的偏離
 *
 * dsh 的標準是 `ToolOutputDefinition.schema`——*"Raw supported JSON Schema enforced
 * against every successful canonical value"*，而且 `output` 是**強制**宣告、註冊表在
 * 註冊時就驗（`docs/subsystems/tools.zh.md`）。兩點表達不出來：
 *
 * 1. **強制不了。** LangChain 的 `StructuredTool` 沒有輸出 schema 這個欄位
 *    （`ToolParams` 只有 `responseFormat: "content" | "content_and_artifact"`），
 *    而 `registry.tools.register` 收的就是 `StructuredTool`。→ 退到這一層逐工具選加，
 *    **沒宣告的明文放行**。這是選加，不是全覆蓋，別把它當成「所有工具都驗過了」。
 * 2. **拿不到那個 canonical value。** dsh 在渲染成 content **之前**驗值；基座的
 *    `ToolNode` 先 `JSON.stringify` 再交出來（`ToolNode.js:244-248`），值救不回來。
 *    → 退到對 content 字串 `JSON.parse` 再驗。宣告了 schema 卻不是合法 JSON，
 *    本身即失敗——這是宣告的代價，不是意外。
 *
 * ## 失敗長什麼樣
 *
 * 照 dsh 的 `PostToolDecision`：`block { feedback }`——「阻止会移除值，并转为**包含
 * 纠正反馈的 `isError`**」。所以原輸出**不會**一起送出去，換掉的就是換掉了。
 */

import { ToolMessage } from '@langchain/core/messages';
import { Command, isCommand } from '@langchain/langgraph';
import { resolveToolName } from '@nexus/core';
import type { AgentMiddleware } from '@nexus/core';
import { createMiddleware } from 'langchain';
import type { ZodType } from 'zod';
import { formatSchemaViolation, formatValidatorFailure } from './feedback.js';

/** 校驗 middleware 的名字。 */
export const OUTPUT_SCHEMA_MIDDLEWARE_NAME = 'nexusToolOutputSchema';

/** 工具名 → 它的輸出 schema。沒列到的工具不驗。 */
export type ToolOutputSchemas = Readonly<Record<string, ZodType>>;

/** 一次校驗的結果：通過，或者一句要給模型看的話。 */
type Verdict = { readonly ok: true } | { readonly ok: false; readonly feedback: string };

/**
 * 驗一則 ToolMessage 的 content。
 *
 * @param toolName - 工具名，只用在訊息裡。
 * @param content - ToolMessage 的 content。
 * @param schema - 宣告的 schema。
 * @returns 通過與否；不通過時帶一句給模型的話。
 */
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
 * 造一個驗工具輸出的 middleware。
 *
 * 它**要掛在最內層**（不 `prepend`），才看得到工具原本的輸出而不是外層改過的版本。
 * 「最內」現在只是「沒 prepend 而且註冊在最後」——註冊點的順序槓桿只有 `prepend`
 * 一根，給的是最外。這個缺口是知道的，見計劃 Phase 4。
 *
 * @param schemas - 工具名 → 輸出 schema。沒列到的工具原樣放行。
 * @returns 可以交給 `registry.middleware.use()` 的 middleware。
 */
export function createOutputSchemaMiddleware(schemas: ToolOutputSchemas): AgentMiddleware {
  return createMiddleware({
    name: OUTPUT_SCHEMA_MIDDLEWARE_NAME,
    wrapToolCall: async (request, handler) => {
      const result = await handler(request);
      const toolName = resolveToolName(request);
      const toolCallId = request.toolCall.id ?? '';
      const schema = schemas[toolName];
      if (schema === undefined) return result;
      try {
        if (ToolMessage.isInstance(result)) {
          // 已經是錯誤的結果不再驗一次——它沒有值可驗，重寫只會蓋掉真正的原因。
          if (result.status === 'error') return result;
          const verdict = verify(toolName, result.content, schema);
          return verdict.ok ? result : reject(verdict.feedback, toolCallId, toolName);
        }
        if (isCommand(result)) {
          // **`Command` 是一行字就能造出來的靜默旁路。** 工具回 `Command` 時這裡收到的
          // 就是 `Command`，`ToolMessage.isInstance` 為 false，ToolMessage 埋在
          // `update.messages` 裡。基座自己的 `FilesystemMiddleware.wrapToolCall`
          // 兩個分支都處理，照抄它。
          return validateCommand(result, toolName, toolCallId, schema);
        }
        return result;
      } catch (error) {
        // 校驗器自己壞掉是 fail-closed，不是放行——理由見 `formatValidatorFailure`。
        return reject(formatValidatorFailure(toolName, error), toolCallId, toolName);
      }
    },
  }) as AgentMiddleware;
}

/**
 * 驗一個 `Command` 裡夾帶的 ToolMessage。
 *
 * @param command - 工具回傳的 Command。
 * @param toolName - 工具名。
 * @param toolCallId - 這次呼叫的 id。
 * @param schema - 宣告的 schema。
 * @returns 通過時原樣的 Command；不通過時**整個換成**一則 error ToolMessage。
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
    // **不通過就整個 Command 不採用。** Command 除了訊息還可能帶 state 更新，
    // 而那些更新正是那個不合格的輸出算出來的——只換掉訊息會留下半套。
    if (!verdict.ok) return reject(verdict.feedback, toolCallId, toolName);
  }
  return command;
}
