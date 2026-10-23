/**
 * 「這一輪在這一批工具之後收」（`concludeTurn`）怎麼落到基座的路由上（[#1607](https://github.com/DemianLi/nexus-agent/issues/1607)）。
 *
 * ## dsh 的形狀
 *
 * dsh 的 `concludeTurn()` 是 exec 上的 core 能力（`plan-mode/src/index.ts:331-341`）：工具本體在某一個結局呼叫它，
 * 迴圈整批工具跑完才判（`agent.ts:361-364`：收了、`nextStep` 是空的 → `agent/turn-stopping` → 跳出；`nextStep` 還有東西就繼續）。
 * 其餘一切（拋錯、拒絕）都照常回頭給模型。
 *
 * ## 基座的做法（退到最接近的實作，理由 1）
 *
 * langchain 的 tools 節點出去的條件邊（`ReactAgent.js:359-365`，`langchain@1.5.10`）只看**最後一則 ToolMessage 的 `name`
 * 在不在靜態收集的 `returnDirect` 名單**：在就走 exitNode（所有 `afterAgent` 照跑：step-inbox 領 `next-step`、改動紀錄輪內記錄），
 * 不在就回頭叫模型。名單是依工具名靜態收的，單設 `returnDirect: true` 會讓這顆工具**每一種結局**都收，所以：
 *
 * - 工具設 `returnDirect: true`（宣告「這顆可能收這一輪」）；
 * - 工具本體只在要收的那個結局呼叫 {@link concludeTurn}（正向標記）；
 * - **圍堵在最外層**（{@link settleTurnConclusion}）：`returnDirect` 工具的結果，沒有標記就拿掉 `name`——路由看 `name`，空的不在名單裡。
 *
 * 圍堵是每個 `wrapToolCall` 裡最外層的一格（`containment.ts`），核准閘門、參數驗證、`toolPreExecute`、invalid-tool-args 的樁與
 * 它自己接住的拋錯，全在它裡面。不論哪一層造的錯誤或拒絕，都沒有標記，都照常回頭叫模型（root 與每個子代理一樣）。
 *
 * 日誌上的 `tool/result` 是**拿掉 `name` 之前**那一則（圍堵先記再交出），所以日誌與以前逐位元組相同；只有交給基座的 state 少了 `name`。
 *
 * ## 登記的偏離（理由 1：基座表達不出來）
 *
 * dsh 是批內**任何一個**工具 `concludeTurn()` 就收；這裡只有**那一批唯一的工具呼叫**標了才收。
 * 基座把每個工具呼叫各自送成一個 `Send`，tools 路由各判各的：一批裡有的走 exitNode（`afterAgent`）、有的回頭走 `beforeModel`，
 * 兩條在同一個 super-step 都寫 `jumpTo`，langgraph 擲 `InvalidUpdateError`，整輪垮掉（只要掛了任何 `beforeModel`，例如 step-inbox；
 * `apps/harness/src/returndirect-route.test.ts` 釘住基座形狀）。所以批裡不只一個呼叫時，標了也拿掉 `name`，照常繼續。
 *
 * @module
 */

import { AIMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';

import { markToolError, toolErrorOf } from './tool-events.js';

/** {@link settleTurnConclusion} 讀得到的那幾格；`wrapToolCall` 的請求都符合。 */
export interface TurnConclusionRequest {
  readonly tool?: unknown;
  readonly toolCall: { readonly id?: string };
  readonly state: unknown;
}

/** 這個請求的工具有沒有宣告 `returnDirect`。`tool` 取不到（動態加給模型的工具）就當沒有，結果原樣放行。 */
function declaresReturnDirect(request: TurnConclusionRequest): boolean {
  return (request.tool as { returnDirect?: unknown } | undefined)?.returnDirect === true;
}

/** 這次呼叫所屬的那則 AI 訊息一共叫了幾個工具；找不到那則訊息就當一個。 */
function batchSizeOf(request: TurnConclusionRequest): number {
  const messages = (request.state as { messages?: readonly BaseMessage[] } | undefined)?.messages;
  if (messages === undefined) return 1;
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at]!;
    if (
      AIMessage.isInstance(message) &&
      message.tool_calls?.some((call) => call.id === request.toolCall.id) === true
    ) {
      return message.tool_calls.length;
    }
  }
  return 1;
}

/**
 * 同一則 ToolMessage 去掉 `name`。**只換 `name`**：內容、狀態、id、artifact、`additional_kwargs`、`response_metadata`、
 * `metadata` 原樣，圍堵與內層標的錯誤碼（{@link markToolError} 掛在物件上，新物件要重掛）一併帶上。
 */
function withoutName(message: ToolMessage): ToolMessage {
  const copy = new ToolMessage({
    content: message.content,
    tool_call_id: message.tool_call_id,
    status: message.status,
    additional_kwargs: message.additional_kwargs,
    response_metadata: message.response_metadata,
    ...(message.id === undefined ? {} : { id: message.id }),
    ...(message.artifact === undefined ? {} : { artifact: message.artifact }),
    ...(message.metadata === undefined ? {} : { metadata: message.metadata }),
  });
  const code = toolErrorOf(message);
  return code === undefined ? copy : markToolError(copy, code);
}

/**
 * 圍堵交出結果之前最後一步：`returnDirect` 工具的結果，**標了才收**。
 *
 * @param request - 這次呼叫的 `wrapToolCall` 請求。
 * @param value - 圍堵要交出去的東西（成功的結果、內層回的錯誤訊息、圍堵自己接住拋錯翻出來的訊息）。
 * @param concluded - 工具本體有沒有呼叫 {@link concludeTurn}。
 * @returns 要收：原物（帶 `name`，路由走 exitNode）；不收：去掉 `name` 的同一則；不是 `returnDirect` 工具、
 *   不是 ToolMessage（`Command`）、本來就沒有 `name`：原物。
 */
export function settleTurnConclusion<T>(
  request: TurnConclusionRequest,
  value: T,
  concluded: boolean,
): T {
  if (!declaresReturnDirect(request)) return value;
  if (!ToolMessage.isInstance(value) || value.name === undefined) return value;
  if (concluded && batchSizeOf(request) <= 1) return value;
  return withoutName(value) as T;
}
