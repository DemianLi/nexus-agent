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
 *   `additional_kwargs.tool_calls` 與 content block，原字串交給{@link InvalidArgumentsCarrier | 載體}。
 *   從此 ToolNode 照常派發，下一輪回送的是 `{}`，後面跟著那則 tool 訊息。
 * - **`wrapToolCall`** 認出載體裡有這個 callId 的那次，照常叫 `handler`，但工具換成一顆同名的樁：
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
 * ### 位置：每一層的最內側
 *
 * 排在 `turnCancelModelSignal` 之前（那一顆只有 `wrapModelCall`，而且只綁訊號）。核准閘門與 plugin
 * 的 middleware 都在它外面，對到 dsh「先 `tools/pre-execute`，執行時才驗參數」；而改寫排在所有
 * `wrapModelCall` 的最內側，外面每一顆看到的都是改寫過的那則。外面那些看到的參數是 `{}`——
 * dsh 那側它們看到的是原字串，兩者都沒有任何欄位，觀測政策這類按路徑判斷的因此原樣放行。
 * 時刻是 `tools/execute`，佔用者的索引見 `apps/harness/src/interception-index.test.ts`。
 *
 * ## 登記的偏離
 *
 * 1. **回送用 `{}`**，照 dsh 多供應商的 pi-ai 轉接器（`packages/llm/llm-pi-ai/src/replay.ts:43-54`），
 *    不照 DeepSeek 轉接器原樣回送（`packages/llm/llm-deepseek/src/serialize.ts:214`）：我們的供應商
 *    收到原字串回 400（#269 實測）。原字串只留在日誌的 `tool/call.arguments`。
 * 2. **核准卡的原字串放在中斷酬載的 `args` 裡**；dsh 的核准請求只帶 `callId`，連到已顯示的工具卡
 *    （`packages/interaction/user-approval/src/index.ts:101-102`）。我們的酬載照抄基座 HITL 的形狀，
 *    本來就帶 `args`，而核准卡顯示時工具卡還不存在。
 *
 * ## 載體只活在這個行程
 *
 * 模型節點不會因為 resume 重跑，所以改寫只發生一次；停在核准點再續接時，拒不拒只能靠載體裡上次
 * 留下的那一筆。行程重啟就沒了，而那時歷史裡的參數已經是 `{}`，跟一個合法的空參數呼叫分不出來，
 * 工具會真的被執行。**今天走不到**：兩條產品路徑的 checkpointer 都是 `MemorySaver`
 * （`apps/harness/src/cli.ts` 的 `createCliAgent`，serve 每條 thread 也走它），行程一死 thread 跟著死。
 * 哪天有會落盤的 checkpointer，這一格要換成活得過 checkpoint 的記號。
 */

import { AIMessage } from '@langchain/core/messages';
import type { ToolCall } from '@langchain/core/messages/tool';
import { tool as makeTool } from '@langchain/core/tools';
import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from './base-types.js';
import { INVALID_ARGS, toolCallIdOf, toolRefusal } from './tool-events.js';
import type { ToolErrorInfo } from './tool-events.js';

/** 這顆 middleware 的名字。排序斷言用得到。 */
export const INVALID_TOOL_ARGS_MIDDLEWARE_NAME = 'nexusInvalidToolArgs';

/**
 * 那一顆拿到的結果，**逐字照 dsh**：`toolErrorResult` 的 `Error: ` 加上 `ToolArgsError` 的訊息
 * （`packages/core/tools/src/index.ts:1860-1868`、`schema.ts:466`、`json-schema.ts:418`）。
 *
 * 樹上其他「這次呼叫沒有生效」的拒絕不帶 `Error: ` 前綴（前綴統一進了地圖的 Not yet specified）；
 * 這一句帶，是 #269 的 Q2 逐字拍板的。
 */
export const INVALID_ARGUMENTS_REFUSAL = 'Error: invalid arguments: "arguments" must be an object';

/** 碼照 dsh 的 `ToolArgsError`，同圍堵認出 schema 不合時給的那一組。 */
const INVALID_ARGS_ERROR: ToolErrorInfo = { name: 'ToolArgsError', code: INVALID_ARGS };

/**
 * 原字串從改寫那一刻帶到下游的載體：以 callId 為鍵。
 *
 * 讀它的有三處——圍堵（`tool/call.arguments` 記原字串）、核准閘門（中斷酬載的 `args`）、
 * 這一顆的 `wrapToolCall`（拒不拒）。**落定時由圍堵刪鍵**：它是最外層，看得到每一條出口，
 * 而中斷不是落定（續接時同一個 callId 會再進來一次，那時還要讀得到）。
 *
 * **一份組裝一份，root 與每個子代理共用**——跟 `factory-products-carry-closure-state` 那條慣例相反，
 * 而那是對的：三個讀者分在不同層，得看到同一份；鍵是供應商發的 callId，同一條 thread 上一顆還沒
 * 落定之前不會再發同一個。**不做成模組層級**：假模型的 callId 是 `call_1_0` 這種固定值，同一個
 * 行程裡兩場組裝共用的話，前一場的壞呼叫會讓後一場的好呼叫被拒。
 */
export interface InvalidArgumentsCarrier {
  remember(callId: string, raw: string): void;
  rawOf(callId: string): string | undefined;
  forget(callId: string): void;
}

/**
 * 建一份載體。
 *
 * @returns 空的載體。
 */
export function createInvalidArgumentsCarrier(): InvalidArgumentsCarrier {
  const raws = new Map<string, string>();
  return {
    remember: (callId, raw) => {
      raws.set(callId, raw);
    },
    rawOf: (callId) => raws.get(callId),
    forget: (callId) => {
      raws.delete(callId);
    },
  };
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
 * 把解不開的呼叫改寫成正常的 `tool_calls`、參數 `{}`，原字串交給載體。沒有解不開的就原樣回傳。
 *
 * 清掉三樣：`invalid_tool_calls`、`additional_kwargs.tool_calls`（CLI 那條的原字串就在這裡，轉換器在
 * `tool_calls` 空的時候會拿它回送）、`invalid_tool_call` content block。v3 那條的訊息帶
 * `output_version: 'v1'`，建構子會替新的 `tool_calls` 自己補上 `tool_call` block
 * （`@langchain/core@1.2.9` `dist/messages/ai.js:64-72`）。
 *
 * @param message - 模型這一輪的回覆。
 * @param carrier - 原字串要交給的載體。
 * @returns 改寫過的那則，或原樣的同一則。
 */
export function repairInvalidToolCalls(
  message: AIMessage,
  carrier: InvalidArgumentsCarrier,
): AIMessage {
  const invalid = invalidCallsOf(message);
  if (invalid.length === 0) return message;
  for (const call of invalid) carrier.remember(call.id, call.raw);
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
    additional_kwargs: kwargs,
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
      toolRefusal(INVALID_ARGUMENTS_REFUSAL, {
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
 * @param carrier - 這份組裝的載體，同一份也交給圍堵與核准閘門。
 * @returns 要排在每一層最內側的 middleware。
 */
export function createInvalidToolArgsMiddleware(carrier: InvalidArgumentsCarrier): AgentMiddleware {
  return createMiddleware({
    name: INVALID_TOOL_ARGS_MIDDLEWARE_NAME,
    wrapModelCall: async (request, handler) => {
      const response = await handler(request);
      return AIMessage.isInstance(response) ? repairInvalidToolCalls(response, carrier) : response;
    },
    wrapToolCall: (request, handler) => {
      const callId = request.toolCall.id;
      const raw = callId === undefined ? undefined : carrier.rawOf(callId);
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
