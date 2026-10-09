import type { WireGoal } from '@nexus/wire';
import { Target } from 'lucide-react';

import { Surface } from '@/components/surface';
import { goalBarView } from '@/lib/goal-bar';

/**
 * 輸入框上方的目標列（[#945](https://github.com/DemianLi/nexus-agent/issues/945)，對應 dsh 的 `GoalBar`）。判斷在
 * `lib/goal-bar.ts`。
 *
 * - **只讀**：這張不做暫停／恢復／編輯／清除。那些的語意綁著 activation，而 activation 還在改（#638、#660、#661）。
 *   建立目標在 `/goal` 斜線命令，不在這條上。
 * - **有目標且沒完成才畫**（`complete` 與沒有目標都不畫）。
 * - **目標內容單行截短**，全文在 `title` 與整列的無障礙名稱。`blocked` 的理由直接顯示在列上。
 * - 不掛 `role="status"`：代理的現況只由狀態列唸（§8），目標每變一次就唸一次太吵。
 */
export function GoalBar({ goal }: { readonly goal: WireGoal | null }) {
  const view = goalBarView(goal);
  if (view === undefined) return null;
  return (
    <Surface
      tone="docked"
      role="group"
      aria-label={view.label}
      data-testid="goal-bar"
      className="text-muted-foreground mb-2 min-w-0 px-3 py-2 text-tip"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Target aria-hidden className="size-4 shrink-0" />
        <span className="shrink-0 font-medium">{view.phase}</span>
        <span className="min-w-0 flex-1 truncate" title={view.objective}>
          {view.objective}
        </span>
        {view.rounds !== undefined && (
          <span className="shrink-0" data-testid="goal-rounds">
            {view.rounds}
          </span>
        )}
      </div>
      {view.blockedReason !== undefined && (
        <p className="mt-1 pl-6" data-testid="goal-blocked-reason">
          {view.blockedReason}
        </p>
      )}
    </Surface>
  );
}
