/**
 * 右側欄的「計劃」分頁（[#654](https://github.com/DemianLi/nexus-agent/issues/654) 二-Q3）：一份計劃的全文，用對話裡
 * 同一套 markdown 渲染。照 dsh `ui-plan` 的 `PlanPreview`：唯讀、整份畫出來，區塊的名稱就是計劃標題。
 */

import { MarkdownText } from '@/components/markdown-text';
import type { PlanDocument } from '@/lib/plan-review';

export function PlanPreviewTab({ plan }: { plan: PlanDocument }) {
  return (
    <section
      aria-label={plan.title}
      className="min-h-0 flex-1 overflow-y-auto px-6 py-4"
      data-testid="plan-preview"
      // 可捲動的區塊要能用鍵盤捲：進 Tab 順序（同核准面板的內容區，§8）。
      tabIndex={0}
    >
      <div className="text-body mx-auto max-w-3xl text-sm">
        <MarkdownText text={plan.markdown} />
      </div>
    </section>
  );
}
