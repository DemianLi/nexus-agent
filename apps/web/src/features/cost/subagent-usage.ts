import { emptyConversation, reduceAll } from '@nexus/wire';
import type {
  ThreadHistoryResult,
  WireClient,
  WireSessionStats,
  WireTokenUsage,
} from '@nexus/wire';

/**
 * 背景子代理自己那份日誌的總帳（[#1032](https://github.com/DemianLi/nexus-agent/issues/1032)）。
 *
 * 資料來源是 `subagentHistory` 那一頁帶的兩顆 `custom` frame（`tokenUsage`、`sessionStats`）：harness 對**傳入的那份日誌**
 * 從頭 seed 到這一頁結尾（`conversation-history.ts` 的 `historyPage`），而子代理那條路由傳的就是它自己的日誌
 * （`wire-handler.ts` 的 `handleSubagentHistory`），所以這兩個數字是子代理自己的，跟切頁無關。只要數字，所以一次只問最後 1 則
 * （`maxMessages` 下限是 1）；那一頁的對話內容不用。
 *
 * @module
 */

export interface SubagentUsage {
  /** 子代理自己的 token 總帳；它一次都沒記到帳（或沒有任何一次回報用量）就是 `null`。 */
  readonly tokenUsage: WireTokenUsage | null;
  readonly sessionStats: WireSessionStats | null;
}

/** 讀回來的結果：成功，或一句話講為什麼讀不回來（不畫 0）。 */
export type SubagentUsageOutcome =
  | { readonly ok: true; readonly usage: SubagentUsage }
  | { readonly ok: false; readonly message: string };

/** 讀一個背景子代理的總帳。傳給面板的是身分穩定的函式（`App` 以 `[client, threadId]` 建）。 */
export type SubagentUsageLoader = (runId: string) => Promise<SubagentUsageOutcome>;

/** 一頁歷史裡的總帳：折過那一頁的 frame，取折疊器收到的兩格。 */
export function foldSubagentUsage(result: ThreadHistoryResult): SubagentUsage {
  const state = reduceAll(emptyConversation(), result.events);
  return { tokenUsage: state.tokenUsage, sessionStats: state.sessionStats };
}

export function createSubagentUsageLoader(
  client: WireClient,
  threadId: string,
): SubagentUsageLoader {
  return async (runId) => {
    try {
      const outcome = await client.subagentHistory(threadId, runId, { maxMessages: 1 });
      return outcome.kind === 'ok'
        ? { ok: true, usage: foldSubagentUsage(outcome.result) }
        : { ok: false, message: outcome.message };
    } catch {
      return { ok: false, message: '連線出了問題' };
    }
  };
}
