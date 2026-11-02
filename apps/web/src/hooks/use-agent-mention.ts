import type { WireClient } from '@nexus/wire';
import { useCallback, useMemo } from 'react';

import { useOpenRead } from '@/hooks/use-open-read';
import { agentsFromKinds } from '@/lib/agent-mention';
import type { MentionAgent } from '@/lib/agent-mention';

/**
 * 可以點名派的子代理清單（[#328](https://github.com/DemianLi/nexus-agent/issues/328) 第 2 項）。回 `null` 就是這一檔
 * 沒有 `@子代理`——還在讀、伺服器回 `rejected`（含還沒實作的 `not_supported`）或讀的時候拋錯，**一律不出現**：選單沒有「委派給」、
 * 輸入框沒有標記，跟模型座同一個做法（`use-model-seat.ts`）。清單是空的時有功能但沒有可選的列：選單照常開不起來。
 *
 * 清單是這個組裝的靜態事實（註冊的那幾份），在這條 thread 打開時讀一次（換 thread 整個畫面重掛）；暫時讀不到的話，下行下一次接上時再讀（#1483）。
 */
export function useAgentMention(
  client: Pick<WireClient, 'subagentList'>,
  threadId: string,
  connections: number,
): readonly MentionAgent[] | null {
  // 暫時讀不到的話，下行下一次接上再讀（#1483，見 `useOpenRead`）。
  const readList = useCallback(() => client.subagentList(threadId), [client, threadId]);
  const listResult = useOpenRead(readList, connections);
  return useMemo(
    () => (listResult?.ok === true ? agentsFromKinds(listResult.value.subagents) : null),
    [listResult],
  );
}
