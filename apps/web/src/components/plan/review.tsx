/**
 * 計劃審核的畫面（[#654](https://github.com/DemianLi/nexus-agent/issues/654)）：換掉輸入框的審核面板、對話裡的計劃卡。
 * 全文開在右側欄的「計劃」分頁（`preview-tab.tsx`）。規則在 `lib/plan-review.ts`。
 *
 * 行為照 dsh（`477b4f4`）的 `ui-user-questions` `PlanReviewPanel` 與 `ui-plan` `PlanReviewOpen`：
 *
 * - **只有兩顆鈕、不單列拒絕**：「同意執行」用 `intent.approve` 指名的標籤回答；「要求修改」**關掉這一題**（送
 *   `cancelled`），這一輪不停，輸入框歸位給人打意見。不是一般提問面板那顆 ❌（那顆停止這一輪，§4.3 的例外）。
 * - **待審時自動打開全文一次**：同一份只自動開一次，人關掉就不再彈；「查看全文」是手動的入口。dsh 的右側欄沒有窄螢幕
 *   覆蓋的版型，我們 1024 以下不自動開（二-Q4）。
 *
 * 面板與計劃卡同一套版型（標題＋兩行摘要＋「查看全文」），計劃卡多一顆結果 chip（二-Q2、二-Q6）；這是 web 的 UI/UX，
 * 不照 dsh（dsh 的計劃卡是一張文件卡）。
 */

import { ChevronRight, ScrollText } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';

import type { ConversationEntry, PendingInput, PendingQuestion, ToolEntry } from '@nexus/wire';

import { useRightSidebar } from '@/components/sidebar/right-sidebar-context';
import { ToolCard } from '@/components/tool/card';
import { Button } from '@/components/ui/button';
import {
  EXIT_PLAN_MODE,
  markAutoOpened,
  PLAN_OUTCOME_LABEL,
  planDocument,
  planOutcomeOf,
  planReviewOf,
  submittedPlanOf,
  wasAutoOpened,
} from '@/lib/plan-review';
import type { PlanDocument, PlanReview } from '@/lib/plan-review';

/** 面板與計劃卡上打開全文的那顆鈕。 */
export const OPEN_PLAN_LABEL = '查看全文';

/** 一份計劃在右側欄的身分：交出它的那次工具呼叫；審核請求沒帶的話退回那一顆中斷。 */
export function planIdOf(review: PlanReview, interruptId: string): string {
  return review.callId ?? `review:${interruptId}`;
}

/**
 * 對話裡的每一份計劃，以 {@link planIdOf} 為鍵：右側欄的分頁照它找全文與標題。
 *
 * 來源是 `exit_plan_mode` 的參數（即時與重播同一串），加上等著審的那幾顆（沒帶工具呼叫 id 的只在這裡有）。
 * **沒變就回同一個 Map**：串流中每一格都會重畫，而解析 markdown 不便宜，右側欄也靠這個參照決定要不要重畫。
 */
export function usePlanLibrary(
  entries: readonly ConversationEntry[],
  pendings: readonly PendingInput[],
): ReadonlyMap<string, PlanDocument> {
  const last = useRef<ReadonlyMap<string, PlanDocument>>(new Map());
  const sources = new Map<string, string>();
  for (const entry of entries) {
    if (entry.kind !== 'tool' || entry.name !== EXIT_PLAN_MODE) continue;
    const plan = planArgument(entry);
    if (plan !== undefined) sources.set(entry.callId, plan);
  }
  for (const pending of pendings) {
    if (pending.kind !== 'question') continue;
    const review = planReviewOf(pending.questions);
    if (review === undefined) continue;
    const id = planIdOf(review, pending.interruptId);
    if (!sources.has(id)) sources.set(id, review.plan);
  }
  const previous = last.current;
  let same = previous.size === sources.size;
  const next = new Map<string, PlanDocument>();
  for (const [id, markdown] of sources) {
    const known = previous.get(id);
    if (known?.markdown === markdown) {
      next.set(id, known);
    } else {
      same = false;
      next.set(id, planDocument(markdown));
    }
  }
  if (same) return previous;
  last.current = next;
  return next;
}

function planArgument(entry: ToolEntry): string | undefined {
  try {
    const plan = (JSON.parse(entry.input) as { plan?: unknown } | null)?.plan;
    return typeof plan === 'string' ? plan : undefined;
  } catch {
    return undefined;
  }
}

