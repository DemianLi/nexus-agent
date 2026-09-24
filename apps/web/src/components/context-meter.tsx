import type { WireContextPressure } from '@nexus/wire';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { contextMeterLabel, contextMeterView, percentText } from '@/lib/context-meter-view';

/** 環的半徑：畫在 16×16 的 viewBox 裡，線寬 2。 */
const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * 輸入框底列的用量表（[#528](https://github.com/DemianLi/nexus-agent/issues/528) 的 Q3、Q5、Q6）：這條對話離自動
 * 摘要還有多遠。算法在 `lib/context-meter-view.ts`。
 *
 * - **收著**：一個小環加「約 N%」，放在「Enter 送出」旁邊。環量的是最近的那道門檻。
 * - **點開是 popover，不是 tooltip**：手機上沒有 hover。明細兩種來源分開寫：「目前大小」是供應商報的實數，
 *   「距離自動摘要」是估算，每道門檻各一行，最近那一行加粗。
 * - **80% 以上變警示色**，不另外閃。環的弧長變化走「進度」（`motion-progress`，§7），減少動態時直接跳到新值。
 * - **報讀**：按鈕名稱是「對話用量：約 N%，點開看明細」。不掛 `role="status"`：全站的 live region 只有狀態列一個，
 *   每次模型呼叫都唸一次太吵。最近那一行不只靠粗體，另有一句給報讀的「（最近）」。
 * - **`hidden` 時自己關掉**：輸入框被核准或提問面板換掉時只是藏起來、不卸載，而明細 portal 在 body 上——不關的話，
 *   按鈕不見了，明細還浮在面板上面。
 */
export function ContextMeter({
  pressure,
  hidden = false,
  extra,
}: {
  readonly pressure: WireContextPressure | null;
  /** 輸入框現在被換掉了。 */
  readonly hidden?: boolean;
  /** PROTOTYPE #574 變體 B：明細底下多接的段落。 */
  readonly extra?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (hidden && open) setOpen(false);
  const view = contextMeterView(pressure);
  if (view === null) return null;
  const tone = view.warning ? 'text-warning' : 'text-muted-foreground';
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={contextMeterLabel(view)}
        data-testid="context-meter"
        data-warning={view.warning}
        className={`hover:bg-chip-hover active:bg-chip-pressed flex h-11 shrink-0 items-center gap-1.5 rounded-full px-2 text-xs tabular-nums transition-colors duration-(--duration-quick) lg:h-9 ${tone}`}
      >
        <svg aria-hidden viewBox="0 0 16 16" className="size-4 -rotate-90">
          <circle cx="8" cy="8" r={RADIUS} fill="none" strokeWidth="2" className="stroke-border" />
          <circle
            cx="8"
            cy="8"
            r={RADIUS}
            fill="none"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - view.ratio)}
            className="motion-progress stroke-current"
            data-testid="context-meter-arc"
          />
        </svg>
        {percentText(view)}
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        aria-label="對話用量明細"
        className={`${extra === undefined ? 'w-64' : 'w-72'} space-y-3 text-sm`}
      >
        {view.inputTokens !== undefined && (
          <div>
            <p className="text-muted-foreground text-xs">目前大小</p>
            <p className="tabular-nums" data-testid="context-meter-input">
              {view.inputTokens}
            </p>
          </div>
        )}
        <div>
          <p className="text-muted-foreground text-xs">距離自動摘要</p>
          <ul>
            {view.rows.map((row, index) => (
              <li
                key={index}
                data-testid="context-meter-row"
                data-nearest={row.nearest}
                className={`tabular-nums ${row.nearest ? 'font-medium' : 'text-muted-foreground'}`}
              >
                {row.text}
                {row.nearest && <span className="sr-only">（最近）</span>}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-muted-foreground text-xs">
          到了任何一道門檻，較早的訊息會被摘要成一段。比例是估算的。
        </p>
        {extra}
      </PopoverContent>
    </Popover>
  );
}
