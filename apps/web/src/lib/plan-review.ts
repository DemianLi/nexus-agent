import type { QuestionItem } from '@nexus/wire';

/**
 * 這一組題目是不是一次計劃審核（[#652](https://github.com/DemianLi/nexus-agent/issues/652) 起 `exit_plan_mode` 這樣問）。
 *
 * 照 dsh `planReviewOf`（`packages/client/ui-user-questions/src/client/contract/slots.ts`，`477b4f4`）：**恰好一題**、
 * `intent.kind` 是 `plan-review`、帶 `detail`（計劃全文）、不是複選、選項至多兩個、其中一個的標籤等於
 * `intent.approve`。任何一條不成立就照一般提問處理——`intent` 只是呈現用的提示，認不出來不該擋住回答。
 *
 * @param questions - 那一次請求的整批題目。
 */
export function isPlanReview(questions: readonly QuestionItem[]): boolean {
  if (questions.length !== 1) return false;
  const question = questions[0]!;
  const intent = question.intent;
  if (intent?.kind !== 'plan-review' || question.detail === undefined) return false;
  if (question.multiSelect === true) return false;
  const options = question.options ?? [];
  if (options.length > 2) return false;
  return options.some((option) => option.label === intent.approve);
}
