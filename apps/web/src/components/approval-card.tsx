/**
 * 核准請求：一批工具呼叫，一個決定。
 *
 * **一批一個決定今天是「還沒做」，不是「不能做」。** 原本寫在這裡的理由是基座的批次
 * 語義（一筆被拒、被核准的那幾筆靜靜地不執行還從 `tool_calls` 裡被抹掉），那個理由在
 * [#112](https://github.com/DemianLi/nexus-agent/pull/112) 之後不成立了：閘門改成逐次
 * 呼叫各自判，一個被拒不再抹掉其他筆。
 *
 * **下面那句 rendered 警告（`actions.length > 1` 那條分支）因此是過期的，這次沒有改。**
 * 它該寫什麼取決於折疊器把同一輪的多顆中斷怎麼處理，而那還沒定案——今天閘門每次呼叫
 * 各自發一顆單筆中斷，所以那條分支在產品路徑上到不了。
 *
 * 按鈕只有 `pending.allowedDecisions` 裡的那些，而那份清單是**逐筆交集**（見
 * `@nexus/wire` 的 `intersectDecisions`）：基座對不在某一筆清單裡的決定是當場拋，
 * 一顆多出來的按鈕按下去是整場 run 死。
 */

import type { PendingInput } from '@nexus/wire';

import { Button } from '@/components/ui/button';

/** 封閉詞彙的中文字面。認不得的原樣顯示——寧可露出來，不要吞掉。 */
const LABELS: Record<string, string> = { approve: '全部核准', reject: '全部拒絕' };

export function ApprovalCard({
  pending,
  busy,
  onDecide,
}: {
  pending: PendingInput;
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
      {pending.actions.length > 1 && (
        <p className="text-muted-foreground text-xs">
          這一批是全有全無：基座只要有一筆被拒，被核准的那幾筆也不會執行，而且不會留下任何痕跡。
        </p>
      )}
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
