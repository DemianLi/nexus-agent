/**
 * 補懸空的工具呼叫——**`deepagents` 的 `createPatchToolCallsMiddleware` 的自有複本**。
 *
 * ## 為什麼要有這個檔
 *
 * 研究文件 [`.docs/rust-and-langchain-removal-2026-10-06.md`](../../../.docs/rust-and-langchain-removal-2026-10-06.md)
 * §七的接縫 6：拿掉 `deepagents` 的第一批。這顆 middleware 只有 190 行、不碰後端、不進模型看得到的
 * 工具清單，所以最先換。**只換載體，不改行為**：
 *
 * - 名字照舊是 `patchToolCallsMiddleware`——合併疊靠名字去重、`summarization.test.ts` 等測試按名字斷言。
 * - 補上去的那句英文逐字照舊，`thread-pump.ts` 與 `conversation-restore.test.ts` 都引用它的措辭。
 * - `beforeAgent` 用 `REMOVE_ALL_MESSAGES` 整串換掉的語意照舊。
 *
 * 逐字對照的證據是 `apps/harness/src/patch-tool-calls.test.ts`：同一串訊息分別丟給基座那顆與這顆，
 * 結果要完全相同。基座移除之前，那條測試同時是升版絆索。
 *
 * ## 它做兩件事
 *
 * 1. **補**：AI 訊息帶 `tool_calls`、之後卻沒有對應的 `ToolMessage`（輪被中斷、使用者插話）——
 *    在那則 AI 訊息後面補一則「被取消」的 `ToolMessage`。供應商會拒收配不到結果的呼叫。
 * 2. **丟**：`ToolMessage` 的 `tool_call_id` 在整串裡找不到任何 AI 訊息的呼叫與它配——丟掉這則孤兒。
 *
 * ## 不是 dsh `agent/pre-step` 的佔用者
 *
 * 載體雖是 `beforeAgent`，它修復歷史而不注入內容。dsh 對同一件事的做法在續行準備：`interruptedTurnClosers`
 * 把缺的工具結果**寫進日誌**；這裡只在每次 invoke 開頭改圖裡的狀態。攔截索引的
 * `PRE_STEP_NOT_OCCUPANTS` 明列了這個例外。
 *
 * 兩處掛點：`beforeAgent` 改**狀態**（一次 invoke 一次）、`wrapModelCall` 只改**這次送出去的請求**
 * （不動狀態），所以續行之後狀態被補過、同一輪裡新冒出來的懸空也不會漏到模型那裡。
 *
 * @module
 */

import { AIMessage, createMiddleware, ToolMessage } from 'langchain';
import { RemoveMessage, type BaseMessage } from '@langchain/core/messages';
import { REMOVE_ALL_MESSAGES } from '@langchain/langgraph';

/** middleware 的名字。**不要改**：合併疊按名字去重，測試按名字斷言。 */
export const PATCH_TOOL_CALLS_MIDDLEWARE_NAME = 'patchToolCallsMiddleware';

/**
 * 補懸空的呼叫並丟孤兒結果。
 *
 * @param messages - 一整串訊息。
 * @returns `patchedMessages` 是處理後的串；`needsPatch` 是有沒有任何改動。
 */
export function patchDanglingToolCalls(messages: readonly BaseMessage[]): {
  patchedMessages: BaseMessage[];
  needsPatch: boolean;
} {
  if (messages.length === 0) return { patchedMessages: [], needsPatch: false };

  // 第一遍：收齊所有 AI 訊息的呼叫 id，才認得出孤兒結果。
  const allToolCallIds = new Set<string>();
  for (const msg of messages) {
    if (AIMessage.isInstance(msg) && msg.tool_calls != null) {
      for (const toolCall of msg.tool_calls) {
        if (toolCall.id) allToolCallIds.add(toolCall.id);
      }
    }
  }

  // 第二遍：丟孤兒、替懸空的呼叫補一則結果。
  const patchedMessages: BaseMessage[] = [];
  let needsPatch = false;

  for (let index = 0; index < messages.length; index += 1) {
    const msg = messages[index] as BaseMessage;

    if (ToolMessage.isInstance(msg) && !allToolCallIds.has(msg.tool_call_id)) {
      needsPatch = true;
      continue;
    }

    patchedMessages.push(msg);

    if (AIMessage.isInstance(msg) && msg.tool_calls != null) {
      for (const toolCall of msg.tool_calls) {
        const answered = messages
          .slice(index + 1)
          .some((later) => ToolMessage.isInstance(later) && later.tool_call_id === toolCall.id);
        if (answered) continue;
        needsPatch = true;
        patchedMessages.push(
          new ToolMessage({
            // 這句話的措辭**逐字**照基座：成因其實是「那一輪被中斷」，不一定是「有新訊息進來」，
            // 但改字會讓 `thread-pump.ts` 與續行測試對不上它，改的話要連同它們一起想。
            content: `Tool call ${toolCall.name} with id ${toolCall.id} was cancelled - another message came in before it could be completed.`,
            name: toolCall.name,
            tool_call_id: toolCall.id as string,
          }),
        );
      }
    }
  }

  return { patchedMessages, needsPatch };
}

/**
 * 建一顆補懸空工具呼叫的 middleware。
 *
 * @returns 名字是 {@link PATCH_TOOL_CALLS_MIDDLEWARE_NAME} 的 middleware。
 */
export function createPatchToolCallsMiddleware() {
  return createMiddleware({
    name: PATCH_TOOL_CALLS_MIDDLEWARE_NAME,
    beforeAgent: async (state) => {
      const messages = state.messages;
      if (!messages || messages.length === 0) return;
      const { patchedMessages, needsPatch } = patchDanglingToolCalls(messages);
      if (!needsPatch) return;
      // 先清空再放回處理過的整串：`add_messages` reducer 只認這個寫法。
      return { messages: [new RemoveMessage({ id: REMOVE_ALL_MESSAGES }), ...patchedMessages] };
    },
    wrapModelCall: async (request, handler) => {
      const messages = request.messages;
      if (!messages || messages.length === 0) return handler(request);
      const { patchedMessages, needsPatch } = patchDanglingToolCalls(messages);
      if (!needsPatch) return handler(request);
      return handler({ ...request, messages: patchedMessages });
    },
  });
}
