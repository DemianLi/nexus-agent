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
 * `defineTool` 的一個欄位」。fold 打底一份進 root 與每個 subagent，每次呼叫從
 * `site.tool`（那一顆工具實例）查它註冊時帶的 schema，沒宣告的原樣放行。**以實例查，
 * 不以名字查**：同名的工具在不同層可以是不同的東西，fold 換上去的拒絕樁也是另一顆實例。
 *
 * **時刻：dsh 的 `createSuccessResult`，在 `tools/post-execute` 之前。** 它是 `tools/execute` 內層的一位 core 監聽者
 * （{@link createOutputSchemaListener}），在每一位插件監聽者內側、只有 `maxTokens` 在它更內側；真正做事的是 `await next()`
 * **之後**那一段，所以每一位 `tools/execute` 插件監聽者與 `tools/post-execute` 看到的都是驗過的結果。時刻索引見
 * `apps/harness/src/interception-index.test.ts`。
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

import type { ZodType } from 'zod';
import { toolNameOfCall } from './tool-call-step.js';
import { INVALID_TOOL_OUTPUT, TOOL_ERROR_PREFIX } from './tool-events.js';
import type { CoreToolListener, PipelineExecuteResult } from './tool-pipeline.js';

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

/** 輸出不合時交回的那則：新造一則錯誤，帶 `INVALID_TOOL_OUTPUT`，給會話日誌的 `tool/result` 讀。 */
function rejectOutput(feedback: string): PipelineExecuteResult {
  return {
    kind: 'message',
    content: TOOL_ERROR_PREFIX + feedback,
    isError: true,
    error: { name: 'ToolOutputError', code: INVALID_TOOL_OUTPUT },
    fresh: true,
  };
}

/** 校驗器自己壞掉時交回的那則：新造一則錯誤，**不掛碼**——那是我們的 bug，不是工具的輸出不合。 */
function reject(feedback: string): PipelineExecuteResult {
  return { kind: 'message', content: TOOL_ERROR_PREFIX + feedback, isError: true, fresh: true };
}

/**
 * 造驗工具輸出的 `tools/execute` core 監聽者。fold 打底一份，root 與每個 subagent 共用——它無狀態，
 * schema 每次從那一顆工具實例（`site.tool`）現查。
 *
 * 往內交，工具宣告了 schema 就驗結果：
 * - 本體回 `ToolMessage`：已經是錯誤就不驗；
 * - 本體回 `Command`：驗裡面屬於這次呼叫的那則（`command` 視圖的內容），沒有那一則就放行。**不通過就整個 `Command` 不採用**：
 *   `Command` 除了訊息還可能帶狀態更新，那些更新正是那個不合格的輸出算出來的，只換掉訊息會留下半套；
 * - 驗的是 `content` 原本的字串；原本是陣列（`shape: 'blocks'`）判為不合。
 *
 * @param schemaOf - 工具實例 → 它宣告的 schema。
 * @returns 交給 fold 排進 `tools/execute` 內層的監聽者。
 */
export function createOutputSchemaListener(
  schemaOf: OutputSchemaLookup,
): CoreToolListener<'tools/execute'> {
  return async (_exec, next, site) => {
    const result = await next();
    const schema = schemaOf(site.tool);
    if (schema === undefined || result.isError || result.content === undefined) return result;
    const toolName = toolNameOfCall(site);
    try {
      const verdict = verify(toolName, result.shape === 'blocks' ? [] : result.content, schema);
      return verdict.ok ? result : rejectOutput(verdict.feedback);
    } catch (error) {
      return reject(formatValidatorFailure(toolName, error));
    }
  };
}
