/**
 * 工具事件的詞彙：錯誤碼、把碼從內層帶到圍堵那一層的載體，以及讀一次呼叫落定成什麼。
 *
 * 事件本身（`tool/call`／`tool/result`）宣告在 {@link ./session-log.ts | SessionEventMap}，
 * 寫它們的是{@link ./containment.ts | 圍堵}——只有第 0 格同時看得到內層拋出來的錯與內層
 * 回的錯誤訊息。見 [#264](https://github.com/DemianLi/nexus-agent/issues/264)。
 *
 * ## 碼照 dsh，而且只有這幾個
 *
 * 字串逐字對過 `references/deepseek-harness`（SHA `c291e7961a515f6d7af9304e7fd1d257929aef26`）。
 * **一般拋錯與核准被拒沒有碼**：dsh 的 `errorInfo` 只替帶碼的 `HarnessError` 填這一格
 * （`packages/core/tools/src/index.ts:635-641`），其餘的錯誤結果不帶 `error`。所以「沒碼」是
 * 照抄，不是漏分類。
 *
 * ## 碼怎麼從內層走到外層
 *
 * 內層（輸出 schema 校驗、觀測政策的 `FS_*` 拒絕、`ask_user_question` 的放棄，以及 goal、
 * todo、計劃模式、root-only 樁那些「這次呼叫沒有生效」的拒絕，見 {@link toolRefusal}）自己產一則
 * `status: 'error'` 的 ToolMessage，
 * 那則訊息原樣一路回到圍堵。碼**不能寫進訊息本身**：`additional_kwargs` 在轉成供應商格式時
 * 會被讀回去（`@langchain/openai` 的 `converters/completions.js:472`），寫進去就是改了模型的
 * 輸入。所以碼掛在一張以訊息為鍵的 `WeakMap` 上，對應 dsh `ToolExecutionResult.error.info`
 * 那種與模型可見內容分開走的欄位。**載體只在同一個行程、同一個物件上成立**——實測內層換出來
 * 的新訊息，外層拿到的是同一個物件；哪天有一層在中途複製訊息，碼就在那裡斷掉，而結果退成
 * 「沒碼的錯誤」，不會變成錯的碼。
 */

import { ToolMessage } from '@langchain/core/messages';
import { isCommand } from '@langchain/langgraph';

/** 一次失敗的結果是哪一種。照 dsh 的 `ToolErrorInfo`：`name` 是錯誤類別名，`code` 是分類碼。 */
export interface ToolErrorInfo {
  readonly name: string;
  readonly code: string;
}

/** 工具等太久。dsh `guard/timeout-policy` 的 `TOOL_TIMEOUT`。 */
export const TOOL_TIMEOUT = 'TOOL_TIMEOUT';
/**
 * 使用者取消了這次呼叫：**本體已經開始**，落定之後結果被換掉。dsh `packages/core/tools` 的
 * `TOOL_ABORTED`，字串是 `ABORTED`（`packages/core/tools/src/index.ts:462`）。
 */
export const TOOL_ABORTED = 'ABORTED';
/**
 * 使用者取消了這次呼叫：**本體從沒開始**。dsh 同檔 `:465` 的 `TOOL_ABORTED_BEFORE_DISPATCH`。
 * 生產者見 `turn-cancel.ts`，與停在核准點被收回的那幾顆（`apps/harness` 的 pump）。
 */
export const TOOL_ABORTED_BEFORE_DISPATCH = 'ABORTED_BEFORE_DISPATCH';
/** 參數不合工具宣告的 schema。dsh `ToolArgsError` 的碼。 */
export const INVALID_ARGS = 'INVALID_ARGS';
/** 模型叫了一個不存在的工具。dsh `ToolNotFoundError` 的碼。 */
export const UNKNOWN_TOOL = 'UNKNOWN_TOOL';
/** 成功的輸出不合它宣告的 schema。dsh `ToolOutputError` 的碼。 */
export const INVALID_TOOL_OUTPUT = 'INVALID_TOOL_OUTPUT';

/** 內層替自己產的錯誤訊息標上的碼。見檔頭「碼怎麼從內層走到外層」。 */
const marked = new WeakMap<object, ToolErrorInfo>();

/**
 * 替一則錯誤結果標上碼。**只標自己產的那則**——原樣轉交別人的訊息不要標。
 *
 * @param message - 要回給上一層的那則 ToolMessage。
 * @param info - 它是哪一種失敗。
 * @returns 同一則訊息，方便直接 `return`。
 */
