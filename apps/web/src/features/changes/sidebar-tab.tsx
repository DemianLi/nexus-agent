// 這個切片要右側欄帶給它的資料來源，在這裡補進 `RightSidebarSources`（`app/App.tsx` 組出來）。

import { FileDiff } from 'lucide-react';
import { useEffect, useSyncExternalStore } from 'react';

import { basename } from '@/features/deliverable';
import { useControl } from '@/shared/right-sidebar/context';
import { defineTab, isIndex } from '@/shared/right-sidebar/tab';
import type { TabBodyProps } from '@/shared/right-sidebar/tab';

import { ChangesReviewTab } from './review';
import type { ChangesStores } from './diff';

/** 改動分頁的座標：一輪一個分頁，同一輪換檔只改 `index`。 */
export type ChangesSidebarTab = {
  readonly kind: 'changes';
  /** 那一輪改動摘要的日誌位置。 */
  readonly seq: number;
  /** 正在看的檔在摘要 `files` 裡的位置。 */
  readonly index: number;
};

export function changesTab(seq: number, index: number): ChangesSidebarTab {
  return { kind: 'changes', seq, index };
}

/** 改動分頁的標題：光靠摘要算得出來，不需要輪次（#640 決定 11）。 */
export function changesTabTitle(
  summary: { files: readonly { display: string }[]; total: number } | undefined,
): { label: string; detail: string | undefined } {
  const first = summary?.files[0];
  if (summary === undefined || first === undefined) return { label: '改動', detail: undefined };
  const name = basename(first.display);
  const label = summary.total > 1 ? `改動 · ${name} 等 ${summary.total} 個` : `改動 · ${name}`;
  const unlisted = summary.total - summary.files.length;
  const detail = [
    ...summary.files.map((file) => file.display),
    ...(unlisted > 0 ? [`另有 ${unlisted} 個檔沒有列出`] : []),
  ].join('\n');
  return { label, detail };
}

const noSubscribe = () => () => {};

function useChangesTabTitle(tab: ChangesSidebarTab) {
  const store = useControl().sources.changes?.summary;
  const { seq } = tab;
  const summary = useSyncExternalStore(store?.subscribe ?? noSubscribe, () =>
    store === undefined ? undefined : store.read(seq),
  );
  useEffect(() => {
    if (store !== undefined) store.load(seq);
  }, [store, seq]);
  return changesTabTitle(typeof summary === 'object' ? summary : undefined);
}

function ChangesBody({ tab, replace }: TabBodyProps<ChangesSidebarTab>) {
  const { changes } = useControl().sources;
  return changes === undefined ? null : (
    <ChangesReviewTab
      seq={tab.seq}
      index={tab.index}
      changes={changes}
      onSelect={(index) => replace((current) => ({ ...current, index }))}
    />
  );
}

export const CHANGES_TAB = defineTab<ChangesSidebarTab>({
  kind: 'changes',
  key: (tab) => `changes:${tab.seq}`,
  parse: (raw) =>
    isIndex(raw.seq) && isIndex(raw.index) ? changesTab(raw.seq, raw.index) : undefined,
  useTitle: useChangesTabTitle,
  Icon: FileDiff,
  Body: ChangesBody,
});

declare module '@/shared/right-sidebar/api' {
  interface RightSidebarSources {
    readonly changes?: ChangesStores | undefined;
  }
}
