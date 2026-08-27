/**
 * 回饋訊息的措辭，集中在這裡。
 *
 * 這些字串**會送進模型的 context**，所以有兩條規矩：不帶堆疊、不帶原始參數。
 * 基座自己那條路兩樣都帶——`ToolInvocationError` 的訊息把
 * `JSON.stringify(toolCall.args)` 與整段 `error.stack` 都塞進去（實測），那是 PR #72
 * 那個外洩形狀掉頭往內指。參數本來就在同一輪的 AI 訊息裡，模型看得到，複誦一次
 * 只是多一份、不是多一個資訊。
 */

/** 工具自己拋錯時給模型的那句話。 */
export function formatToolFailure(toolName: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `工具 ${toolName} 執行失敗：${detail}`;
}

/** 輸出不合宣告的 schema 時給模型的那句話。 */
export function formatSchemaViolation(toolName: string, issues: readonly string[]): string {
  const body = issues.length === 0 ? '（沒有可讀的原因）' : issues.join('；');
  return `工具 ${toolName} 的輸出不合它宣告的 schema：${body}`;
}

/**
 * 校驗器自己壞掉時給模型的那句話。
 *
 * **它是一則錯誤，不是放行**——dsh 的做法是渲染器／投影器自己失敗也「转为 JSON 安全的
 * `isError`」（`docs/subsystems/tools.zh.md`）。一個壞掉的校驗器靜默放行，等於把
 * 「驗過了」這件事變成一句不能信的話。
 */
export function formatValidatorFailure(toolName: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `工具 ${toolName} 的輸出校驗本身失敗了，因此這次結果不予採信：${detail}`;
}

/**
 * 這次呼叫的工具名。
 *
 * 基座寫的是 `request.tool?.name ?? request.toolCall.name`，但那個 `tool` 是
 * `ClientTool | ServerTool` 的聯集，`name` 在型別上收斂成 `{}`——JS 那邊沒事，
 * TS 這邊接不住。所以先確定它真的是字串，不是的話退回 `toolCall.name`。
 *
 * @param request - `wrapToolCall` 收到的請求。
 * @returns 工具名。
 */
export function resolveToolName(request: {
  readonly tool?: { readonly name?: unknown };
  readonly toolCall: { readonly name: string };
}): string {
  const fromTool: unknown = request.tool?.name;
  return typeof fromTool === 'string' ? fromTool : request.toolCall.name;
}
