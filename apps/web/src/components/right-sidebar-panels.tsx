/**
 * 右側欄的單例面板（觀測、成本）：種類名在 `lib/right-sidebar.ts` 的 `PANEL_KINDS`，這裡是每一種的標題、圖示與內容
 * （[#1031](https://github.com/DemianLi/nexus-agent/issues/1031)，決定在 [#1017](https://github.com/DemianLi/nexus-agent/issues/1017)）。
 *
 * **這張只做殼與入口**：兩個面板的內容還是空的，畫「尚無資料」。成本分頁歸 #1032、觀測分頁歸 #1033，到時各自換掉
 * 下面的 `Body`。資料來源照 #1031 的要求用**可訂閱的 store**（`useSyncExternalStore`，同 `changes.summary`），不要把
 * `ConversationState` 塞進 `RightSidebarSources`：面板每一格串流都會被 App 重畫，而 `RightSidebarPanel` 靠 `memo` 擋掉那些
 * 重畫，`sources` 一變身分就全擋不住。
 */

import { Activity, Coins } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';

import type { PanelKind } from '@/lib/right-sidebar';

/** 面板還沒有資料可畫時那一句。 */
export const PANEL_EMPTY_TEXT = '尚無資料';

function EmptyBody({ kind }: { kind: PanelKind }) {
  return (
    <p
      className="text-muted-foreground flex flex-1 items-center justify-center px-6 text-center text-sm"
      data-testid={`right-sidebar-panel-${kind}`}
    >
      {PANEL_EMPTY_TEXT}
    </p>
  );
}

export interface PanelDefinition {
  /** 分頁上的標題，也是入口鈕的名稱。 */
  readonly title: string;
  readonly Icon: LucideIcon;
  readonly Body: ComponentType;
}

/** `Record<PanelKind, …>`：`PANEL_KINDS` 加一種而這裡沒補，編不過。 */
export const PANELS: Readonly<Record<PanelKind, PanelDefinition>> = {
  trace: { title: '觀測', Icon: Activity, Body: () => <EmptyBody kind="trace" /> },
  cost: { title: '成本', Icon: Coins, Body: () => <EmptyBody kind="cost" /> },
};
