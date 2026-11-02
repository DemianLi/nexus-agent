import { useEffect } from 'react';

import type { ConversationState } from '@nexus/wire';

import { prefetchAnchors, staleAnchors } from '@/lib/trajectory-pull';
import type { TrajectoryPuller } from '@/lib/trajectory-pull';
import { trajectoryOf } from '@/lib/trajectory-view';

/** 推送的軌跡往前走之後，等多久才重拉那些「還會變」的輪：同一輪的變動一連串進來，不必每一格都問。 */
export const STALE_REFRESH_MS = 1000;
/** 一次最多重拉幾個邏輯輪。 */
export const STALE_REFRESH_MAX = 3;

/**
 * 軌跡細節的預拉與重拉（[#1083](https://github.com/DemianLi/nexus-agent/issues/1083)），**只在觀測分頁看得見時**做：
 *
 * - 把推送窗口裡已定案的輪收進快取（`seed`），窗口往前滑、它變成摘要時不必再問；
 * - 窗口前面最近兩個邏輯輪、與窗口第一輪若是 `resume` 它接著的那一輪，預先拉回來，所以最近的幾輪看起來一直是完整的；
 * - 拉過但還會變的輪（有還在跑的工具、還沒有結局的核准）在推送的 view 往前走之後去抖重拉：它們的變動（遲到的結果、後面 resume
 *   輪才落日誌的結局）不會讓推送的摘要變動，只有重拉等得到。
 *
 * 軌跡投影不可用（沒有、拋過、版本不認得）就清掉快取：拉回來的沒有版本欄位，不能在閘門之外單獨信。
 * 失敗過的錨點不自動重試（人在畫面上按「重試」）；`not_supported` 之後一個都不再排。
 */
export function useTrajectoryPull(
  puller: TrajectoryPuller | undefined,
  state: ConversationState | undefined,
  visible: boolean,
): void {
  const view = state === undefined ? undefined : trajectoryOf(state);
  useEffect(() => {
    if (!visible || puller === undefined) return;
    if (view === undefined) {
      puller.reset();
      return;
    }
    puller.seed(view.turns);
    for (const anchor of prefetchAnchors(view, puller.getSnapshot())) void puller.pull(anchor);
    const timer = setTimeout(() => {
      const stale = staleAnchors(view, puller.getSnapshot());
      for (const anchor of stale.slice(0, STALE_REFRESH_MAX)) void puller.pull(anchor);
    }, STALE_REFRESH_MS);
    return () => clearTimeout(timer);
  }, [puller, view, visible]);
}
