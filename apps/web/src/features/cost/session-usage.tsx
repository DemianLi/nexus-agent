import type { WireSessionStats, WireTokenUsage } from '@nexus/wire';
import { ChevronRight, Coins } from 'lucide-react';
import { useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { useRightSidebar } from '@/shared/right-sidebar/context';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { sessionUsageView } from '@/shared/lib/usage-view';

/**
 * 頂列右邊那顆「這條對話的用量」（[#574](https://github.com/DemianLi/nexus-agent/issues/574) 決定 3、4）：收著顯示
 * 總量，點開只有精確總數與成本分頁的入口；逐項明細只由成本分頁負責。畫什麼、什麼時候不畫在 `shared/lib/usage-view.ts`。
 *
 * - **popover，不是 tooltip**：手機上沒有 hover（同用量表）。
 * - **不掛 `role="status"`**：代理的現況只由狀態列唸（§8），每次模型呼叫都唸一次太吵（同用量表）。
 * - 頂列不會被核准或提問面板換掉，所以不用像用量表那樣在 `hidden` 時自己關。
 * - **底部「到成本分頁」**（#1031，#1017 Q3 ②）：打開右側欄的成本分頁。沒有右側欄時不畫（同卡片的慣例）。按下去先關 popover，
 *   這一次明寫不還焦點（`finalFocus` 回 `false`），焦點留給成本分頁；其餘關法照常還給觸發鈕。
 */
export const SESSION_USAGE_DETAIL_LABEL = '到成本分頁';

export function SessionUsage({
  tokenUsage,
  sessionStats,
}: {
  readonly tokenUsage: WireTokenUsage | null;
  readonly sessionStats: WireSessionStats | null;
}) {
  const view = sessionUsageView(tokenUsage, sessionStats);
  const sidebar = useRightSidebar();
  const [open, setOpen] = useState(false);
  const toCost = useRef(false);
  if (view === null) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={view.ariaLabel}
        data-testid="session-usage"
        className="hover:bg-muted hover:text-foreground text-muted-foreground flex h-11 shrink-0 items-center gap-1.5 rounded-4xl px-2 text-ui tabular-nums transition-colors duration-150 lg:h-9"
      >
        <Coins aria-hidden className="size-4" />
        {view.label}
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        aria-label="這條對話的用量明細"
        className="w-72 space-y-2 text-body"
        finalFocus={() => {
          if (!toCost.current) return true;
          toCost.current = false;
          return false;
        }}
      >
        <div className="flex items-baseline justify-between" data-testid="session-usage-total">
          <p className="text-muted-foreground text-tip">累計</p>
          <p className="font-medium tabular-nums">{view.total ?? view.label}</p>
        </div>
        {sidebar !== undefined && (
          <Button
            type="button"
            variant="ghost"
            className="h-11 w-full justify-between lg:h-9"
            data-testid="session-usage-detail"
            onClick={(event) => {
              toCost.current = true;
              setOpen(false);
              sidebar.openPanel('cost', event.currentTarget);
            }}
          >
            {SESSION_USAGE_DETAIL_LABEL}
            <ChevronRight aria-hidden />
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
