/**
 * 送給模型之前，把圍堵拿掉的 `name` 補回去（`turn-conclusion.ts`）：`returnDirect` 工具沒標記收尾的結果，交給基座時沒有 `name`，
 * 路由因此不收這一輪；模型看的那一份要跟沒拿掉時逐位元組相同（Chat Completions 的轉換器會把 `name` 送出去）。
 *
 * 拿掉的是 core，補回也歸 core：兩個 loop、root 與每個子代理都掛，**只在那一份工具清單裡有 `returnDirect` 工具時才掛**
 * （槽位表）。工具清單在組裝時就定了：出貨上 `returnDirect` 由 `NexusTool` 的 `concludesTurn` 經轉接器帶上，`wrapModelCall`
 * 動態加給模型的工具，圍堵查不到 `tool`，本來就不拿掉 `name`。
 *
 * 路由只看 state 裡的訊息，模型看的是這一份複本；沒有要補的就原物返回，不碰別的 middleware 看到的東西。
 *
 * @module
 */

import { AIMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from 'langchain';

import { withModelCallStep } from './model-call-step.js';

/** 這一顆的名字。 */
export const TOOL_NAME_RESTORE_MIDDLEWARE_NAME = 'nexusToolNameRestore';

/**
 * 補回 `name` 之後的請求：`names` 裡那幾顆工具的結果、沒有 `name` 的，照叫它的那個工具呼叫補上。
 *
 * @param request - 這一次模型呼叫的請求。
 * @param names - 宣告了 `returnDirect` 的工具名。
 * @returns 有補的話是換過 `messages` 的新請求；沒有要補的就是原物。
 */
export function withToolNamesRestored<T extends { messages?: readonly BaseMessage[] }>(
  request: T,
  names: ReadonlySet<string>,
): T {
  const messages = request.messages;
  if (messages === undefined) return request;
  const callNames = new Map<string, string>();
  for (const message of messages) {
    if (!AIMessage.isInstance(message)) continue;
    for (const call of message.tool_calls ?? []) {
      if (names.has(call.name) && call.id !== undefined) callNames.set(call.id, call.name);
    }
  }
  if (callNames.size === 0) return request;
  let changed = false;
  const named = messages.map((message) => {
    const name = ToolMessage.isInstance(message) ? callNames.get(message.tool_call_id) : undefined;
    if (name === undefined || !ToolMessage.isInstance(message) || message.name !== undefined) {
      return message;
    }
    changed = true;
    return new ToolMessage({
      content: message.content,
      tool_call_id: message.tool_call_id,
      status: message.status,
      name,
      ...(message.id === undefined ? {} : { id: message.id }),
      ...(message.artifact === undefined ? {} : { artifact: message.artifact }),
      additional_kwargs: message.additional_kwargs,
      response_metadata: message.response_metadata,
    });
  });
  return changed ? { ...request, messages: named } : request;
}

/**
 * 建那一顆。
 *
 * @param names - 這一份工具清單裡宣告了 `returnDirect` 的工具名；呼叫端只在不是空的時候建。
 * @returns 可以放進 middleware 陣列的實例。
 */
export function createToolNameRestoreMiddleware(names: ReadonlySet<string>): AgentMiddleware {
  return withModelCallStep(
    (request, handler) =>
      handler(withToolNamesRestored(request as { messages?: readonly BaseMessage[] }, names)),
    (wrapModelCall) =>
      createMiddleware({
        name: TOOL_NAME_RESTORE_MIDDLEWARE_NAME,
        wrapModelCall: wrapModelCall as never,
      }) as unknown as AgentMiddleware,
  );
}
