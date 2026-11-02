import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';

interface Subscribable<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

const noSubscribe = () => () => {};

/**
 * 只在**看得見**時訂閱一個 store（[#1033](https://github.com/DemianLi/nexus-agent/issues/1033)）。
 *
 * 右側欄的分頁藏起來時不卸載（保住捲動位置與展開狀態），所以光靠「沒人看」擋不住：訂閱著的話，串流的每一格仍會讓它重畫。
 * 這裡看不見時換成空訂閱、快照凍在最後一次看見的那一份，store 怎麼變都不重畫；再看見時直接取當下那一份。
 *
 * 從沒看見過就回 `undefined`（分頁以「選中過才掛上」為準，所以通常不會發生；先藏著載入的版面可能碰到）。
 */
export function useVisibleSnapshot<T>(
  source: Subscribable<T> | undefined,
  visible: boolean,
): T | undefined {
  const last = useRef<T | undefined>(undefined);
  const live = visible && source !== undefined;
  const snapshot = useSyncExternalStore<T | undefined>(
    live ? source.subscribe : noSubscribe,
    live ? source.getSnapshot : () => last.current,
  );
  useLayoutEffect(() => {
    if (live) last.current = snapshot;
  });
  return snapshot;
}
