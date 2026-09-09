/**
 * **一顆核准中斷一張卡**：這一顆的那批工具呼叫，一個決定。
 *
 * 問答中斷有它自己的卡（`question-card.tsx`）。**兩個元件不是一個元件內部分支**——
 * 送出的形狀完全不同（`{decisions:[…]}` 對 `{answers:[…]}`），而 dsh 那邊也是兩個 slot。
 *
 * 界線在中斷上，不在輪次上（[#232](https://github.com/DemianLi/nexus-agent/issues/232)）。
 * 同一輪的其他中斷各有各的卡、各答各的——`interrupt_id` 是那道界線，伺服器據它逐
 * task 派送。
 *
 * **一張卡裡一批一個決定今天是「還沒做」，不是「不能做」。** 原本寫在這裡的理由是基座
 * 的批次語義（一筆被拒、被核准的那幾筆靜靜地不執行還從 `tool_calls` 裡被抹掉），那個
 * 理由在 [#112](https://github.com/DemianLi/nexus-agent/pull/112) 之後不成立了：閘門
 * 改成逐次呼叫各自判，一個被拒不再抹掉其他筆。
 *
 * **那句 `actions.length > 1` 的 rendered 警告刪掉了**（#232 第 5 項）。它講的是基座
 * 的批次抹除，而那件事 #112 之後不存在；至於它想提醒的「同一批還有別的工具」，現在
 * 畫面上就看得見——每一顆中斷自己一張卡，不需要一句話代勞。`actionRequests` 經我們的
 * fold 恆長度 1，所以那條分支本來也到不了。
 *
 * 按鈕只有 `pending.allowedDecisions` 裡的那些，而那份清單是**逐筆交集**（見
 * `@nexus/wire` 的 `intersectDecisions`）：基座對不在某一筆清單裡的決定是當場拋，
 * 一顆多出來的按鈕按下去是整場 run 死。
 */

import type { PendingApproval } from '@nexus/wire';

import { Button } from '@/components/ui/button';

/** 封閉詞彙的中文字面。認不得的原樣顯示——寧可露出來，不要吞掉。 */
const LABELS: Record<string, string> = { approve: '全部核准', reject: '全部拒絕' };

export function ApprovalCard({
  pending,
  busy,
  onDecide,
}: {
  pending: PendingApproval;
  busy: boolean;
  onDecide: (decision: string) => void;
}) {
  return (
    <section
      className="border-border bg-card flex flex-col gap-3 rounded-lg border p-4"
      aria-label="核准請求"
      data-testid="approval-card"
    >
      <p className="text-sm font-medium">要跑這 {pending.actions.length} 個工具，等你決定：</p>
      <ul className="flex flex-col gap-2">
        {pending.actions.map((action, index) => (
          <li key={`${action.name}-${index}`} className="flex flex-col gap-1">
            <code className="text-sm font-medium">{action.name}</code>
            <pre className="text-muted-foreground overflow-x-auto text-xs">
              {JSON.stringify(action.args)}
            </pre>
          </li>
        ))}
      </ul>
      {pending.allowedDecisions.length === 0 && (
        <p className="text-destructive text-xs">
          這顆中斷沒有共同可用的決定，這裡按不了 —— 只能重開一條對話。
        </p>
      )}
      <div className="flex gap-2">
        {pending.allowedDecisions.map((decision) => (
          <Button
            key={decision}
            type="button"
            variant={decision === 'approve' ? 'default' : 'outline'}
            disabled={busy}
            onClick={() => onDecide(decision)}
          >
            {LABELS[decision] ?? decision}
          </Button>
        ))}
      </div>
    </section>
  );
}
