/**
 * 這條會話的歷史（磁碟上的會話日誌）裡有一則巢狀太深，serve 灌不回狀態、這條會話建不起來（`thread_history_too_deep`，
 * [#1668](https://github.com/DemianLi/nexus-agent/issues/1668)）時，給使用者看的那一句（[#1753](https://github.com/DemianLi/nexus-agent/issues/1753)）。
 *
 * **不顯示 server 的 message**：那句寫了日誌第幾顆事件、幾層、上限多少，是給管理者看的；原文留在 serve 的日誌。
 * **這種拒絕是永久的**，同一份日誌每次都一樣深：下行收到它不排重試（`hooks/use-conversation.ts`，同子代理的會話），
 * 打開時讀的那幾樣也不重讀（`hooks/use-open-read.ts`）。跟暫時性的 thread 數滿了（`lib/thread-capacity.ts`）不同。
 *
 * @module
 */

import { THREAD_HISTORY_TOO_DEEP } from '@nexus/wire';

/** 這條會話的歷史太深、打不開。講是歷史的形狀，指向使用者做得到的下一步；不提層數、上限、thread 或日誌。 */
export const THREAD_HISTORY_TOO_DEEP_TEXT =
  '這條對話的歷史裡有內容巢狀太深，打不開。請開新的對話。';

/** 錯誤碼是「歷史太深」就回 {@link THREAD_HISTORY_TOO_DEEP_TEXT}，其他碼回 `undefined`。 */
export function threadHistoryTooDeepText(code: string | undefined): string | undefined {
  return code === THREAD_HISTORY_TOO_DEEP ? THREAD_HISTORY_TOO_DEEP_TEXT : undefined;
}
