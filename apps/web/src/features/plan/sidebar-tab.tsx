import { ScrollText } from 'lucide-react';
import { useCallback } from 'react';

import { useControl } from '@/shared/right-sidebar/context';
import { defineTab } from '@/shared/right-sidebar/tab';
import type { TabBodyProps } from '@/shared/right-sidebar/tab';

import { REVIEW_PLAN_ID_PREFIX } from './review-view';
import { PlanTab } from './tab';

/** 計劃分頁的座標：一份計劃一個分頁。 */
export type PlanSidebarTab = {
  readonly kind: 'plan';
  /** 交出這份計劃的那次工具呼叫 id（#654）；審核請求沒帶的話是 `review:<interruptId>`。 */
  readonly id: string;
  /**
   * 知道過的計劃標題（#2014）。標籤先讀計劃庫，沒有才用它，所以重新整理後沒選過、還沒掃的分頁也寫得出標題。工具呼叫的
   * 參數不會變，記下來的不會過期。`review:` 的不記：
   * 它不在日誌裡，中斷結束後就找不到了（{@link planTab}）。
   */
  readonly title?: string;
};

/** 計劃分頁；`review:` 的不帶標題（見 `title`）。 */
export function planTab(id: string, title: string | undefined): PlanSidebarTab {
  return title === undefined || id.startsWith(REVIEW_PLAN_ID_PREFIX)
    ? { kind: 'plan', id }
    : { kind: 'plan', id, title };
}

/** 記下或清掉標題（`undefined` 是清掉）；沒變或是 `review:` 的時候回傳同一個參考。 */
function withTitle(current: PlanSidebarTab, title: string | undefined): PlanSidebarTab {
  const next = planTab(current.id, title);
  return next.title === current.title ? current : next;
}

function PlanBody({ tab, refine }: TabBodyProps<PlanSidebarTab>) {
  const noteTitle = useCallback(
    (title: string | undefined) => refine((current) => withTitle(current, title)),
    [refine],
  );
  return <PlanTab id={tab.id} noteTitle={noteTitle} />;
}

function usePlanTabTitle(tab: PlanSidebarTab) {
  const { sources } = useControl();
  const title = sources.plans?.get(tab.id)?.title ?? tab.title ?? '計劃';
  return { label: title, detail: title };
}

export const PLAN_TAB = defineTab<PlanSidebarTab>({
  kind: 'plan',
  key: (tab) => `plan:${tab.id}`,
  parse: (raw) => {
    if (typeof raw.id !== 'string' || raw.id === '') return undefined;
    if (raw.title !== undefined && typeof raw.title !== 'string') return undefined;
    return planTab(raw.id, raw.title);
  },
  useTitle: usePlanTabTitle,
  Icon: ScrollText,
  Body: PlanBody,
});
