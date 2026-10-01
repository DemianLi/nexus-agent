/**
 * 模型吐出連 JSON 都不合格的工具參數時，照 dsh 當輪給它一則 `INVALID_ARGS`
 * （[#269](https://github.com/DemianLi/nexus-agent/issues/269) 拍板，
 * [#281](https://github.com/DemianLi/nexus-agent/issues/281) 落地）。
 *
 * ## 修之前發生什麼（#269 實測）
 *
 * 供應商轉接器解不開參數時不拋，把那一顆放進 `invalid_tool_calls`（`@langchain/openai@1.5.10`
 * `dist/converters/completions.js:155`），而 ToolNode 只派發 `tool_calls`——那一顆**從沒派發**：
 * 模型收不到回饋、日誌沒有 `tool/call`，當輪就收工。下一輪兩條產品路徑各壞一種：
 *
 * - CLI（非串流 `_generate`）：`tool_calls` 是空的，轉換器改用 `additional_kwargs.tool_calls`
 *   原樣回送（`completions.js:587-590`），供應商回 400，整條 thread 壞死；
 * - web（v3 `streamEvents`）：那一顆是一個 `invalid_tool_call` content block，送出去變成
 *   `content: []`，模型與人都看不出曾經叫過工具。
 *
 * ## dsh 怎麼做（`c291e79`）
 *
 * 解不開就不解：原字串留在 `arguments`（`packages/core/agent-loop/src/tool-calls.ts:105-111`），照常
 * 進註冊表；schema 驗證對字串回 `"arguments" must be an object`（`packages/core/tools/src/json-schema.ts:556`），
 * 渲染成 `Error: invalid arguments: …`、碼 `INVALID_ARGS`（`packages/core/tools/src/index.ts:1860-1868`、
 * `schema.ts:466`）。核准在驗參數之前（`index.ts:1453-1470` 先於 `:1539`）。
 *
 * ## 我們怎麼做：一顆 middleware、兩個鉤子
 *
 * - **`wrapModelCall`** 把那一顆改寫成正常的 `tool_calls`、參數 `{}`，清掉
 *   `additional_kwargs.tool_calls` 與 content block，原字串以 callId 為鍵記在**同一則訊息**的
 *   `additional_kwargs`（{@link INVALID_ARGUMENTS_KEY}）上。從此 ToolNode 照常派發，下一輪回送的是
 *   `{}`，後面跟著那則 tool 訊息。
 * - **`wrapToolCall`** 從 `request.state.messages` 裡找到帶這個 callId 的那則 AI 訊息
 *   （{@link rawArgumentsOf}），記號在就照常叫 `handler`，但工具換成一顆同名的樁：
 *   樁不碰工具本體，回 {@link INVALID_ARGUMENTS_REFUSAL}、碼 `INVALID_ARGS`。
 *
 * **`INVALID_ARGS` 從這裡起有兩個生產者**：這一顆（JSON 都不合格）與圍堵認出的 schema 不合
 * （`containment.ts` 的 `classifyThrownToolError`）。dsh 那側也是同一個碼，下游分不開是照抄。
 *
 * ### 為什麼叫 `handler` 而不是直接回訊息
 *
 * 當初的理由是 web 的工具卡：卡來自基座的 `tools` frame，而 `tool-started` 只在工具真的被 invoke
 * 時才發（`@langchain/langgraph@1.4.12` `dist/pregel/stream.js:108-129`），直接回訊息的話那一顆在畫面上
 * 不存在。**這個理由在 [#297](https://github.com/DemianLi/nexus-agent/issues/297) 之後不成立了**：卡改從
 * 會話日誌的 `tool/call` 開，本體沒被呼叫到的呼叫一樣有卡。樁照舊叫 `handler`，行為沒有跟著改。
 *
 * 基座那張卡的 `input` 是歷史裡的 `{}`；**換成原字串的是 pump**（`apps/harness/src/thread-pump.ts`），
 * 原字串從同一條串流上模型那一段學來。不在這裡換，理由寫在 `wrapToolCall` 那一行。從日誌開的那一顆
 * 本來就是原字串（圍堵記的就是它）。
 *
 * ### 位置：幾乎是每一層的最內側
 *
 * 排在 `turnCancelModelSignal` 之前（那一顆只有 `wrapModelCall`，而且只綁訊號）。核准閘門與 plugin
 * 的 middleware 都在它外面，對到 dsh「先 `tools/pre-execute`，執行時才驗參數」；而改寫排在其餘
 * `wrapModelCall` 的內側，外面每一顆看到的都是改寫過的那則。**比它更內側的只有 {@link ./max-tokens.ts}**
 * （[#433](https://github.com/DemianLi/nexus-agent/issues/433)）：撞到輸出上限的那則先被清掉所有呼叫，
 * 被切斷的那一顆到不了這裡，不會被當成參數不合格。外面那些看到的參數是 `{}`——
 * dsh 那側它們看到的是原字串，兩者都沒有任何欄位，觀測政策這類按路徑判斷的因此原樣放行。
 * 時刻是 `tools/execute`，佔用者的索引見 `apps/harness/src/interception-index.test.ts`。
 *
 * ## 登記的偏離
 *
 * 1. **回送用 `{}`**，照 dsh 多供應商的 pi-ai 轉接器（`packages/llm/llm-pi-ai/src/replay.ts:43-54`），
 *    不照 DeepSeek 轉接器原樣回送（`packages/llm/llm-deepseek/src/serialize.ts:214`）：我們的供應商
 *    收到原字串回 400（#269 實測）。原字串記在同一則 AI 訊息的 `additional_kwargs` 上（見下一節），
 *    日誌的 `tool/call.arguments` 也有一份。
 * 2. **核准卡的原字串放在中斷酬載的 `args` 裡**；dsh 的核准請求只帶 `callId`，連到已顯示的工具卡
 *    （`packages/interaction/user-approval/src/index.ts:101-102`）。我們的酬載照抄基座 HITL 的形狀，
 *    本來就帶 `args`，而核准卡顯示時工具卡還不存在。
 *
 * ## 原字串跟著那則訊息走，不住在行程裡
 *
 * 模型節點不會因為 resume 重跑，所以改寫只發生一次；停在核准點再續接時，拒不拒要靠上次留下的記號。
 * 記號放在**那則 AI 訊息自己身上**，所以它活得跟那則訊息一樣久：進 checkpointer、進會話日誌
 * （`assistant/message`，`fromLoggedMessage` 推回來還在），不需要另一份以 callId 為鍵、只活在
 * 行程裡的表。三個讀者（圍堵、核准閘門、這一顆）都從 `request.state.messages` 倒著找帶這個 callId
 * 的那則（{@link rawArgumentsOf}）。**落定不用刪鍵**：鍵住在那則訊息上，供應商重用 callId 時，
 * 新的呼叫在另一則訊息上，找到的就是另一個答案。
 *
 * 照 dsh 的方向（`tool-calls.ts:104-111`：解不開就把原字串留在呼叫資料本身，行程內沒有另存一份）。
 * 差只有一點：我們的 `ToolCall.args` 必須是物件（字串送出去供應商回 400，偏離 1），所以記號放在
 * 同一則訊息的 `additional_kwargs` 而不是呼叫的 `args`——這是偏離 1 的直接後果，不是另一條偏離。
 * 實測（[#701](https://github.com/DemianLi/nexus-agent/issues/701)，`langchain@1.5.10` /
 * `@langchain/openai@1.5.10`）：
 *
 * - ChatOpenAI 送回供應商時不帶這個鍵（CLI 非串流與 web v3 串流各一次；轉換器只讀 `function_call`、
 *   `tool_calls`、`audio`）；
 * - 不碰 `tool-started` 的 `input`，因為記號不在 `args` 裡；
 * - 進日誌（沒有新的事件種類），`fromLoggedMessage` 推回來還在；MemorySaver 的 serde 往返之後也在，
 *   落盤的 checkpointer 帶得過去；
 * - `request.state.messages` 在 root、子代理與核准 resume 之後都拿得到那則訊息。
 *
 * 代價：原字串在日誌裡有兩份（`tool/call.arguments` 與這則 AI 訊息）。
 */

