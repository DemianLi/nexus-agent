/**
 * 模型回覆撞到輸出上限（`finish_reason` 是 `length`）時，照 dsh 收掉這一步、記成截斷
 * （[#433](https://github.com/DemianLi/nexus-agent/issues/433)）。
 *
 * ## 修之前發生什麼
 *
 * 沒有人讀 `finish_reason`。被切斷的那一顆工具呼叫參數不完整，轉接器解不開、放進
 * `invalid_tool_calls`，{@link ./invalid-tool-args.ts} 把它當成「參數不合格」回一則 `INVALID_ARGS`：
 * 模型被告知格式錯了（其實是被切掉），這一輪不停，下一次呼叫可能再燒一次到上限。一輪收尾的
 * `turn/end` 不帶原因，日誌與畫面都當它正常結束，goal 續行照樣排下一輪。子代理被截斷時，基座的
 * `task` 往回找最後一則有字的回覆交給父代理，都沒有就交一句 `Task completed`。
 *
 * ## 我們怎麼做：模型與工具各一半，共用一份載體，加一個讀日誌的判準
 *
 * - **模型那一半**（{@link createMaxTokensMiddleware}，`wrapModelCall`）認出截斷就清掉這一則的工具呼叫（{@link dropToolCalls}），`response_metadata`
 *   原樣留著——日誌 `assistant/message` 記的就是這一則，判準讀的就是那一格。在 LangChain 的 agent
 *   迴圈裡，**沒有工具呼叫就是這一輪收尾**，所以「丟掉」與「結束這一步」是同一件事，不用另外中斷。
 *   這次呼叫來自子代理的話，順手在{@link MaxTokensCarrier | 載體}記一筆。
 * - **工具那一半**（{@link createMaxTokensListener}，`tools/execute` 的 core 監聽者）只看 `task`：載體裡有這次呼叫派出去的
 *   那個子代理，就把結果換成撞限的錯誤，後面接已經寫出的那段（{@link subagentMaxTokensResult}）；子代理的結果記成截斷，不是正常收。
 * - **這一輪的原因**由收尾的人從 root 日誌讀（{@link turnReachedMaxTokens}）：CLI 與 web 的 pump
 *   各自寫 `turn/end`，兩條共用這一個判準。子代理的截斷不算 root 這一輪的，同 dsh 每個 agent 各記
 *   各的；它對父代理的效果是那一則錯誤。
 * - 沒有內容的助手訊息不送，補在 `apps/harness/src/live-model.ts` 的 `withEmptyAssistantContent`。
 *
 * ### 位置：`invalidToolArgs` 的內側
 *
 * 清在修補之前：被切斷的那一顆本來會被 {@link ./invalid-tool-args.ts} 改寫成 `{}` 參數的正常呼叫，
 * 清掉之後它看到的是一則沒有壞呼叫的回覆，什麼都不做。外面每一顆（起訖紀錄器記進日誌的那一則、
 * 用量記錄器）看到的都是清過的。工具那一半是 `tools/execute` 內層最內一位，在圍堵、每個 plugin 與輸出校驗的內側，圍堵記進
 * `tool/result` 的是換過的那則；時刻索引見 `apps/harness/src/interception-index.test.ts`。
 *
 * ## 登記的偏離
 *
 * 1. **認得的字串是 `length` 與 `max_tokens`**，照 dsh 在轉接器那一層分類。web 那條路的原始值在
 *    我們拿到之前就被 `@langchain/core` 對映過（`dist/language_models/openai_completions_stream.js:260-270`
 *    的 `mapFinishReason`）：**已知字串只是改名**；不認得的供應商字串原本一律變成 `stop`，現在在 `fetch` 層就被
 *    `apps/harness/src/live-model.ts` 的 `withStreamCompletionCheck` 當成失敗（`UnknownFinishReasonError`，#1538），走不到這裡。
 *    CLI 那條（非串流 `_generate`）拿到的是供應商原字串。
 * 2. **子代理那一側退到一份載體**：dsh 的子代理有自己的 `turn/end`，`task` 讀它的原因；我們子代理的
 *    日誌沒有 `turn/end`，基座的 `task` 只交回文字。所以由子代理的模型呼叫記、父圖的 `task` 取，
 *    鍵是兩邊各自算得出來的同一個 `runId`（`session-address.ts` 的 {@link spawnedSubagentRunId}）。
 *    **背景子代理不記**（[#858](https://github.com/DemianLi/nexus-agent/issues/858)）：它是最上層的圖，沒有父圖的 `task` 來取，記了只是漏；
 *    它的撞限由日誌上回覆的 `finish_reason` 讀。
 *
 * ## 載體只活在這個行程
 *
 * 同 {@link ./invalid-tool-args.ts}：寫與讀在同一次 `task` 呼叫之內，中間不跨 checkpoint。
 * 拋錯的那次也在 `finally` 裡取走，不留給下一次。
 *
 * @module
 */

import { AIMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from './base-types.js';
import { withModelCallStep } from './model-call-step.js';
import {
  isBackgroundCall,
  spawnedSubagentRunId,
  toolCallSessionAddress,
} from './session-address.js';
import { currentTurnStart } from './session-log.js';
import type { SessionEvent, TurnEndReason } from './session-log.js';
import { toolRefusal } from './tool-events.js';
import { freshTextResult } from './tool-pipeline.js';
import type { CoreToolListener, PipelineExecuteResult, PipelineResult } from './tool-pipeline.js';

/** 這顆 middleware 的名字。排序斷言用得到。 */
export const MAX_TOKENS_MIDDLEWARE_NAME = 'nexusMaxTokens';

/** 撞到上限的那一輪收尾時帶的原因。 */
export const MAX_TOKENS_TURN_END: TurnEndReason = { kind: 'max-tokens' };

/**
 * 算「撞到輸出上限」的 `finish_reason`。`length` 是 OpenAI 相容供應商的原字串，也是 web 那條路
 * 對映過的值；`max_tokens` 是 `@langchain/core` 的對映函式另外認得、也收成 `length` 的那一個。
 */
const MAX_TOKENS_FINISH_REASONS: ReadonlySet<string> = new Set(['length', 'max_tokens']);

/** 基座派子代理的那顆工具。 */
const TASK_TOOL = 'task';

/**
 * 子代理撞到上限時父代理看到的那一句，**逐字照 dsh**（`tool-subagent/src/index.ts:165`）。
 * 前綴 `Error: ` 由 `toolRefusal` 加。
 */
export const SUBAGENT_MAX_TOKENS_REASON = 'subagent run hit its token limit before finishing';

/** 已經寫出的那一段接在錯誤後面的標頭，逐字照 dsh（`tool-subagent/src/index.ts:194`）。 */
const PARTIAL_OUTPUT_HEADING = 'Partial output before the run ended:';

/**
 * 一則回覆的 `response_metadata` 說它撞到了輸出上限。
 *
 * @param responseMetadata - 回覆的 `response_metadata`；日誌那一份也是同一格。
 * @returns `finish_reason` 是 {@link MAX_TOKENS_FINISH_REASONS} 之一時為真。
 */
export function isMaxTokensFinish(responseMetadata: unknown): boolean {
  if (typeof responseMetadata !== 'object' || responseMetadata === null) return false;
  const reason = (responseMetadata as { finish_reason?: unknown }).finish_reason;
  return typeof reason === 'string' && MAX_TOKENS_FINISH_REASONS.has(reason);
}

/** content 裡屬於工具呼叫的那幾種區塊：v3 那條把呼叫放在這裡，建構子也會替 `tool_calls` 補。 */
const TOOL_CALL_BLOCK_TYPES: ReadonlySet<string> = new Set([
  'tool_call',
  'tool_call_chunk',
  'invalid_tool_call',
]);

function isToolCallBlock(block: unknown): boolean {
  if (typeof block !== 'object' || block === null) return false;
  const type = (block as { type?: unknown }).type;
  return typeof type === 'string' && TOOL_CALL_BLOCK_TYPES.has(type);
}

/**
 * 把一則回覆的工具呼叫全部拿掉，其餘原樣：同 dsh 的 assembler 在 `max-tokens` 時丟掉每一個
 * `tool-call` 區塊。**同一則裡在被切斷那顆之前已經完整的呼叫也丟**——dsh 不派發這一則的任何呼叫。
 *
 * 清四處：`tool_calls`、`invalid_tool_calls`、`additional_kwargs.tool_calls`（CLI 那條的原字串在
 * 這裡，`tool_calls` 空的時候轉換器會拿它回送，見 {@link ./invalid-tool-args.ts}）、content 裡的
 * 工具呼叫區塊。文字、推理、`response_metadata`、用量都留著。
 *
 * @param message - 撞到上限的那一則。
 * @returns 沒有工具呼叫的那一則；本來就沒有的原樣回傳。
 */
export function dropToolCalls(message: AIMessage): AIMessage {
  const hasCalls =
    (message.tool_calls ?? []).length > 0 ||
    (message.invalid_tool_calls ?? []).length > 0 ||
    message.additional_kwargs.tool_calls !== undefined ||
    (Array.isArray(message.content) && message.content.some(isToolCallBlock));
  if (!hasCalls) return message;
  const { tool_calls: _replayedVerbatim, ...kwargs } = message.additional_kwargs;
  return new AIMessage({
    ...(message.id === undefined ? {} : { id: message.id }),
    ...(message.name === undefined ? {} : { name: message.name }),
    content: Array.isArray(message.content)
      ? message.content.filter((block) => !isToolCallBlock(block))
      : message.content,
    additional_kwargs: kwargs,
    response_metadata: message.response_metadata,
    ...(message.usage_metadata === undefined ? {} : { usage_metadata: message.usage_metadata }),
    tool_calls: [],
    invalid_tool_calls: [],
  });
}

/**
 * 子代理撞到上限的消息，從它的模型呼叫帶到父圖的 `task`：以子代理的 `runId` 為鍵，值是那一則
 * 已經寫出的文字。
 *
 * **一份組裝一份，root 與每個子代理共用**：寫的在子代理那一層、讀的在父圖那一層，得看到同一份。
 * 鍵一次 spawn 一個，不會撞。
 */
export interface MaxTokensCarrier {
  /** 記下這個子代理撞到上限，以及那一則寫出的文字。同一次 spawn 撞第二次時蓋掉。 */
  record(runId: string, partial: string): void;
  /** 取走並刪掉；沒有就 `undefined`。 */
  take(runId: string): string | undefined;
}

/**
 * 建一份載體。
 *
 * @returns 空的載體。
 */
export function createMaxTokensCarrier(): MaxTokensCarrier {
  const partials = new Map<string, string>();
  return {
    record: (runId, partial) => {
      partials.set(runId, partial);
    },
    take: (runId) => {
      const partial = partials.get(runId);
      partials.delete(runId);
      return partial;
    },
  };
}

/**
 * 子代理撞到上限時 `task` 交給父代理的那則：`Error: ` 加上 {@link SUBAGENT_MAX_TOKENS_REASON}，
 * 有寫出字的話後面接那一段，同 dsh 的 `withDiagnosticAndPartialText`。
 *
 * **不帶碼**：dsh 那側是一般拋錯，註冊表不給碼，同圍堵對一般拋錯的做法（`containment.ts` 的
 * `classifyThrownToolError`）。
 *
 * 交回的是新造的一則（`fresh`），同拋錯翻出來的那種。**`Command` 只換那則 ToolMessage**（交回帶內容的 `command` 結果）：
 * 基座的 `task` 回的 `Command` 還帶著子代理寫進 state 的檔案與其他欄位（`deepagents@1.13.1` 的
 * `returnCommandWithStateUpdate`），那些是真的做了的事，不能跟著丟。`update` 不是物件、或本體回的不是 `Command` 時放不進那則，
 * 整個換成新造的一則。
 *
 * @param result - 基座 `task` 回來的結果（`next()` 的視圖）。
 * @param callId - 這次呼叫的 id。
 * @param partial - 子代理那一則已經寫出的文字。
 * @returns 要交回 `tools/execute` 的結果。
 */
export function subagentMaxTokensResult(
  result: PipelineResult,
  callId: string,
  partial: string,
): PipelineExecuteResult {
  const text = partial.trim() === '' ? '' : `\n${PARTIAL_OUTPUT_HEADING}\n${partial}`;
  const refusal = toolRefusal(SUBAGENT_MAX_TOKENS_REASON + text, { callId, name: TASK_TOOL });
  return freshTextResult(result.kind, refusal.text, { isError: true });
}

/**
 * 當前這一段輪次裡，root 有沒有一則回覆撞到輸出上限。**sticky**：撞過一次，後面正常收的步也不
 * 降級，同 dsh（`agent.ts:332-337`）。
 *
 * 讀的是日誌的 `assistant/message`（起訖紀錄器記的，見 {@link ./model-calls.ts}），它的
 * `response_metadata` 原樣留著供應商那一格。範圍同 {@link currentTurnStart}。
 *
 * @param events - root 那一份會話日誌到目前為止的全部事件。
 * @returns 撞過就是真。
 */
export function turnReachedMaxTokens(events: readonly SessionEvent[]): boolean {
  const start = currentTurnStart(events);
  if (start < 0) return false;
  for (let at = start + 1; at < events.length; at += 1) {
    const event = events[at];
    if (event?.type !== 'assistant/message') continue;
    if (isMaxTokensFinish(event.data.message.data.response_metadata)) return true;
  }
  return false;
}

/** `wrapModelCall` 的請求裡，這一顆讀得到的那一格。 */
interface RuntimeRequest {
  readonly runtime?: { readonly configurable?: unknown };
}

/**
 * 造這顆 middleware：模型那一半。工具那一半是 {@link createMaxTokensListener}，兩半共用同一份載體。
 *
 * @param carrier - 這份組裝的載體，root 與每個子代理同一份。
 * @returns 要排在 `invalidToolArgs` 內側的 middleware。
 */
export function createMaxTokensMiddleware(carrier: MaxTokensCarrier): AgentMiddleware {
  return withModelCallStep(
    async (request, handler) => {
      const response = await handler(request);
      if (!AIMessage.isInstance(response) || !isMaxTokensFinish(response.response_metadata)) {
        return response;
      }
      const where = { configurable: (request as RuntimeRequest).runtime?.configurable };
      const address = toolCallSessionAddress(where);
      // 背景子代理不記：載體是父圖的 `task` 取走的，背景位址沒有人取（#858）。它的撞限由日誌上回覆的
      // `finish_reason` 讀（結算摘要的 `max-tokens`）。
      if (address?.kind === 'subagent' && !isBackgroundCall(where)) {
        carrier.record(address.runId, response.text);
      }
      return dropToolCalls(response);
    },
    (wrapModelCall) =>
      createMiddleware({
        name: MAX_TOKENS_MIDDLEWARE_NAME,
        wrapModelCall: wrapModelCall as never,
      }) as unknown as AgentMiddleware,
  );
}

/**
 * 這顆的工具那一半，`tools/execute` 內層最內一位的 core 監聽者：`task` 往內交，載體裡有這次派出去的子代理撞限留下的部分回覆，
 * 就把結果換成撞限的錯誤（{@link subagentMaxTokensResult}）。
 *
 * @param carrier - 這份組裝的載體，與 {@link createMaxTokensMiddleware} 同一份。
 * @returns 交給 fold 排進 `tools/execute` 內層的監聽者。
 */
export function createMaxTokensListener(
  carrier: MaxTokensCarrier,
): CoreToolListener<'tools/execute'> {
  return async (exec, next, site) => {
    if (site.name !== TASK_TOOL) return next();
    const runId = spawnedSubagentRunId({ configurable: site.configurable });
    if (runId === undefined) return next();
    let result: PipelineResult;
    try {
      result = await next();
    } catch (error: unknown) {
      // 拋錯的那次也取走：同一個 runId 不會再來，留著只是漏。
      carrier.take(runId);
      throw error;
    }
    const partial = carrier.take(runId);
    if (partial === undefined) return result;
    return subagentMaxTokensResult(result, exec.callId, partial);
  };
}