/** 面板與計劃卡共用的那一塊：標題、兩行摘要、「查看全文」。 */
function PlanSummary({ plan, id }: { plan: PlanDocument; id: string }) {
  const sidebar = useRightSidebar();
  return (
    <div className="flex flex-col gap-1 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <h3 className="min-w-0 flex-1 text-body font-medium break-words" data-testid="plan-title">
          {plan.title}
        </h3>
        {/* 沒有右側欄時不給這顆：按了沒反應比不給更糟（同交付卡）。 */}
        {sidebar !== undefined && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground -my-1 h-11 shrink-0 rounded-full lg:h-8"
            aria-label={`${OPEN_PLAN_LABEL}：${plan.title}`}
            onClick={(event) => sidebar.openPlan(id, event.currentTarget)}
          >
            {OPEN_PLAN_LABEL}
            <ChevronRight aria-hidden />
          </Button>
        )}
      </div>
      {plan.summary !== '' && (
        <p className="text-muted-foreground line-clamp-2 text-body" data-testid="plan-summary">
          {plan.summary}
        </p>
      )}
    </div>
  );
}

/**
 * 換掉輸入框的審核面板。外框、名稱（「計劃待審」＋跨面板進度）與邊框光歸 `pending-swap.tsx`；這一種跟核准面板一樣
 * 不能收起、Esc 不做事、沒有 ❌（二-Q5）。
 */
export function PlanReviewPanel({
  pending,
  review,
  busy,
  onApprove,
  onRevise,
}: {
  pending: PendingQuestion;
  review: PlanReview;
  busy: boolean;
  /** 同意：用 `review.approve` 回答審核那一題。 */
  onApprove: () => void;
  /** 要求修改：關掉這一題。 */
  onRevise: () => void;
}) {
  const id = planIdOf(review, pending.interruptId);
  const plan = useMemo(() => planDocument(review.plan), [review.plan]);
  const sidebar = useRightSidebar();
  useEffect(() => {
    if (sidebar === undefined || wasAutoOpened(id)) return;
    if (sidebar.autoOpenPlan(id)) markAutoOpened(id);
  }, [sidebar, id]);
  return (
    <div className="flex flex-col" data-testid="plan-review-panel">
      <div className="bg-stage shadow-stage rounded-xl">
        <PlanSummary plan={plan} id={id} />
      </div>
      <div className="flex justify-end gap-2 p-2">
        {/* 要求修改在左（次要），同意執行在右（主要）。 */}
        <Button
          type="button"
          variant="outline"
          className="h-11 rounded-full px-5 lg:h-9"
          disabled={busy}
          onClick={onRevise}
        >
          要求修改
        </Button>
        <Button
          type="button"
          className="h-11 rounded-full px-5 lg:h-9"
          disabled={busy}
          onClick={onApprove}
        >
          同意執行
        </Button>
      </div>
    </div>
  );
}

/**
 * 對話裡的計劃卡：放在 `exit_plan_mode` 那張工具卡的位置，重新整理後走歷史照樣在（二-Q4、Q6）。結果 chip 用決定紀錄
 * 的樣式；還在等、或在問人之前就被擋掉的沒有 chip。
 */
export function PlanCard({ entry, plan }: { entry: ToolEntry; plan: PlanDocument }) {
  const outcome = planOutcomeOf(entry);
  return (
    <section
      aria-label={`計劃：${plan.title}`}
      className="bg-card shadow-material rounded-3xl p-1"
      data-testid="plan-card"
      data-outcome={outcome}
    >
      <div className="text-muted-foreground flex min-h-9 items-center gap-2 px-3 pt-1 text-tip">
        <ScrollText aria-hidden className="size-4 shrink-0" />
        <span className="flex-1">計劃</span>
        {outcome !== undefined && (
          <span className="bg-chip rounded-full px-3 py-1" data-testid="plan-outcome">
            {PLAN_OUTCOME_LABEL[outcome]}
          </span>
        )}
      </div>
      <PlanSummary plan={plan} id={entry.callId} />
    </section>
  );
}

/** `exit_plan_mode` 那一顆：交得出計劃就是計劃卡，參數解不開、沒有標題的照通用工具卡（同 dsh `submittedPlan`）。 */
export function PlanToolCard({ entry, beam }: { entry: ToolEntry; beam: boolean }) {
  // 串流中每一格都會重畫，參數不變就不重解 markdown。
  const plan = useMemo(() => submittedPlanOf(entry), [entry]);
  return plan === undefined ? (
    <ToolCard entry={entry} beam={beam} />
  ) : (
    <PlanCard entry={entry} plan={plan} />
  );
}