import { AIMessage } from '@langchain/core/messages';
import type { ToolCall } from '@langchain/core/messages/tool';
import { tool as makeTool } from '@langchain/core/tools';
import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from './base-types.js';
import { INVALID_ARGS, TOOL_ERROR_PREFIX, toolCallIdOf, toolRefusal } from './tool-events.js';
import type { ToolErrorInfo } from './tool-events.js';

/** 這顆 middleware 的名字。排序斷言用得到。 */
export const INVALID_TOOL_ARGS_MIDDLEWARE_NAME = 'nexusInvalidToolArgs';

/**
 * 交給 `toolRefusal` 的那一句，**逐字照 dsh** 的 `ToolArgsError` 訊息
 * （`schema.ts:466`、`json-schema.ts:418`）。#269 的 Q2 逐字拍板。
 */
const INVALID_ARGUMENTS_REASON = 'invalid arguments: "arguments" must be an object';

/**
 * 那一顆拿到的結果，**逐字照 dsh**：`toolErrorResult` 的 `Error: ` 加上 {@link INVALID_ARGUMENTS_REASON}
 * （`packages/core/tools/src/index.ts:1860-1868`）。前綴由 `toolRefusal` 加，這裡只拼給測試與 web 比對。
 */
export const INVALID_ARGUMENTS_REFUSAL = TOOL_ERROR_PREFIX + INVALID_ARGUMENTS_REASON;

