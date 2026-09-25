/**
 * 往前翻（inventory 列 9，#306 的畫面那一刀之後補完）：按鈕、自動載入、失敗與報讀。
 *
 * - **放在 `MessageScrollerContent` 外面**：`@shadcn/react` 的 prepend 保位只在「舊的第一個子元素插入後不再排第一」
 *   時動手，按鈕排在 content 裡就永遠是第一個，接上一頁畫面就甩到那一頁的頂端（develop `5a31b02` 實機量過：中間頁
 *   跳 6081px、最後一頁跳 2344px）。放到 viewport 裡、content 上面，第一個子元素就是第一則，最後一頁按鈕消失的那一下
 *   也在同一次補償裡。
 * - **自動載入要有人往上捲的意圖**：捲到頂端附近（{@link EARLIER_EDGE_PX}）而且剛剛有往上的滾輪、手指或按鍵，才換
 *   一頁。「在頂端」本身不算：剛打開、內容比視窗短、程式捲動都會停在那裡。一次意圖只換一頁，換完要再有新的意圖。
 * - **失敗不自動重試**：錯誤畫在按鈕旁邊，按鈕改成「再試一次」，要人按。第一頁讀不到那一行歸 `App` 上方。
 * - **不做骨架**：骨架跟真的內容不一樣高，換掉那一下又要補一次位置；規格 §7 也把載入歷史列在不動的那一類。
 *
 * dsh 也是一顆按鈕、自己記錨點補位置（`ui-chat/src/client/chat/ChatView.tsx` 的 `loadOlderAnchored`，`6b1808f`），
 * 沒有自動載入；UI 以 shadcn 為基底，不必照 dsh（AGENTS.md「技術實現標準」）。
 *
 * @module
 */

import { useCallback, useRef } from 'react';
import type { KeyboardEvent, TouchEvent, UIEvent, WheelEvent } from 'react';

import { Button } from '@/components/ui/button';

export const LOAD_EARLIER_LABEL = '載入更早的對話';
export const LOADING_EARLIER_LABEL = '讀取中…';
export const RETRY_EARLIER_LABEL = '再試一次';

/** 離頂端多近算「到了」。 */
export const EARLIER_EDGE_PX = 240;

/** 往上的意圖多久內還算數：觸控板與慣性捲動會連續送滾輪，平滑捲動的 PageUp 也在這之內捲完。 */
export const EARLIER_INTENT_MS = 1000;

/** 畫面要的那幾格（`useConversation` 的 `HistoryView` 加上動作）。 */
export interface EarlierHistory {
  /** 更早還有看得見的東西。 */
  readonly hasMore: boolean;
  /** 正在拿更早的那一頁。 */
  readonly loading: boolean;
  /** 上一次往前翻拿不到的原因；有的話不自動載入。 */
  readonly error?: string;
  /** 最近一次往前翻接上了幾則（人打的字與模型的回覆各算一則，同 wire 一頁的單位）。 */
  readonly loaded?: number;
  onLoad(): void;
}

/** 讀完時報讀的那一句。 */
export function earlierLoadedNotice(loaded: number | undefined): string {
  if (loaded === undefined) return '';
  return loaded > 0 ? `載入了較早的 ${loaded} 則。` : '載入了更早的對話。';
}

export function EarlierPager({ earlier }: { earlier: EarlierHistory }) {
  const failed = earlier.error !== undefined;
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-1 px-6 pt-4">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={earlier.loading}
        onClick={earlier.onLoad}
      >
        {earlier.loading
          ? LOADING_EARLIER_LABEL
          : failed
            ? RETRY_EARLIER_LABEL
            : LOAD_EARLIER_LABEL}
      </Button>
      {failed && !earlier.loading && (
        <p className="text-destructive text-center text-xs">讀不到更早的對話：{earlier.error}</p>
      )}
    </div>
  );
}

const UPWARD_KEYS = new Set(['ArrowUp', 'PageUp', 'Home']);

/**
 * 掛在 viewport 上的事件：記下往上的意圖，捲到頂端附近時換一頁。
 *
 * 回傳的 handler 只讀 `currentTarget.scrollTop`，所以 jsdom 裡設 `scrollTop` 再送事件就驗得到；位置保不保得住要在
 * 真的瀏覽器裡量。
 */
export function useEarlierAutoLoad(earlier: EarlierHistory | undefined) {
  const latest = useRef(earlier);
  latest.current = earlier;
  const intentAt = useRef(Number.NEGATIVE_INFINITY);
  const touchY = useRef<number | undefined>(undefined);

  const check = useCallback((viewport: HTMLElement) => {
    const current = latest.current;
    if (current === undefined || !current.hasMore || current.loading) return;
    if (current.error !== undefined) return;
    if (performance.now() - intentAt.current > EARLIER_INTENT_MS) return;
    if (viewport.scrollTop > EARLIER_EDGE_PX) return;
    intentAt.current = Number.NEGATIVE_INFINITY;
    current.onLoad();
  }, []);

  const upward = useCallback(
    (viewport: HTMLElement) => {
      intentAt.current = performance.now();
      check(viewport);
    },
    [check],
  );

  return {
    onWheel: (event: WheelEvent<HTMLDivElement>) => {
      if (event.deltaY < 0) upward(event.currentTarget);
      else intentAt.current = Number.NEGATIVE_INFINITY;
    },
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      if (UPWARD_KEYS.has(event.key) || (event.key === ' ' && event.shiftKey)) {
        upward(event.currentTarget);
      }
    },
    onTouchStart: (event: TouchEvent<HTMLDivElement>) => {
      touchY.current = event.touches[0]?.clientY;
    },
    onTouchMove: (event: TouchEvent<HTMLDivElement>) => {
      const y = event.touches[0]?.clientY;
      // 手指往下拖＝內容往上捲。
      if (y !== undefined && touchY.current !== undefined && y > touchY.current) {
        upward(event.currentTarget);
      }
      touchY.current = y;
    },
    onScroll: (event: UIEvent<HTMLDivElement>) => check(event.currentTarget),
  };
}
