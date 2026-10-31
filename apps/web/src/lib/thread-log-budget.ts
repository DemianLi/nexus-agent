/**
 * 這條會話的日誌放不進 serve 的額度、重開被拒（`thread_log_too_large`、`thread_log_busy`，
 * [#2115](https://github.com/DemianLi/nexus-agent/issues/2115)、[#2203](https://github.com/DemianLi/nexus-agent/issues/2203)）時，
 * 給使用者看的那兩句。
 *
 * **不顯示 server 的 message**：那句寫了大小、額度與管理者的下一步，用的人動不了。
 * **兩種拒絕重試的結果不同**：`thread_log_too_large` 是永久的，要管理者調額度或加記憶體後重啟，下行不排重試、打開時讀的那幾樣也不重讀；
 * `thread_log_busy` 是暫時的，別條會話關掉或閒置逐出後就可能放得下，同 `lib/thread-capacity.ts` 走重試（`hooks/use-conversation.ts`、`hooks/use-open-read.ts`）。
 *
 * @module
 */

import { THREAD_LOG_BUSY, THREAD_LOG_TOO_LARGE } from '@nexus/wire';

/** 這條會話的紀錄太大、這台伺服器讀不進來。說對話沒有壞，指向管理者；不提數字、額度或日誌。 */
export const THREAD_LOG_TOO_LARGE_TEXT =
  '這條對話的紀錄太大，這台伺服器現在讀不進來。對話沒有壞，請聯絡管理者。';

/** 額度被別的會話佔滿，這條暫時打不開。說對話沒有壞、可以再試；不提數字、額度或日誌。 */
export const THREAD_LOG_BUSY_TEXT =
  '伺服器現在開著的對話佔滿了記憶體，這條暫時打不開。對話沒有壞，稍後再試；一直打不開請聯絡管理者。';

/** 錯誤碼是「紀錄太大」就回 {@link THREAD_LOG_TOO_LARGE_TEXT}，其他碼回 `undefined`。 */
export function threadLogTooLargeText(code: string | undefined): string | undefined {
  return code === THREAD_LOG_TOO_LARGE ? THREAD_LOG_TOO_LARGE_TEXT : undefined;
}

/** 錯誤碼是「額度被佔滿」就回 {@link THREAD_LOG_BUSY_TEXT}，其他碼回 `undefined`。 */
export function threadLogBusyText(code: string | undefined): string | undefined {
  return code === THREAD_LOG_BUSY ? THREAD_LOG_BUSY_TEXT : undefined;
}

/** 兩種拒絕的那一句，給不必分永久或暫時的地方用；其他碼回 `undefined`。 */
export function threadLogBudgetText(code: string | undefined): string | undefined {
  return threadLogTooLargeText(code) ?? threadLogBusyText(code);
}
