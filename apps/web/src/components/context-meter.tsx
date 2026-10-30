import type { WireContextPressure } from '@nexus/wire';

import { ContextRing } from '@/components/ui/context-ring';
import { PopoverTitle } from '@/components/ui/popover';
import {
  DORMANT_ROW_TEXT,
  contextMeterLabel,
  contextMeterView,
  percentText,
} from '@/lib/context-meter-view';

/**
 * 輸入框底列右邊的用量環（[#528](https://github.com/DemianLi/nexus-agent/issues/528) 的 Q3、Q5、Q6；#1591 換成 SG 的
 * `ContextRing`）：這條對話離自動摘要還有多遠。算法在 `lib/context-meter-view.ts`。
 *
 * - **收著只剩一個環**（SG 的樣子），量的是最近的那道門檻。弧長只用來畫：`used = percent`、`window = 100`，所以弧長照
 *   nexus 無條件捨去的百分比走，SG 的 `Math.round` 不會出現在任何字或報讀裡。
 * - **色階照 SG**：70% 琥珀、90% destructive（#1468 Q8）。SG 寫死的顏色在覆寫檔壓回 status token（README 本地修改第 37 條）。
 *   弧長的 500ms transition 在減少動態時直接跳到新值（第 38 條）。
 * - **點開是 popover**：手機上沒有 hover。明細整段是 nexus 的（patch `0008` 的 `children`）：「目前大小」是供應商報的實數，
 *   「距離自動摘要」是估算，每道門檻各一行，最近那一行加粗。有 `breakdown` 時多「組成」三行（#1571 N1193）。
 * - **報讀**：按鈕名稱是「對話用量：約 N%，點開看明細」（`0008` 的 `label`）。不掛 `role="status"`：代理的現況只由狀態列唸
 *   （§8），每次模型呼叫都唸一次太吵。最近那一行不只靠粗體，另有一句給報讀的「（最近）」。明細的名稱是標題那一行
 *   （Base UI 的 `Popover.Title` 自己接上 `aria-labelledby`）。
 * - **不會觸發的門檻**（#1444）：那一行照列「N／60 則」，用次要色，下面多一行小字說它目前不會觸發；不用刪除線（看起來像被
 *   刪掉）。報讀時兩句一起唸。底下那句跟著改說法（`note`）。
 * - **`hidden` 時不畫**：輸入框被核准或提問面板換掉時只是藏起來、不卸載，而明細 portal 在 body 上；SG 的 Popover 不受控，
 *   不畫就順便關掉了，不必再加 patch。
 */
export function ContextMeter({
  pressure,
  hidden = false,
}: {
  readonly pressure: WireContextPressure | null;
  /** 輸入框現在被換掉了。 */
  readonly hidden?: boolean;
}) {
  const view = contextMeterView(pressure);
  if (view === null || hidden) return null;
  return (
    <span data-slot="context-meter" data-testid="context-meter">
      <ContextRing used={view.percent} window={100} label={contextMeterLabel(view)}>
        <div className="flex items-baseline gap-2 text-ui">
          <PopoverTitle className="text-muted-foreground mr-auto text-ui font-normal">
            對話用量
          </PopoverTitle>
          <span className="tabular-nums" data-testid="context-meter-percent">
            {percentText(view)}
          </span>
        </div>
        {view.inputTokens !== undefined && (
          <div className="text-tip">
            <p className="text-muted-foreground">目前大小</p>
            <p className="tabular-nums" data-testid="context-meter-input">
              {view.inputTokens}
            </p>
          </div>
        )}
        {view.breakdown !== undefined && (
          <div className="text-tip" data-testid="context-meter-breakdown">
            <p className="text-muted-foreground">組成</p>
            <ul>
              {view.breakdown.map((row) => (
                <li
                  key={row.part}
                  data-testid="context-meter-part"
                  data-part={row.part}
                  className="flex justify-between gap-3 tabular-nums"
                >
                  <span className="text-muted-foreground">{row.label}</span>
                  <span>{row.text}</span>
                </li>
              ))}
            </ul>
            {view.breakdownNote !== undefined && (
              <p
                className="text-muted-foreground leading-relaxed"
                data-testid="context-meter-breakdown-note"
              >
                {view.breakdownNote}
              </p>
            )}
          </div>
        )}
        <div className="text-tip">
          <p className="text-muted-foreground">距離自動摘要</p>
          <ul>
            {view.rows.map((row, index) => (
              <li
                key={index}
                data-testid="context-meter-row"
                data-nearest={row.nearest}
                data-dormant={row.dormant}
                className={`tabular-nums ${row.nearest ? 'font-medium' : 'text-muted-foreground'}`}
              >
                {row.text}
                {row.nearest && <span className="sr-only">（最近）</span>}
                {row.dormant && (
                  <>
                    <span className="sr-only">，</span>
                    <span className="block text-tip" data-testid="context-meter-dormant">
                      {DORMANT_ROW_TEXT}
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
        <p
          className="text-muted-foreground text-tip leading-relaxed"
          data-testid="context-meter-note"
        >
          {view.note}
        </p>
      </ContextRing>
    </span>
  );
}
