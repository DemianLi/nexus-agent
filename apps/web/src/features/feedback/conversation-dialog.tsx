/**
 * 回饋對話框的開關記帳，從 `app/App.tsx` 的會話畫面拆出來，獨立頁面與嵌入版共用（#2366）。
 */

import { useRef } from 'react';

import { FeedbackDialog } from '@/features/feedback/dialog';
import type { Feedback } from '@/features/feedback/use-feedback';

/** 這條對話的回饋對話框（`/feedback` 與回覆底下的回報）：開關與送出都由 `feedback` 管。 */
export function ConversationFeedbackDialog({ feedback }: { readonly feedback: Feedback }) {
  // 關掉之後留著最後那一份：退場動效那段時間裡框裡的字不能先消失。
  const lastDialog = useRef(feedback.feedbackDialog);
  // 數打開了幾次，給下面的 `key` 用。
  const dialogWasOpen = useRef(false);
  const dialogOpens = useRef(0);
  const dialogOpen = feedback.feedbackDialog !== undefined;
  if (dialogOpen && !dialogWasOpen.current) dialogOpens.current += 1;
  dialogWasOpen.current = dialogOpen;
  if (dialogOpen) lastDialog.current = feedback.feedbackDialog;
  const feedbackDialog = lastDialog.current;
  if (feedbackDialog === undefined) return null;
  return (
    <FeedbackDialog
      // 每打開一次、或換了目標，就是一張新的表單：草稿不帶過去。
      key={`${dialogOpens.current}:${JSON.stringify(feedbackDialog.target)}`}
      open={dialogOpen}
      submitting={feedbackDialog.submitting}
      {...(feedbackDialog.failure === undefined ? {} : { failure: feedbackDialog.failure })}
      onSubmit={(draft) => void feedback.submitFeedback(draft)}
      onDismiss={feedback.dismissFeedback}
    />
  );
}
