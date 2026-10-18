/**
 * nexus 層（#1638 PR C）：轉出 vendor 的 solid-glass 版（`vendor/solid-glass/components/ui/questionnaire.tsx`），外觀照 SG（#1468 Q8）。
 * 本地修改登記在 `vendor/solid-glass/README.md` 的「本地修改」，這個檔有一條（第 45 條）：
 *
 * - 上一題、跳過、下一題、送出答案四顆按鈕的預設字換成中文（§8）。vendor 預設是英文；`question-panel` 自己有給字，
 *   這裡管的是新的呼叫端忘了給字時不漏出英文。只補預設 children、不必複製上游標記，所以走包裝層（同第 26 條）。
 *   用 `??` 而不是預設參數：預設參數只擋 `undefined`，呼叫端傳 `null` 會漏到 vendor 的 `?? "Previous"`（同 registry 版的寫法）。
 *
 * 選項的焦點外框寫在覆寫檔那一層（第 46 條，`styles/solid-glass.overrides.css`）。
 */
import type * as React from 'react';

import {
  QuestionnaireNext as VendorQuestionnaireNext,
  QuestionnairePrevious as VendorQuestionnairePrevious,
  QuestionnaireSkip as VendorQuestionnaireSkip,
  QuestionnaireSubmit as VendorQuestionnaireSubmit,
} from '@/vendor/solid-glass/components/ui/questionnaire';

export {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireError,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireProgress,
  QuestionnaireTitle,
} from '@/vendor/solid-glass/components/ui/questionnaire';

function QuestionnairePrevious({
  children,
  ...props
}: React.ComponentProps<typeof VendorQuestionnairePrevious>) {
  return (
    <VendorQuestionnairePrevious {...props}>{children ?? '上一題'}</VendorQuestionnairePrevious>
  );
}

function QuestionnaireSkip({
  children,
  ...props
}: React.ComponentProps<typeof VendorQuestionnaireSkip>) {
  return <VendorQuestionnaireSkip {...props}>{children ?? '跳過'}</VendorQuestionnaireSkip>;
}

function QuestionnaireNext({
  children,
  ...props
}: React.ComponentProps<typeof VendorQuestionnaireNext>) {
  return <VendorQuestionnaireNext {...props}>{children ?? '下一題'}</VendorQuestionnaireNext>;
}

function QuestionnaireSubmit({
  children,
  ...props
}: React.ComponentProps<typeof VendorQuestionnaireSubmit>) {
  return <VendorQuestionnaireSubmit {...props}>{children ?? '送出答案'}</VendorQuestionnaireSubmit>;
}

export { QuestionnaireNext, QuestionnairePrevious, QuestionnaireSkip, QuestionnaireSubmit };
