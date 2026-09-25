import type { ReactNode } from 'react';

import { RightSidebarPanel, RightSidebarProvider } from '@/components/right-sidebar';
import type { RightSidebarSources } from '@/components/right-sidebar';

/**
 * 卡片連同右側欄一起畫（#640）：卡片的鈕打開的分頁畫在同一棵樹裡，測試照樣找得到。
 *
 * jsdom 沒有 `matchMedia`，`useIsMobile` 當成桌面，所以這裡畫的是**停靠**那一種；覆蓋那一種要自己 stub
 * `matchMedia`（見 `right-sidebar.test.tsx`）。
 */
export function WithRightSidebar({
  sources,
  threadId = 't',
  children,
}: {
  sources: RightSidebarSources;
  threadId?: string;
  children: ReactNode;
}) {
  return (
    <RightSidebarProvider threadId={threadId} sources={sources}>
      {children}
      <RightSidebarPanel />
    </RightSidebarProvider>
  );
}

/** 一份記憶體裡的 `Storage`：Node 25 自帶的那一份蓋住了 jsdom 的，連 `getItem` 都沒有。 */
export function memoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => void entries.delete(key),
    setItem: (key, value) => void entries.set(key, String(value)),
  };
}