/** 碼照 dsh 的 `ToolArgsError`，同圍堵認出 schema 不合時給的那一組。 */
const INVALID_ARGS_ERROR: ToolErrorInfo = { name: 'ToolArgsError', code: INVALID_ARGS };

/**
 * 記號放在 AI 訊息 `additional_kwargs` 的哪一格：`{ [callId]: 原字串 }`。
 *
 * 名字不在 ChatOpenAI 的轉換器會讀的那幾格裡（`function_call`、`tool_calls`、`audio`），所以不會
 * 被送回供應商。
 */
export const INVALID_ARGUMENTS_KEY = 'nexusInvalidArguments';

/**
 * 這一次呼叫的原字串：解不開的那顆有，其餘（含沒有 `state`、找不到那則訊息）是 `undefined`。
 *
 * **倒著找、認 callId**：ToolNode 執行時那則訊息就在尾巴附近，供應商重用 callId 時最近的那則才是
 * 這一次。記號查不到時是 `undefined`，**不是**「合法」的證明——呼叫端（`wrapToolCall`）照常放行。
 *
 * @param request - `wrapToolCall` 收到的請求，只讀 `toolCall.id` 與 `state.messages`。
 * @returns 模型吐的原字串，或 `undefined`。
 */
export function rawArgumentsOf(request: {
  readonly toolCall: { readonly id?: string };
  readonly state?: unknown;
}): string | undefined {
  const callId = request.toolCall.id;
  if (callId === undefined || callId === '') return undefined;
  const messages = (request.state as { messages?: unknown } | undefined)?.messages;
  if (!Array.isArray(messages)) return undefined;
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at] as Partial<AIMessage> | undefined;
    if (!(message?.tool_calls ?? []).some((call) => call.id === callId)) continue;
    const marks = message?.additional_kwargs?.[INVALID_ARGUMENTS_KEY] as
      Record<string, unknown> | undefined;
    const raw = marks?.[callId];
    return typeof raw === 'string' ? raw : undefined;
  }
  return undefined;
}

/** 一顆解不開的呼叫。 */
interface InvalidCall {
  readonly id: string;
  readonly name: string;
  readonly raw: string;
}

/** v3 那條上的 `invalid_tool_call` content block。 */
function isInvalidToolCallBlock(block: unknown): boolean {
  return (
    typeof block === 'object' &&
    block !== null &&
    (block as { type?: unknown }).type === 'invalid_tool_call'
  );
}

/**
 * 一則回覆裡解不開的呼叫：CLI 那條在 `invalid_tool_calls` 欄位，v3 那條在 content block。
 *
 * **沒有 id 或名字的那顆不動**：沒有 id 就配不起那則 tool 訊息。OpenAI 相容的供應商一定給 id
 * （轉換器從 `rawToolCall.id` 取），所以這是防禦，不是一條會走到的路。
 */
function invalidCallsOf(message: AIMessage): InvalidCall[] {
  const found = new Map<string, InvalidCall>();
  const add = (entry: unknown): void => {
    const { id, name, args } = entry as { id?: unknown; name?: unknown; args?: unknown };
    if (typeof id !== 'string' || id === '' || typeof name !== 'string') return;
    if (!found.has(id)) found.set(id, { id, name, raw: typeof args === 'string' ? args : '' });
  };
  for (const call of message.invalid_tool_calls ?? []) add(call);
  if (Array.isArray(message.content)) {
    for (const block of message.content) if (isInvalidToolCallBlock(block)) add(block);
  }
  return [...found.values()];
}

