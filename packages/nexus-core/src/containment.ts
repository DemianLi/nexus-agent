/**
 * 圍堵：讓工具的失敗變成一則回饋，而不是讓整場 run 死掉。
 *
 * **這不是新功能，是修回基座自己的預設。** `ToolNode.runTool` 只要
 * `this.wrapToolCall` 存在，就把工具自己拋的錯當成 middleware 的錯
 * （`langchain@1.5.10`，`dist/agents/nodes/ToolNode.js:275-282`），而 `#handleError:150`
 * 對 middleware 的錯是 `handleToolErrors !== true` 即重拋。`ReactAgent` 建 `ToolNode`
 * 時只傳 `{ signal, wrapToolCall }`（`:174-179`），**`handleToolErrors: true` 經由
 * `createAgent` 根本到不了**，所以那不是一個可以設回去的預設值。
 *
 * 而 `createDeepAgent` 永遠掛 `FilesystemMiddleware`，它**永遠帶 `wrapToolCall`**
 * （`deepagents@1.13.1`）。兩件事湊在一起的結果是：**任何一個工具拋錯，整場 run 直接
 * 死**——沒有 ToolMessage、沒有回饋、模型不知道發生過什麼。
 *
 * ## 它為什麼住在 core 而不是某個 plugin
 *
 * dsh 那側**不把這件事做成可選的**：它是註冊表執行管線自己的 `catch`
 * （`packages/core/tools/src/index.ts:1494-1496` → `toolErrorResult`，SHA `4e84901`），
 * 文件把它寫成性質而不是功能——「未知工具和抛出异常的工具都会变为结构化错误……
 * **调用失败但不终止当前轮次**」（`docs/subsystems/tools.zh.md:404`）。
 * 做成一個掛不掛隨人的 plugin 才是偏離。
 *
 * 這一版之前它確實住在 `@nexus/plugin-validation`，而那個 plugin **不在任何一份正式
 * 清單裡**——也就是說產品路徑上的每一個工具，今天拋錯都會殺掉整場 run
 * （[#159](https://github.com/DemianLi/nexus-agent/issues/159)）。搬到 fold 打底之後，
 * 「有沒有圍堵」不再是清單怎麼寫的事。plugin 那側的公開名字保留成 re-export。
 *
 * **一條命脈是 `isGraphBubbleUp`。** LangGraph 的中斷（`interrupt()`）是用拋例外實作的，
 * 一個不分辨的 `try/catch` 會把 HITL 的暫停整個吃掉——實測 `__interrupt__` 消失、
 * 換成一則假的 error ToolMessage，核准點就這樣無聲地不見了。那正好是
 * [#71](https://github.com/DemianLi/nexus-agent/pull/71) 釘住的那些行為。搬家之後圍堵
 * 第一次包住 root 與**每個 subagent** 的核准路徑，所以那條命脈在新位置重量過一次
 * （`apps/harness/src/interrupt.test.ts`、`validation.test.ts`）。
 */

import { ToolMessage } from '@langchain/core/messages';
import { isGraphBubbleUp } from '@langchain/langgraph';
import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from './base-types.js';

/** 圍堵 middleware 的名字。錯誤訊息與排序斷言用得到。 */
export const CONTAINMENT_MIDDLEWARE_NAME = 'nexusToolFailureContainment';

/**
 * 工具自己拋錯時給模型的那句話。
 *
 * 這個字串**會送進模型的 context**，所以有兩條規矩：不帶堆疊、不帶原始參數。
 * 基座自己那條路兩樣都帶——`ToolInvocationError` 的訊息把
 * `JSON.stringify(toolCall.args)` 與整段 `error.stack` 都塞進去（實測），那是 PR #72
 * 那個外洩形狀掉頭往內指。參數本來就在同一輪的 AI 訊息裡，模型看得到，複誦一次
 * 只是多一份、不是多一個資訊。
 *
 * @param toolName - 失敗的那顆工具。
 * @param error - 它拋出來的東西。
 * @returns 給模型看的那一句。
 */
export function formatToolFailure(toolName: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `工具 ${toolName} 執行失敗：${detail}`;
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

/**
 * 造一個把工具失敗翻成 error ToolMessage 的 middleware。
 *
 * 它**必須排在整份 middleware 陣列的第 0 格**（root 與每個 subagent 都是）：`wrapToolCall`
 * 是層層相包的，越前面越外層，而圍堵的射程要涵蓋內層每一個 middleware——連核准閘門
 * 與校驗器自己的 bug 都在裡面。基座自己那幾個 middleware 永遠排在所有這些之前，接不到，
 * 那是 `createDeepAgent` 的組裝順序，不是這裡能決定的事。掛法見 `fold.ts`。
 *
 * **一份實例走遍 root 與每個 subagent。** 它沒有 closure 狀態——`try/catch` 裡讀到的
 * 一切都來自那一次呼叫的 `request`。
 *
 * @returns 可以放進 `middleware` 陣列的 middleware。
 */
export function createContainmentMiddleware(): AgentMiddleware {
  return createMiddleware({
    name: CONTAINMENT_MIDDLEWARE_NAME,
    wrapToolCall: async (request, handler) => {
      try {
        return await handler(request);
      } catch (error) {
        // 中斷、`Command` 這類控制流是用拋例外走的，接住它們等於把功能吃掉。
        if (isGraphBubbleUp(error)) throw error;
        const toolName = resolveToolName(request);
        return new ToolMessage({
          content: formatToolFailure(toolName, error),
          tool_call_id: request.toolCall.id ?? '',
          name: toolName,
          // 基座自己的錯誤回饋**不設 `status`**（`defaultHandleToolErrors`，實測
          // `undefined`），等於錯誤散文以一則結構上成功的訊息送進模型。這裡比基座嚴。
          status: 'error',
        });
      }
    },
  }) as AgentMiddleware;
}