export function markToolError<T extends object>(message: T, info: ToolErrorInfo): T {
  marked.set(message, info);
  return message;
}

/**
 * 讀一則訊息被標上的碼。
 *
 * @param message - 任何東西；不是被標過的物件就回 `undefined`。
 * @returns 標上的碼，或 `undefined`。
 */
export function toolErrorOf(message: unknown): ToolErrorInfo | undefined {
  return typeof message === 'object' && message !== null ? marked.get(message) : undefined;
}

/**
 * 一次工具呼叫的 `tool_call_id`，取不到時是 `undefined`。
 *
 * 基座把它放在工具第二個參數的 config 上（`@langchain/core` 的 `tools/index.js:128`），**只有
 * 以 `ToolCall` 形式呼叫時才有**——產品路徑上的 tool node 一律走那一條。
 *
 * @param config - 工具收到的第二個參數，形狀不保證。
 * @returns 那個 id。
 */
export function toolCallIdOf(config: unknown): string | undefined {
  if (typeof config !== 'object' || config === null) return undefined;
  const call = (config as { toolCall?: unknown }).toolCall;
  if (typeof call !== 'object' || call === null) return undefined;
  const id = (call as { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

/**
 * 一則「這次呼叫沒有生效」的工具結果：`status: 'error'`，內容逐字是給模型的那一句。
 *
 * 照 dsh：拒絕在那側一律是拋，註冊表接住渲染成 `isError` 的結果
 * （`packages/core/tools/src/index.ts:1860-1868`），沒有一處是狀態成功的拒絕。我們回訊息而不
 * 拋，是因為拋給圍堵的話模型看到的字會變成「工具 X 執行失敗：…」。決議見
 * [#271](https://github.com/DemianLi/nexus-agent/issues/271)。
 *
 * **`callId` 取不到時給 `''`**，同 `ask_user_question`、`submit_record` 的先例：直接回來的
 * ToolMessage，{@link readToolOutcome} 不比對 id。**包在 `Command` 裡回的不行**——那條路靠 id
 * 認出屬於這次呼叫的那則，給錯就讀成成功。
 *
 * @param content - 模型看到的那一句，逐字。
 * @param options - `callId` 與 `name` 照這次呼叫；`error` 只在 dsh 那側帶碼時給。
 * @returns 標好碼（如果有）的那則訊息。
 */
export function toolRefusal(
  content: string,
  options: { readonly callId: string; readonly name: string; readonly error?: ToolErrorInfo },
): ToolMessage {
  const message = new ToolMessage({
    content,
    tool_call_id: options.callId,
    name: options.name,
    status: 'error',
  });
  return options.error === undefined ? message : markToolError(message, options.error);
}

/** 一次呼叫落定成什麼。`error` 只在 `isError` 而且認得出種類時有。 */
export type ToolOutcome =
  { readonly isError: false } | { readonly isError: true; readonly error?: ToolErrorInfo };

/**
 * 從 handler 回來的東西讀出這次呼叫的結果。
 *
 * 工具可以回 ToolMessage，也可以回一個 `Command`，後者的 ToolMessage 埋在
 * `update.messages` 裡——同 `@nexus/plugin-validation` 的 `output-schema.ts` 處理的兩個分支。
 * 找不到 ToolMessage 的就當成功：沒有東西說它失敗了。
 *
 * @param result - `handler(request)` 回來的值。
 * @param callId - 這次呼叫的 id，用來在 `Command` 裡認出屬於它的那則。
 * @returns 這次呼叫的結果。
 */
export function readToolOutcome(result: unknown, callId: string): ToolOutcome {
  const message = ToolMessage.isInstance(result) ? result : commandToolMessage(result, callId);
  if (message?.status !== 'error') return { isError: false };
  const error = toolErrorOf(message);
  return error === undefined ? { isError: true } : { isError: true, error };
}

/** `Command` 裡屬於這次呼叫的那則 ToolMessage。 */
function commandToolMessage(result: unknown, callId: string): ToolMessage | undefined {
  if (!isCommand(result)) return undefined;
  const update: unknown = result.update;
  const messages =
    typeof update === 'object' && update !== null && 'messages' in update
      ? (update as { messages: unknown }).messages
      : undefined;
  if (!Array.isArray(messages)) return undefined;
  return messages.find(
    (message): message is ToolMessage =>
      ToolMessage.isInstance(message) && message.tool_call_id === callId,
  );
}
