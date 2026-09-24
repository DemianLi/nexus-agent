import type { WireSessionStats, WireTokenUsage } from '@nexus/wire';
import { Coins } from 'lucide-react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { sessionUsageView } from '@/lib/session-usage-view';

function Rows({ rows }: { rows: readonly (readonly [string, string])[] }) {
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 tabular-nums">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="text-right">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * 頂列右邊那顆「這條對話的用量」（[#574](https://github.com/DemianLi/nexus-agent/issues/574) 決定 3、4）：收著顯示
 * 總量，點開分「這條對話累計」與「時間」兩段。畫什麼、什麼時候不畫在 `lib/session-usage-view.ts`。
 *
 * - **popover，不是 tooltip**：手機上沒有 hover（同用量表）。
 * - **不掛 `role="status"`**：全站的 live region 只有狀態列一個，每次模型呼叫都唸一次太吵（同用量表）。
 * - 頂列不會被核准或提問面板換掉，所以不用像用量表那樣在 `hidden` 時自己關。
 */
export function SessionUsage({
  tokenUsage,
  sessionStats,
}: {
  readonly tokenUsage: WireTokenUsage | null;
  readonly sessionStats: WireSessionStats | null;
}) {
  const view = sessionUsageView(tokenUsage, sessionStats);
  if (view === null) return null;
  const { usage, time } = view;
  return (
    <Popover>
      <PopoverTrigger
        aria-label={view.ariaLabel}
        data-testid="session-usage"
        className="hover:bg-chip-hover active:bg-chip-pressed text-muted-foreground flex h-11 shrink-0 items-center gap-1.5 rounded-full px-2 text-xs tabular-nums transition-colors duration-(--duration-quick) lg:h-9"
      >
        <Coins aria-hidden className="size-4" />
        {view.label}
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        aria-label="這條對話的用量明細"
        className="w-72 space-y-3 text-sm"
      >
        {usage !== undefined && (
          <section className="space-y-1.5" data-testid="session-usage-tokens">
            <div className="flex items-baseline justify-between">
              <p className="text-muted-foreground text-xs">這條對話累計</p>
              <p className="font-medium tabular-nums">{usage.total}</p>
            </div>
            <Rows
              rows={[
                ['輸入', usage.input],
                ['輸出', usage.output],
              ]}
            />
            <p className="text-muted-foreground text-xs">
              每一次模型呼叫的帳加起來，所以比「目前大小」大很多。不含子代理與自動摘要那幾次。
            </p>
          </section>
        )}
        {usage !== undefined && time !== undefined && <hr className="border-border" />}
        {time !== undefined && (
          <section className="space-y-1.5" data-testid="session-usage-time">
            <p className="text-muted-foreground text-xs">時間</p>
            <Rows
              rows={[
                ['輪／模型呼叫', time.counts],
                ...(time.llm !== undefined ? [['模型時間', time.llm] as const] : []),
                ...(time.tool !== undefined ? [['工具時間', time.tool] as const] : []),
              ]}
            />
          </section>
        )}
      </PopoverContent>
    </Popover>
  );
}
