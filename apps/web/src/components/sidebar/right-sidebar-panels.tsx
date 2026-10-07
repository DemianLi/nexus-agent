/**
 * 右側欄的單例面板（觀測、成本）：種類名在 `lib/right-sidebar.ts` 的 `PANEL_KINDS`，這裡是每一種的標題、圖示與內容
 * （[#1031](https://github.com/DemianLi/nexus-agent/issues/1031)，決定在 [#1017](https://github.com/DemianLi/nexus-agent/issues/1017)）。
 *
 * **#1031 只做殼與入口**，內容各自一張卡：觀測分頁是 #1033（`components/trace/panel.tsx`），成本分頁是 #1032
 * （`components/cost/panel.tsx`）。資料來源用**可訂閱的 store**（`sources.conversation`，`useSyncExternalStore`，同 `changes.summary`），
 * 不要把 `ConversationState` 塞進 `RightSidebarSources`：面板每一格串流都會被 App 重畫，而 `RightSidebarPanel` 靠 `memo` 擋掉那些
 * 重畫，`sources` 一變身分就全擋不住。內容只在 `visible` 時訂閱。
 */

import { Activity, Coins } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';

import { CostBody } from '@/components/cost/panel';
import { TraceBody } from '@/components/trace/panel';
import type { PanelKind } from '@/lib/right-sidebar';
import type { PanelBodyProps } from '@/lib/right-sidebar-api';

export interface PanelDefinition {
  /** 分頁上的標題，也是入口鈕的名稱。 */
  readonly title: string;
  readonly Icon: LucideIcon;
  readonly Body: ComponentType<PanelBodyProps>;
}

/** `Record<PanelKind, …>`：`PANEL_KINDS` 加一種而這裡沒補，編不過。 */
export const PANELS: Readonly<Record<PanelKind, PanelDefinition>> = {
  trace: { title: '觀測', Icon: Activity, Body: TraceBody },
  cost: { title: '成本', Icon: Coins, Body: CostBody },
};
