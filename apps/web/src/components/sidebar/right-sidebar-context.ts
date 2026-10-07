/**
 * 右側欄的 context 與卡片用的 `useRightSidebar`。**不 import 任何面板或卡片**：面板（觀測、成本）與卡片都要從這裡取
 * `useRightSidebar`，若它住在 `right-sidebar.tsx`，那個檔又經 `right-sidebar-panels` 載入面板，就成了環（#1127）。
 * 提供者（`RightSidebarProvider`）與畫面留在 `right-sidebar.tsx`。
 */

import { createContext, useContext } from 'react';
import type { RefObject } from 'react';

import type { RightSidebarApi, RightSidebarSources, TurnReveal } from '@/lib/right-sidebar-api';
import type { SidebarLayout } from '@/lib/right-sidebar';

export interface RightSidebarControl {
  readonly api: RightSidebarApi;
  readonly layout: SidebarLayout;
  readonly sources: RightSidebarSources;
  readonly isMobile: boolean;
  readonly width: number;
  /** 標頭的開關鈕：停靠時從面板裡收起，焦點交回這裡。 */
  readonly toggle: RefObject<HTMLButtonElement | null>;
  /** 要把焦點放進去的分頁鍵：分頁列畫出來之後放、放完清掉。 */
  readonly focusTab: RefObject<string | undefined>;
  /** 停靠時收起鈕把焦點交回哪裡；沒有（或已經不在畫面上）就交回標頭的開關鈕。 */
  readonly returnFocus: RefObject<HTMLElement | null>;
  /** 1024 以下定位之後，抽屜關掉時焦點要去的那一格（`locate`）。 */
  readonly locateFocus: RefObject<HTMLElement | null>;
  /** 還沒被觀測分頁消費的「顯示某一輪」請求。 */
  readonly reveal: TurnReveal | undefined;
  settleReveal(nonce: number): void;
  update(change: (layout: SidebarLayout) => SidebarLayout): void;
  setWidth(width: number, commit: boolean): void;
}

export const Control = createContext<RightSidebarControl | undefined>(undefined);

/**
 * 卡片打開分頁用。**沒有右側欄時是 `undefined`**，卡片就不畫那顆鈕：一顆按了沒反應的鈕比不給更糟
 * （同 `download-button.tsx`）。
 */
export function useRightSidebar(): RightSidebarApi | undefined {
  return useContext(Control)?.api;
}

export function useControl(): RightSidebarControl {
  const control = useContext(Control);
  if (control === undefined) throw new Error('右側欄的元件要放在 RightSidebarProvider 裡');
  return control;
}