/**
 * 把解不開的呼叫改寫成正常的 `tool_calls`、參數 `{}`，原字串記在同一則訊息的 `additional_kwargs` 上
 * （{@link INVALID_ARGUMENTS_KEY}）。沒有解不開的就原樣回傳。
 *
 * 清掉三樣：`invalid_tool_calls`、`additional_kwargs.tool_calls`（CLI 那條的原字串就在這裡，轉換器在
 * `tool_calls` 空的時候會拿它回送）、`invalid_tool_call` content block。v3 那條的訊息帶
 * `output_version: 'v1'`，建構子會替新的 `tool_calls` 自己補上 `tool_call` block
 * （`@langchain/core@1.2.9` `dist/messages/ai.js:64-72`）。
 *
 * @param message - 模型這一輪的回覆。
 * @returns 改寫過的那則，或原樣的同一則。
 */
export function repairInvalidToolCalls(message: AIMessage): AIMessage {
  const invalid = invalidCallsOf(message);
  if (invalid.length === 0) return message;
  const { tool_calls: _replayedVerbatim, ...kwargs } = message.additional_kwargs;
  const repaired: ToolCall[] = invalid.map((call) => ({
    id: call.id,
    name: call.name,
    args: {},
    type: 'tool_call',
  }));
  return new AIMessage({
    ...(message.id === undefined ? {} : { id: message.id }),
    ...(message.name === undefined ? {} : { name: message.name }),
    content: Array.isArray(message.content)
      ? message.content.filter((block) => !isInvalidToolCallBlock(block))
      : message.content,
    additional_kwargs: {
      ...kwargs,
      [INVALID_ARGUMENTS_KEY]: Object.fromEntries(invalid.map((call) => [call.id, call.raw])),
    },
    response_metadata: message.response_metadata,
    ...(message.usage_metadata === undefined ? {} : { usage_metadata: message.usage_metadata }),
    tool_calls: [...(message.tool_calls ?? []), ...repaired],
    invalid_tool_calls: [],
  });
}

/**
 * 頂替那顆工具的樁：同名、不碰本體，回 {@link INVALID_ARGUMENTS_REFUSAL}。
 *
 * **schema 是空的 JSON schema**：它收的是原字串。`{}` 不算「只收字串」，所以建出來的是
 * `DynamicStructuredTool`、驗證對任何值都過（`@langchain/core@1.2.9` `dist/utils/json_schema.js:62-63`）。
 */
function refusingStub(name: string): unknown {
  return makeTool(
    (_raw: unknown, config?: unknown) =>
      toolRefusal(INVALID_ARGUMENTS_REASON, {
        callId: toolCallIdOf(config) ?? '',
        name,
        error: INVALID_ARGS_ERROR,
      }),
    { name, description: `${name}（參數解不開，這次不執行）`, schema: {} },
  );
}

/**
 * 造這顆 middleware。
 *
 * @returns 要排在每一層內側（`nexusMaxTokens` 之外）的 middleware。
 */
export function createInvalidToolArgsMiddleware(): AgentMiddleware {
  return createMiddleware({
    name: INVALID_TOOL_ARGS_MIDDLEWARE_NAME,
    wrapModelCall: async (request, handler) => {
      const response = await handler(request);
      return AIMessage.isInstance(response) ? repairInvalidToolCalls(response) : response;
    },
    wrapToolCall: (request, handler) => {
      const raw = rawArgumentsOf(request);
      // **未知工具不換樁**：基座自己回「沒有這顆工具」，圍堵記成 `UNKNOWN_TOOL`——同 dsh 先認工具、
      // 再驗參數（`packages/core/tools/src/index.ts:1365`）。
      if (raw === undefined || request.tool === undefined) return handler(request);
      // **參數不換，照歷史裡的 `{}` 交下去**：換成原字串的話，langchain 的 v3 串流轉換器對
      // `tool-started` 的 `input` 做 `JSON.parse`（`langchain@1.5.10`
      // `dist/agents/transformers/tool-call.js:93`），整條串流當場拋掉（實測）。
      return handler({
        ...request,
        tool: refusingStub(request.toolCall.name) as typeof request.tool,
      });
    },
  }) as AgentMiddleware;
}
