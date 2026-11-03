/**
 * 回饋對話框的開關記帳，從 `App.tsx` 的會話畫面拆出來，獨立頁面與嵌入版共用（#2366）。
 */

import { useRef } from 'react';

import { FeedbackDialog } from '@/components/feedback-dialog';
import type { Conversation } from '@/hooks/use-conversation';

/** 這條對話的回饋對話框（`/feedback` 與回覆底下的回報）：開關與送出都由 `conversation` 管。 */
export function ConversationFeedbackDialog({
  conversation,
}: {
  readonly conversation: Conversation;
}) {
  // 關掉之後留著最後那一份：退場動效那段時間裡框裡的字不能先消失。
  const lastDialog = useRef(conversation.feedbackDialog);
  // 數打開了幾次，給下面的 `key` 用。
  const dialogWasOpen = useRef(false);
  const dialogOpens = useRef(0);
  const dialogOpen = conversation.feedbackDialog !== undefined;
  if (dialogOpen && !dialogWasOpen.current) dialogOpens.current += 1;
  dialogWasOpen.current = dialogOpen;
  if (dialogOpen) lastDialog.current = conversation.feedbackDialog;
  const feedbackDialog = lastDialog.current;
  if (feedbackDialog === undefined) return null;
  return (
    <FeedbackDialog
      // 每打開一次、或換了目標，就是一張新的表單：草稿不帶過去。
      key={`${dialogOpens.current}:${JSON.stringify(feedbackDialog.target)}`}
      open={dialogOpen}
      submitting={feedbackDialog.submitting}
      {...(feedbackDialog.failure === undefined ? {} : { failure: feedbackDialog.failure })}
      onSubmit={(draft) => void conversation.submitFeedback(draft)}
      onDismiss={conversation.dismissFeedback}
    />
  );
}
