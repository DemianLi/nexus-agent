/**
 * **一顆核准中斷一個面板**：這一顆的那批工具呼叫，一個決定。
 *
 * 問答中斷有它自己的面板（`question-panel.tsx`）。**兩個元件不是一個元件內部分支**——
 * 送出的形狀完全不同（`{decisions:[…]}` 對 `{answers:[…]}`），而 dsh 那邊也是兩個 slot。
 *
 * 界線在中斷上，不在輪次上（[#232](https://github.com/DemianLi/nexus-agent/issues/232)）。
 * 同一輪的其他中斷各有各的面板、先來先處理、各答各的——`interrupt_id` 是那道界線，伺服器據它逐
 * task 派送。
 *
 * **一張卡裡一批一個決定今天是「還沒做」，不是「不能做」。** 原本寫在這裡的理由是基座
 * 的批次語義（一筆被拒、被核准的那幾筆靜靜地不執行還從 `tool_calls` 裡被抹掉），那個
 * 理由在 [#112](https://github.com/DemianLi/nexus-agent/pull/112) 之後不成立了：閘門
 * 改成逐次呼叫各自判，一個被拒不再抹掉其他筆。
 *
 * **那句 `actions.length > 1` 的 rendered 警告刪掉了**（#232 第 5 項）。它講的是基座
 * 的批次抹除，而那件事 #112 之後不存在；至於它想提醒的「同一批還有別的工具」，現在
 * 畫面上就看得見——每一顆中斷自己一個面板、名稱帶「（1／2）」，不需要一句話代勞。`actionRequests` 經我們的
 * fold 恆長度 1，所以那條分支本來也到不了。
 *
 * **現在是換手層裡的面板**（#408，規格 §4.3）：外框、名稱、邊框光與焦點歸 `pending-swap.tsx`，這裡只畫要執行的內容與
 * 按鈕。只有允許／不允許，沒有 ❌、沒有停止、不可收起、Esc 不做事（§8）——停在核准點想結束就按不允許，讓模型
 * 接著回話（#376 第 10、11 條：#265 Q7「停在核准點按停止收回」因此在畫面上沒有入口，demian 知情後選的）。
 *
 * 按鈕只有 `pending.allowedDecisions` 裡的那些，而那份清單是**逐筆交集**（見
 * `@nexus/wire` 的 `intersectDecisions`）：基座對不在某一筆清單裡的決定是當場拋，
 * 一顆多出來的按鈕按下去是整場 run 死。
 */

import { ChevronDown } from 'lucide-react';

import type { PendingApproval } from '@nexus/wire';

import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

/** 封閉詞彙的中文字面。認不得的原樣顯示——寧可露出來，不要吞掉。 */
const LABELS: Record<string, string> = { approve: '全部核准', reject: '全部拒絕' };

/** 交集為空時的原因。 */
export const NO_DECISION_REASON =
  '這顆中斷沒有共同可用的決定：送出不在清單上的決定會讓這一輪整個失敗，所以這裡不放允許與不允許。';

function Actions({ pending }: { pending: PendingApproval }) {
  return (
    // 可捲動，所以要能用鍵盤捲：進 Tab 順序並給名稱（§8）。
    <div
      role="group"
      tabIndex={0}
      aria-label="要執行的內容"
      className="bg-stage shadow-stage flex max-h-[40svh] flex-col gap-3 overflow-auto rounded-xl p-3"
    >
      {pending.actions.map((action, index) => (
        <div key={`${action.name}-${index}`} className="flex flex-col gap-1.5">
          <p className="text-sm">
            要執行 <code className="font-mono font-medium">{action.name}</code>
          </p>
          <pre className="text-muted-foreground font-mono text-xs whitespace-pre-wrap">
            {/* 參數解不開的那顆，酬載帶的是模型吐的原字串（#281）：原樣顯示，不再包一層引號。 */}
            {typeof action.args === 'string' ? action.args : JSON.stringify(action.args, null, 2)}
          </pre>
        </div>
      ))}
    </div>
  );
}

export function ApprovalCard({
  pending,
  busy,
  onDecide,
  onStop,
}: {
  pending: PendingApproval;
  busy: boolean;
  onDecide: (decision: string) => void;
  /** 停止這一輪：**只在**交集為空時出現（#376 第 12 條），那時這是唯一的出口。 */
  onStop: () => void;
}) {
  if (pending.allowedDecisions.length === 0) {
    return (
      <div className="flex flex-col gap-2" data-testid="approval-card">
        <p className="text-destructive px-3 text-sm">{NO_DECISION_REASON}</p>
        <Collapsible>
          <CollapsibleTrigger className="group hover:bg-chip-hover active:bg-chip-pressed text-muted-foreground flex min-h-11 w-full items-center gap-2 rounded-[20px] px-3 text-left text-xs transition-colors duration-(--duration-quick) lg:min-h-9">
            <ChevronDown
              className="size-4 transition-transform duration-(--duration-fast) ease-(--ease-smooth-out) group-data-[state=open]:rotate-180"
              aria-hidden
            />
            原始中斷內容
          </CollapsibleTrigger>
          <CollapsibleContent className="data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden">
            <Actions pending={pending} />
          </CollapsibleContent>
        </Collapsible>
        <div className="flex justify-end p-2">
          <Button
            type="button"
            variant="destructive"
            className="h-11 rounded-full px-5 lg:h-9"
            disabled={busy}
            onClick={onStop}
          >
            停止這一輪
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col" data-testid="approval-card">
      <Actions pending={pending} />
      <div className="flex justify-end gap-2 p-2">
        {/* 不允許在左、允許在右。 */}
        {[...pending.allowedDecisions].reverse().map((decision) => (
          <Button
            key={decision}
            type="button"
            variant={decision === 'approve' ? 'default' : 'outline'}
            className="h-11 rounded-full px-5 lg:h-9"
            disabled={busy}
            onClick={() => onDecide(decision)}
          >
            {LABELS[decision] ?? decision}
          </Button>
        ))}
      </div>
    </div>
  );
}
