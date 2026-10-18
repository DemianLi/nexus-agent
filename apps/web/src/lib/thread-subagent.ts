/**
 * 這個 id 是子代理的會話，serve 不讓它當一條 thread 開（`thread_is_subagent`，[#1544](https://github.com/DemianLi/nexus-agent/issues/1544)）時，
 * 給使用者看的那一句（[#1708](https://github.com/DemianLi/nexus-agent/issues/1708)）。
 *
 * **不顯示 server 的 message**：那句提 `subagent.send`，是給呼叫 wire 的程式看的。**這種拒絕是永久的**，重試幾次都一樣，
 * 所以下行收到它不排重試（`hooks/use-conversation.ts`），跟暫時性的 thread 數滿了（`lib/thread-capacity.ts`）不同。
 *
 * @module
 */

import { THREAD_IS_SUBAGENT } from '@nexus/wire';

/** 這條是子代理的對話，不能單獨打開。指回主對話，不提 thread、wire 或命令名。 */
export const THREAD_IS_SUBAGENT_TEXT = '這是子代理的對話，請從主對話查看。';

/** 錯誤碼是「子代理的會話」就回 {@link THREAD_IS_SUBAGENT_TEXT}，其他碼回 `undefined`。 */
export function threadSubagentText(code: string | undefined): string | undefined {
  return code === THREAD_IS_SUBAGENT ? THREAD_IS_SUBAGENT_TEXT : undefined;
}
