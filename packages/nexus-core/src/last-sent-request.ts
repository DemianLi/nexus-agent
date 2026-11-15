/**
 * 每一份會話日誌「最近一次送出的模型請求」的系統訊息與呼叫選項，留在記憶體裡
 * （[#2775](https://github.com/DemianLi/nexus-agent/issues/2775)）。
 *
 * 生摘要的那一次呼叫要重播上一次主請求（系統訊息、工具、原訊息在前，摘要指令在最後），才吃得到供應商的前綴快取。
 * 訊息從日誌推得回來；系統訊息與工具要等洋蔥走完、模型被叫的那一刻才定案，而日誌上的 `request/system` 只有文字、
 * `request/header.tools` 是正規化過的三格，拿它們重組不保證與送出的位元組相同。所以這裡留的是 LangChain 在
 * `handleChatModelStart` 交出來的原物件。
 *
 * **不落盤**：行程重啟後沒有這一份，呼叫端退回模板。
 *
 * @module
 */
import type { BaseMessage } from '@langchain/core/messages';

import type { SessionLog } from './session-log.js';

/** 最近一次送出的請求裡，重播用得到的那兩樣。 */
export interface LastSentRequest {
  /** 開頭連續的系統訊息，送出時的原物件。 */
  readonly system: readonly BaseMessage[];
  /** 那次呼叫的選項（`bindTools` 綁的 `tools` 等），去掉只管那一次呼叫與回覆形狀的幾格。 */
  readonly options: Readonly<Record<string, unknown>>;
}

/**
 * 不跟著重播的選項：中止訊號與逾時是那一次呼叫自己的；其餘三格管的是「回覆長什麼樣」，不是提示詞的前綴，帶著走會讓
 * 摘要被逼著叫工具、照別人的 schema 回、或被停止序列截斷。
 */
const REPLY_SHAPING_OPTIONS: ReadonlySet<string> = new Set([
  'signal',
  'timeout',
  'tool_choice',
  'response_format',
  'stop',
]);

const lastSent = new WeakMap<SessionLog, LastSentRequest>();

/** LangChain 交給 callback 之前會改寫的內容：改寫過的不是送出的那一份。 */
function rewrittenForTracing(message: BaseMessage): boolean {
  if (!Array.isArray(message.content)) return false;
  return message.content.some(
    (block) => typeof block !== 'object' || block === null || block.type !== 'text',
  );
}

function isRedactedTool(tool: unknown): boolean {
  return typeof tool === 'object' && tool !== null && (tool as { type?: unknown }).type === 'mcp';
}

/**
 * 記下這份日誌剛送出的請求。交給 callback 的東西不保證是送出的那一份時（系統訊息帶非文字區塊、工具被遮蔽），
 * 連舊的一起清掉：寧可沒有，不留一份對不上的。
 *
 * @param log - 這次呼叫寫進的日誌。
 * @param messages - `handleChatModelStart` 收到的訊息串（一批一條）。
 * @param options - `extraParams.options`。
 */
export function noteSentRequest(
  log: SessionLog,
  messages: readonly (readonly BaseMessage[])[],
  options: unknown,
): void {
  const batch = messages[0] ?? [];
  let end = 0;
  while (end < batch.length && batch[end]!.getType() === 'system') end += 1;
  const system = batch.slice(0, end);
  const record =
    typeof options === 'object' && options !== null ? (options as Record<string, unknown>) : {};
  const tools = record['tools'];
  if (system.some(rewrittenForTracing) || (Array.isArray(tools) && tools.some(isRedactedTool))) {
    lastSent.delete(log);
    return;
  }
  const kept = Object.fromEntries(
    Object.entries(record).filter(([key]) => !REPLY_SHAPING_OPTIONS.has(key)),
  );
  lastSent.set(log, { system, options: kept });
}

/**
 * @param log - 會話日誌。
 * @returns 這份日誌最近一次送出的請求；這個行程裡還沒送過，或上一次的留不得，是 `undefined`。
 */
export function lastSentRequestOf(log: SessionLog): LastSentRequest | undefined {
  return lastSent.get(log);
}
