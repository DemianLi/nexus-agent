/**
 * 換掉輸入框的核准卡、提問面板與計劃審核面板，從 `App.tsx` 的會話畫面拆出來，獨立頁面與嵌入版共用（#2366）。
 * `STOP_QUESTIONS_LABEL` 由 `App.tsx` 再匯出，原本從那裡讀它的測試照舊。
 */

import type { PendingInput } from '@nexus/wire';
import { X } from 'lucide-react';
import { toast } from 'sonner';

import { ApprovalCard } from '@/components/approval-card';
import { PlanReviewPanel } from '@/components/plan/review';
import { QuestionPanel } from '@/components/question-panel';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { Conversation } from '@/hooks/use-conversation';
import { pendingAsker } from '@/lib/approval-asker';
import { isPlanReview, planReviewOf } from '@/lib/plan-review';
import { STOPPED_QUESTION_TEXT } from '@/lib/question-view';

/** 提問面板名稱列右邊的 ❌：停止這一輪、不回答這些問題（`.docs/web-ui-spec.md` §4.3、§8）。名稱與 tooltip 同一句，不加確認。 */
export const STOP_QUESTIONS_LABEL = '停止這一輪，不回答這些問題';

/**
 * 換掉輸入框的那一個面板（`PendingSwap` 的 `renderPanel`）。
 *
 * **按 `kind` 分派到兩個元件，不是一個元件內部分支**（#231）：送出的形狀完全不同（`{decisions:[…]}` 對
 * `{answers:[…]}`），而認不得的 `kind` 根本到不了這裡——折疊器那一層就把它翻成 `failed` 了，理由見 `reduceInputRequested`。
 * 計劃審核（#654）是問答中斷的一種：認得 `intent` 才換成審核面板，其餘照一般提問。
 */
export function renderPendingPanel(conversation: Conversation, pending: PendingInput) {
  const asker = pendingAsker(conversation.state, pending);
  const review = pending.kind === 'question' ? planReviewOf(pending.questions) : undefined;
  if (pending.kind === 'question' && review !== undefined) {
    return (
      <PlanReviewPanel
        pending={pending}
        review={review}
        busy={!conversation.connected}
        onApprove={() =>
          void conversation.answer(pending.interruptId, [
            { id: review.questionId, selected: [review.approve] },
          ])
        }
        // 關掉這一題，這一輪不停；面板一收，焦點由 `PendingSwap` 交回輸入框。
        onRevise={() => void conversation.dismissQuestion(pending.interruptId)}
      />
    );
  }
  return pending.kind === 'question' ? (
    <QuestionPanel
      pending={pending}
      busy={!conversation.connected}
      onAnswer={(answers) => void conversation.answer(pending.interruptId, answers)}
      onDecline={() => void conversation.declineQuestion(pending.interruptId)}
      onDismiss={() => void conversation.dismissQuestion(pending.interruptId)}
    />
  ) : (
    <ApprovalCard
      pending={pending}
      {...(asker === undefined ? {} : { asker })}
      busy={!conversation.connected}
      onDecide={(decision) => void conversation.respond(pending.interruptId, decision)}
      onStop={() => {
        void conversation.cancel();
        toast('已停止這一輪');
      }}
    />
  );
}

/**
 * 面板名稱列右邊的動作（`PendingSwap` 的 `renderActions`）。
 *
 * 提問的 ❌ 停止這一輪，不讓模型在沒回答的情況下接著猜（`.docs/web-ui-spec.md` §4.3）。停下來之後那張提問工具卡展開、
 * 列出題目，輸入框提示字同一句。計劃審核面板沒有 ❌：「要求修改」才是它的出口（#654）。
 */
export function renderPendingActions(conversation: Conversation, pending: PendingInput) {
  return (
    pending.kind === 'question' &&
    !isPlanReview(pending.questions) && (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-11 shrink-0 lg:size-8"
                aria-label={STOP_QUESTIONS_LABEL}
                disabled={!conversation.connected}
                onClick={() => {
                  void conversation.cancel();
                  toast('已停止這一輪', { description: STOPPED_QUESTION_TEXT });
                }}
              />
            }
          >
            <X />
          </TooltipTrigger>
          <TooltipContent>{STOP_QUESTIONS_LABEL}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  );
}
