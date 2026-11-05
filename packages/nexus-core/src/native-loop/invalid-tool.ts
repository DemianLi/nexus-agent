/**
 * 模型叫了不存在的工具時回的那一則。兩個 loop 要回同一句：`langgraph` 由 langchain 的 `ToolNode` 回，native 由這裡回。
 *
 * @module
 */

import type { ToolCall } from '@langchain/core/messages';
import { ToolMessage } from '@langchain/core/messages';

/**
 * 找不到工具時的 `ToolMessage`，文字與狀態逐字同 langchain `ToolNode` 的 `getInvalidToolError`。
 * @param call - 叫錯的那一顆。
 * @param available - 註冊了的工具名，照註冊順序。
 * @returns 帶 `status: 'error'` 的結果。
 */
export function invalidToolMessage(call: ToolCall, available: readonly string[]): ToolMessage {
  return new ToolMessage({
    content: `Error: ${call.name} is not a valid tool, try one of [${available.join(', ')}].`,
    tool_call_id: call.id ?? '',
    name: call.name,
    status: 'error',
  });
}
