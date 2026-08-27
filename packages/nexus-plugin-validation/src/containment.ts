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
 * （`deepagents@1.13.1`）。兩件事湊在一起的結果是：**nexus-agent 裡任何一個工具拋錯，
 * 整場 run 直接死**——沒有 ToolMessage、沒有回饋、模型不知道發生過什麼。
 *
 * dsh 把相反的行為寫成不可違反的性質：「未知工具和抛出异常的工具都会变为结构化错误……
 * **调用失败但不终止当前轮次**」（`docs/subsystems/tools.zh.md`）。這個 middleware
 * 就是把那句話搬回來。
 *
 * **一條命脈是 `isGraphBubbleUp`。** LangGraph 的中斷（`interrupt()`）是用拋例外實作的，
 * 一個不分辨的 `try/catch` 會把 HITL 的暫停整個吃掉——實測 `__interrupt__` 消失、
 * 換成一則假的 error ToolMessage，核准點就這樣無聲地不見了。那正好是 #71 釘住的那些行為。
 */

import { ToolMessage } from '@langchain/core/messages';
import { isGraphBubbleUp } from '@langchain/langgraph';
import type { AgentMiddleware } from '@nexus/core';
import { createMiddleware } from 'langchain';
import { formatToolFailure, resolveToolName } from './feedback.js';

/** 圍堵 middleware 的名字。錯誤訊息與排序斷言用得到。 */
export const CONTAINMENT_MIDDLEWARE_NAME = 'nexusToolFailureContainment';

/**
 * 造一個把工具失敗翻成 error ToolMessage 的 middleware。
 *
 * 它**必須掛在最外層**（`registry.middleware.use(mw, { prepend: true })`）：射程涵蓋
 * 內層每一個 plugin middleware，所以連校驗器自己的 bug 都接得住。基座自己那幾個
 * middleware 永遠排在所有 plugin 之前，接不到，那是 `createDeepAgent` 的組裝順序，
 * 不是這裡能決定的事。
 *
 * @returns 可以交給 `registry.middleware.use()` 的 middleware。
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
