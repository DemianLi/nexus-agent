/**
 * 訊息標準化——感知輸入層那一薄層。
 *
 * 職責只有一件事：把入口（CLI、web、測試）手上那些形狀不一的東西，收斂成基座
 * `invoke` / `stream` 收的 `{ messages }`。刻意薄——開發計劃第 2 節把感知輸入層列為
 * 「自建（薄）／足夠」，多做的每一分都是在 LangChain 的 message 型別之上再疊一層自己的
 * 詞彙，而那正是升版時會漂掉的東西。
 */

import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';

/** 入口收得下的輸入：一句話、一則訊息，或一串它們的混合。 */
export type AgentInput = string | BaseMessage | readonly (string | BaseMessage)[];

/** 標準化之後的東西，可以直接交給 `agent.invoke()` 或 `agent.stream()`。 */
export interface AgentInvocation {
  messages: BaseMessage[];
}

/**
 * 把入口的輸入標準化成基座收的形狀。
 *
 * 字串一律視為使用者說的話（`HumanMessage`）；已經是 `BaseMessage` 的原樣通過——那是
 * 呼叫端刻意指定了角色，不該被猜。
 *
 * **空輸入直接失敗。** 基座收到空的 `messages` 會照樣起一輪，讓模型對著沒有內容的對話
 * 自由發揮；那個回合的結果沒有人看得懂是從哪來的。缺席即拒絕，與其他擴充點同一條線。
 *
 * @param input - 一句話、一則訊息，或一串它們的混合。
 * @returns 可以直接展進 `invoke` / `stream` 的參數。
 */
export function toAgentInvocation(input: AgentInput): AgentInvocation {
  const items = Array.isArray(input)
    ? (input as readonly (string | BaseMessage)[])
    : [input as string | BaseMessage];

  const messages = items
    .map((item) => (typeof item === 'string' ? item.trim() : item))
    // 只濾掉空字串：空的 `BaseMessage` 是呼叫端明著建出來的，不是我們該替它決定的事。
    .filter((item) => typeof item !== 'string' || item.length > 0)
    .map((item) => (typeof item === 'string' ? new HumanMessage(item) : item));

  if (messages.length === 0) {
    throw new Error(
      '輸入是空的，沒有東西可以交給 agent。' +
        '空的對話仍然會起一輪，而那一輪的輸出沒有人追得回是從哪個輸入來的。',
    );
  }

  return { messages };
}
