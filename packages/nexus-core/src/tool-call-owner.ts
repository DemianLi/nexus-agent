/**
 * 一次工具呼叫屬於哪一則助手訊息：`wrapToolCall` 那幾個讀者（屏障、`returnDirect` 的收尾、解不開參數的原字串）都要倒著找它。
 *
 * - `history-source=log` 而且是 root 的呼叫：從那一份會話日誌的 `assistant/message` 找（[#2355](https://github.com/DemianLi/nexus-agent/issues/2355)，
 *   `.docs/agent-loop-off-langchain-design-2026-11-03.md` §四 W6）。歷史從日誌推，讀者讀的也是日誌。
 * - 其餘（`state`／`shadow`、子代理）：從 `request.state.messages` 找。子代理的歷史由 state 送，讀者跟著讀 state。
 *
 * 兩邊都是**倒著找、認 callId**：供應商重用 callId 時最近的那則才是這一次。
 *
 * @module
 */

import { isHistoryFromLog } from './history-shadow.js';
import type { SessionLookup } from './registry.js';
import type { SessionEvent } from './session-log.js';

/** 讀者要的那幾格：呼叫清單、訊息 id、`additional_kwargs`。 */
export interface ToolCallOwner {
  readonly id?: string;
  readonly tool_calls: readonly { readonly id?: string }[];
  readonly additional_kwargs?: Readonly<Record<string, unknown>>;
}

/** 讀者交進來的請求：只讀這三格。 */
export interface ToolCallOwnerRequest {
  readonly toolCall: { readonly id?: string };
  readonly state?: unknown;
  readonly runtime?: { readonly configurable?: unknown };
}

const callsOf = (message: unknown): readonly { readonly id?: string }[] | undefined => {
  const calls = (message as { tool_calls?: unknown } | undefined)?.tool_calls;
  return Array.isArray(calls) ? (calls as { id?: string }[]) : undefined;
};

/**
 * 這次呼叫所屬的那則助手訊息。`callId` 是空的、找不到那則訊息、沒有 `state`，都是 `undefined`。
 *
 * @param request - `wrapToolCall` 收到的請求。
 * @param sessions - 那條 thread 的 `registry.sessions`；省略就只讀 state（單元測試、沒接會話的組裝）。
 * @returns 那則訊息的 {@link ToolCallOwner}，或 `undefined`。
 * @throws `log` 時找不到這次呼叫的日誌：讀者不能退回 state。
 */
export function toolCallOwner(
  request: ToolCallOwnerRequest,
  sessions?: { forCall(config: unknown): SessionLookup },
): ToolCallOwner | undefined {
  const callId = request.toolCall.id;
  if (callId === undefined || callId === '') return undefined;
  if (sessions !== undefined && isHistoryFromLog(sessions)) {
    const found = sessions.forCall({ configurable: request.runtime?.configurable });
    if (found.kind !== 'ok') {
      throw new Error(`工具呼叫找不到這次的日誌（${found.kind}）：history-source=log 不退回 state`);
    }
    if (found.address.kind === 'root') return ownerInLog(found.log.events, callId);
  }
  return ownerInState(request.state, callId);
}

function ownerInState(state: unknown, callId: string): ToolCallOwner | undefined {
  const messages = (state as { messages?: unknown } | undefined)?.messages;
  if (!Array.isArray(messages)) return undefined;
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const calls = callsOf(messages[at]);
    if (calls?.some((call) => call.id === callId) === true) {
      return messages[at] as ToolCallOwner;
    }
  }
  return undefined;
}

function ownerInLog(events: readonly SessionEvent[], callId: string): ToolCallOwner | undefined {
  for (let at = events.length - 1; at >= 0; at -= 1) {
    const event = events[at]!;
    if (event.type !== 'assistant/message') continue;
    const data = (event.data as { message: { data: unknown } }).message.data;
    const calls = callsOf(data);
    if (calls?.some((call) => call.id === callId) === true) return data as ToolCallOwner;
  }
  return undefined;
}
