import type { BaseMessage } from '@langchain/core/messages';
import { SUMMARY_INSTRUCTION } from '@nexus/core';

/**
 * 這份 prompt 是不是生摘要的那一次呼叫：模板（一則「Conversation to condense:」開頭的人話）或重播
 * （最後一則是摘要指令，[#2775](https://github.com/DemianLi/nexus-agent/issues/2775)）。`state` 與 `log` 的摘要請求形狀不同，
 * 比「兩邊每一輪 prompt 相同」的測試先用它把摘要那幾次分出去。
 *
 * @param prompt - 模型那一次收到的訊息串。
 * @returns 是不是生摘要的呼叫。
 */
export function isSummaryCallPrompt(prompt: readonly BaseMessage[]): boolean {
  const content = prompt.at(-1)?.content;
  return (
    content === SUMMARY_INSTRUCTION ||
    (prompt.length === 1 &&
      typeof content === 'string' &&
      content.startsWith('Conversation to condense:'))
  );
}
