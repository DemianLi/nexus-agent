import type { ConversationState } from '@nexus/wire';
import { useRef } from 'react';

import { subagentNames } from '@/lib/subagent-view';

/**
 * 背景子代理的名字表（`runId` → 名字）。`entries` 每一格串流都換一個新的，表的內容卻幾乎從不變；內容沒變就回上一份，
 * 列的 `memo` 才擋得住（每次算出新的 `Map` 身分就變，所有列跟著重畫）。觀測分頁（#1033）與成本分頁（#1032）共用。
 */
export function useStableNames(entries: ConversationState['entries']): ReadonlyMap<string, string> {
  const previous = useRef<ReadonlyMap<string, string>>(new Map());
  const next = subagentNames(entries);
  const same =
    next.size === previous.current.size &&
    [...next].every(([runId, name]) => previous.current.get(runId) === name);
  if (!same) previous.current = next;
  return previous.current;
}
