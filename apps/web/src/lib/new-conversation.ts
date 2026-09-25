/**
 * 按「新對話」要去哪一條——[#313](https://github.com/DemianLi/nexus-agent/issues/313)，照 dsh 的
 * `connectWorkspace`（`packages/client/ui-workspace/src/client/navigation.ts`，本地 clone `c291e79`）：
 * **先找一條已經有的空白會話拿來用，沒有才開新的**，開了沒講話的會話就不會越積越多。
 *
 * 「目前這條還是空白就留在原地」不在這裡判，在畫面那一側（`App.tsx`）：清單是冷讀磁碟，還沒落盤的目前這條
 * 根本不在上面，所以那一格要看這個分頁自己的狀態，而且要在讀清單之前判。
 *
 * **和 dsh 不同的幾處**（都是我們的清單表達不出 dsh 的那幾格）：
 *
 * - dsh 要求空白會話 `cwd` 相同、屬於這個 workspace、沒封存。我們沒有 workspace 也沒有封存，而 `GET /threads`
 *   只列這台 server 的 `projectKey(cwd)` 那一格，所以「清單上的」就等於 cwd 相同。
 * - dsh 沒特別挑哪一條，走的是它自己的列表順序。我們照清單順序（由新到舊）拿第一條，不另訂規則。
 *
 * @module
 */

import type { ThreadListResult, WireClient } from '@nexus/wire';

/** 按「新對話」之後要去的地方。 */
export type NewConversationTarget =
  { readonly kind: 'reuse'; readonly threadId: string } | { readonly kind: 'new' };

/**
 * 從清單挑一條空白會話。
 *
 * @param listing - `GET /threads` 的結果；讀不出來是 `undefined`，那就照 #313 以前的做法開新的。
 * @param currentThreadId - 目前這一條。它就算在清單上標著空白也不挑——要留在原地的話畫面那一側已經留了，
 *   走到這裡代表這個分頁在它上面講過話，清單上那個 `blank` 是舊的。
 */
export function newConversationTarget(
  listing: ThreadListResult | undefined,
  currentThreadId: string,
): NewConversationTarget {
  const blank = listing?.items.find((item) => item.blank && item.threadId !== currentThreadId);
  return blank === undefined ? { kind: 'new' } : { kind: 'reuse', threadId: blank.threadId };
}

/**
 * 讀清單。**讀不出來不是錯誤，是退路**：關掉落盤的 server（清單上 `session-persistence` 那一列，#613）一定回 rejected，而「新對話」是停在
 * 核准點的 thread 唯一的出口，不能因為清單讀不到就走不出去。清單讀不出來的原因由「以前的會話」那一格講。
 */
export async function readThreadListing(
  client: Pick<WireClient, 'listThreads'>,
): Promise<ThreadListResult | undefined> {
  try {
    const outcome = await client.listThreads();
    return outcome.kind === 'ok' ? outcome.result : undefined;
  } catch {
    return undefined;
  }
}
