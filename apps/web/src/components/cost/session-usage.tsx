import type { WireSessionStats, WireTokenUsage } from '@nexus/wire';
import { ChevronRight, Coins } from 'lucide-react';
import { useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { useRightSidebar } from '@/components/sidebar/right-sidebar-context';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Rows } from '@/components/cost/usage-rows';
import { sessionUsageView } from '@/lib/session-usage-view';

/**
 * 頂列右邊那顆「這條對話的用量」（[#574](https://github.com/DemianLi/nexus-agent/issues/574) 決定 3、4）：收著顯示
 * 總量，點開分「這條對話累計」與「時間」兩段。畫什麼、什麼時候不畫在 `lib/session-usage-view.ts`。
 *
 * - **popover，不是 tooltip**：手機上沒有 hover（同用量表）。
 * - **不掛 `role="status"`**：代理的現況只由狀態列唸（§8），每次模型呼叫都唸一次太吵（同用量表）。
 * - 頂列不會被核准或提問面板換掉，所以不用像用量表那樣在 `hidden` 時自己關。
 * - **底部「看明細」**（#1031，#1017 Q3 ②）：打開右側欄的成本分頁。沒有右側欄時不畫（同卡片的慣例）。按下去先關 popover，
 *   而 Radix 關閉時會把焦點還給觸發鈕——那會蓋掉分頁要拿的焦點，所以這一次不還。
 */
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
  const { usage, time } = view;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={view.ariaLabel}
        data-testid="session-usage"
        className="hover:bg-chip-hover active:bg-chip-pressed text-muted-foreground flex h-11 shrink-0 items-center gap-1.5 rounded-full px-2 text-ui tabular-nums transition-colors duration-(--duration-quick) lg:h-9"
      >
        <Coins aria-hidden className="size-4" />
        {view.label}
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        aria-label="這條對話的用量明細"
        className="w-72 space-y-3 text-body"
        onCloseAutoFocus={(event) => {
          if (!toCost.current) return;
          toCost.current = false;
          event.preventDefault();
        }}
      >
        {usage !== undefined && (
          <section className="space-y-1.5" data-testid="session-usage-tokens">
            <div className="flex items-baseline justify-between">
              <p className="text-muted-foreground text-tip">這條對話累計</p>
              <p className="font-medium tabular-nums">{usage.total}</p>
            </div>
            <Rows
              rows={[
                ['輸入', usage.input],
                ['快取讀', usage.cacheRead],
                ['快取寫', usage.cacheWrite],
                ['輸出', usage.output],
              ]}
            />
            <p className="text-muted-foreground text-tip">{usage.cacheNote}</p>
            <p className="text-muted-foreground text-tip">
              每一次模型呼叫的帳加起來，所以比「目前大小」大很多。不含子代理與自動摘要那幾次。
            </p>
          </section>
        )}
        {usage !== undefined && time !== undefined && <hr className="border-border" />}
        {time !== undefined && (
          <section className="space-y-1.5" data-testid="session-usage-time">
            <p className="text-muted-foreground text-tip">時間</p>
            <Rows
              rows={[
                ['輪／模型呼叫', time.counts],
                ...(time.llm !== undefined ? [['模型時間', time.llm] as const] : []),
                ...(time.tool !== undefined ? [['工具時間', time.tool] as const] : []),
              ]}
            />
          </section>
        )}
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
            看明細
            <ChevronRight aria-hidden />
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
