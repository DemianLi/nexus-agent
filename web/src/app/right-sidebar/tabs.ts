/**
 * 右側欄有哪些分頁：每個切片登記自己的定義，這裡把它們列成一張清單。**順序就是空狀態裡入口鈕的順序**（觀測、成本）。
 * 殼（`right-sidebar.tsx`）與版面的讀寫（`shared/right-sidebar/layout.ts`）只查這張清單，不認得任何一種分頁。
 */

import { CHANGES_TAB } from '@/features/changes';
import { COST_TAB } from '@/features/cost';
import { DELIVERABLE_TAB } from '@/features/deliverable';
import { PLAN_TAB } from '@/features/plan';
import { TRACE_TAB } from '@/features/trace';
import { createLayoutOps } from '@/shared/right-sidebar/layout';
import { createTabRegistry } from '@/shared/right-sidebar/tab';

export const TAB_DEFINITIONS = [CHANGES_TAB, DELIVERABLE_TAB, PLAN_TAB, TRACE_TAB, COST_TAB];

export const TAB_REGISTRY = createTabRegistry(TAB_DEFINITIONS);

export const layoutOps = createLayoutOps(TAB_REGISTRY);
