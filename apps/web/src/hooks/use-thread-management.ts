import { useCallback, useMemo, useState } from 'react';

import { threadManagementEnabled, normalizeTitle } from '@/lib/thread-management';
import type { ThreadManagement } from '@/lib/thread-management';

/**
 * 側欄的釘選、封存、改名（#633）。**現在只記在這個分頁**：伺服器端與 `WireClient` 的五支方法還沒接上，所以重新整理就沒了，
 * 開關（`threadManagementEnabled`）也因此是關的。接上之後這裡改成呼叫那五支、以伺服器回的集合為準，介面不變。
 *
 * 沒開時回 `undefined`：側欄看到的跟以前一樣，什麼都不多畫。
 */
export function useThreadManagement(): ThreadManagement | undefined {
  const enabled = threadManagementEnabled();
  const [pinnedIds, setPinnedIds] = useState<readonly string[]>([]);
  const [archivedIds, setArchivedIds] = useState<ReadonlySet<string>>(new Set());
  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(new Map());

  const onPin = useCallback(
    async (threadId: string) => {
      // 封存的不能釘（dsh）；已經釘了再釘不動它的位置（冪等）。
      if (archivedIds.has(threadId)) return '封存的會話不能釘選。';
      setPinnedIds((current) => (current.includes(threadId) ? current : [threadId, ...current]));
      return undefined;
    },
    [archivedIds],
  );
  const onUnpin = useCallback(async (threadId: string) => {
    setPinnedIds((current) => current.filter((id) => id !== threadId));
    return undefined;
  }, []);
  const onArchive = useCallback(async (threadId: string) => {
    setArchivedIds((current) => new Set(current).add(threadId));
    setPinnedIds((current) => current.filter((id) => id !== threadId));
    return undefined;
  }, []);
  const onUnarchive = useCallback(async (threadId: string) => {
    setArchivedIds((current) => {
      const next = new Set(current);
      next.delete(threadId);
      return next;
    });
    return undefined;
  }, []);
  const onRename = useCallback(async (threadId: string, raw: string) => {
    const title = normalizeTitle(raw);
    if (title === undefined) return '標題不能是空的。';
    setTitles((current) => new Map(current).set(threadId, title));
    return undefined;
  }, []);

  return useMemo(
    () =>
      enabled
        ? { pinnedIds, archivedIds, titles, onPin, onUnpin, onArchive, onUnarchive, onRename }
        : undefined,
    [enabled, pinnedIds, archivedIds, titles, onPin, onUnpin, onArchive, onUnarchive, onRename],
  );
}
