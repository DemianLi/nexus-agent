import type { WireQueuedInput } from '@nexus/wire';
import { useEffect, useRef, useState } from 'react';

import { QUEUE_LEAVE_MS, QUEUE_SETTLE_MS } from '@/lib/queue-view';

/** 畫面上的一列：`leaving` 是已經不在清單裡、正在淡出的那一件。 */
export interface QueueRow {
  readonly item: WireQueuedInput;
  readonly leaving: boolean;
}

/**
 * 送出佇列哪幾件要畫（[#645](https://github.com/DemianLi/nexus-agent/issues/645) 的 Q5、Q8）。
 *
 * - **新的一件撐過 {@link QUEUE_SETTLE_MS} 才畫**：閒著時送出，伺服器先推「排著一件」、緊接著推「領走」，不壓的話
 *   佇列會閃出一列又消失。這段延遲同時當成出現的動效，**`prefers-reduced-motion` 時照留**——它是為了不閃，不是為了
 *   好看。
 * - **已經畫出來的，改與刪立刻反映**：文字跟著清單換；不在清單裡的轉成 `leaving`，{@link QUEUE_LEAVE_MS} 後拿掉。
 * - **以 id 為鍵**：同一件改了文字不重算延遲、不重播進場。
 * - 清單的順序照伺服器的；淡出中的那一件留在它原本的位置。
 */
export function useSettledQueue(items: readonly WireQueuedInput[]): readonly QueueRow[] {
  const settled = useRef(new Set<string>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const latest = useRef(items);
  latest.current = items;
  const [rows, setRows] = useState<readonly QueueRow[]>([]);
  const shown = useRef<readonly QueueRow[]>([]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const present = new Set(items.map((item) => item.id));
    for (const item of items) {
      if (settled.current.has(item.id) || timers.current.has(item.id)) continue;
      timers.current.set(
        item.id,
        setTimeout(() => {
          timers.current.delete(item.id);
          if (latest.current.some((current) => current.id === item.id)) {
            settled.current.add(item.id);
            setTick((value) => value + 1);
          }
        }, QUEUE_SETTLE_MS),
      );
    }
    // 還沒畫出來就不在了：計時器收掉，一次都不畫。
    for (const [id, timer] of timers.current) {
      if (id.startsWith('leave:') || present.has(id) || settled.current.has(id)) continue;
      clearTimeout(timer);
      timers.current.delete(id);
    }
    const next: QueueRow[] = items
      .filter((item) => settled.current.has(item.id))
      .map((item) => ({ item, leaving: false }));
    shown.current.forEach((row, index) => {
      const id = row.item.id;
      if (present.has(id) || !settled.current.has(id)) return;
      next.splice(Math.min(index, next.length), 0, { item: row.item, leaving: true });
      if (timers.current.has(`leave:${id}`)) return;
      timers.current.set(
        `leave:${id}`,
        setTimeout(() => {
          timers.current.delete(`leave:${id}`);
          if (latest.current.some((current) => current.id === id)) return;
          settled.current.delete(id);
          setTick((value) => value + 1);
        }, QUEUE_LEAVE_MS),
      );
    });
    shown.current = next;
    setRows(next);
  }, [items, tick]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  return rows;
}
