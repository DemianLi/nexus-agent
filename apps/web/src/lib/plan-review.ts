/**
 * 計劃審核（[#654](https://github.com/DemianLi/nexus-agent/issues/654)，harness 那一半是 #652）：認出一次審核、
 * 從計劃全文算出標題與摘要、從 `exit_plan_mode` 那張工具卡讀出審核結果。畫面在 `components/plan/plan-review.tsx`。
 *
 * 行為照 dsh（`477b4f4`，MIT，Copyright (c) DeepSeek）：
 *
 * - **認得意圖才接管**：`ui-user-questions` 的 `planReviewOf`，見 {@link planReviewOf}。
 * - **計劃的身分是那次工具呼叫的 id，標題是第一個 `# ` 標題**：`ui-plan/src/client/plan.ts` 的 `submittedPlan`。
 * - **摘要是第一段的純文字**：`PlanReviewPanel.tsx` 用 `extractMarkdownPlainText` 的 `first-paragraph`。
 *
 * 版面（面板與計劃卡同一套、結果 chip、全文開在右側欄）是 web 的 UI/UX，不照 dsh。
 *
 * ## 結果從哪裡讀
 *
 * 從 `exit_plan_mode` 那張卡的結果讀（{@link planOutcomeOf}），不讀本地那則 `AnswerEntry`：本地那則只有作答的分頁
 * 記得，結果文字即時與重播同一串（同提問卡的 #439）。改路由之前（#652 以前）的舊會話走的是核准，本地的決定紀錄
 * 同樣只有按下去的分頁記得；同意就是工具跑完、不同意是閘門的拒絕理由，同一個讀法也認得。卡上只有文字、沒有碼，所以
 * 跟 harness 的字比對；抄來的字由 `plan-review.test.ts` 讀那邊的原始碼對。
 *
 * @module
 */

import type { QuestionItem, ToolEntry } from '@nexus/wire';
import { UNFINISHED_TOOL_TEXT } from '@nexus/wire';

import { markdownPlainText } from '@/lib/markdown/plain-text';
import { WITHDRAWN_TOOL_REASON } from '@/lib/question-view';

/** 交出計劃的工具名（`@nexus/plugin-plan-mode` 的 `EXIT_PLAN_MODE_TOOL_NAME`）。 */
export const EXIT_PLAN_MODE = 'exit_plan_mode';

/** 認出來的一次審核。 */
export interface PlanReview {
  /** 審核那一題的 id：同意時答的就是它。 */
  readonly questionId: string;
  /** 同意那個選項的標籤（`intent.approve`）。**不要寫死**：照名字認同意，不照位置、不照字面。 */
  readonly approve: string;
  /** 計劃全文（題目的 `detail`）。 */
  readonly plan: string;
  /** 裝著這份計劃的那次工具呼叫；沒給（或給空字串）時是 `undefined`。 */
  readonly callId: string | undefined;
}

/**
 * 這一組題目是不是一次計劃審核（[#652](https://github.com/DemianLi/nexus-agent/issues/652) 起 `exit_plan_mode` 這樣問）。
 *
 * 照 dsh `planReviewOf`（`packages/client/ui-user-questions/src/client/contract/slots.ts`）：**恰好一題**、
 * `intent.kind` 是 `plan-review`、帶 `detail`（計劃全文）、不是複選、選項至多兩個、其中一個的標籤等於
 * `intent.approve`。任何一條不成立就照一般提問處理——`intent` 只是呈現用的提示，認不出來不該擋住回答。
 *
 * @param questions - 那一次請求的整批題目。
 */
export function planReviewOf(questions: readonly QuestionItem[]): PlanReview | undefined {
  if (questions.length !== 1) return undefined;
  const question = questions[0]!;
  const intent = question.intent;
  if (intent?.kind !== 'plan-review' || question.detail === undefined) return undefined;
  if (question.multiSelect === true) return undefined;
  const options = question.options ?? [];
  if (options.length > 2) return undefined;
  if (!options.some((option) => option.label === intent.approve)) return undefined;
  return {
    questionId: question.id,
    approve: intent.approve,
    plan: question.detail,
    callId: intent.callId === undefined || intent.callId === '' ? undefined : intent.callId,
  };
}

/** 見 {@link planReviewOf}。 */
export function isPlanReview(questions: readonly QuestionItem[]): boolean {
  return planReviewOf(questions) !== undefined;
}

/** 沒有 `# ` 標題時的標題。 */
export const UNTITLED_PLAN = '計劃';

/** 一份計劃畫在面板、計劃卡與分頁上要的東西。 */
export interface PlanDocument {
  readonly markdown: string;
  /** 第一個 `# ` 標題的純文字；沒有就是 {@link UNTITLED_PLAN}。 */
  readonly title: string;
  /** 第一段的純文字；跟標題一樣時是空字串。畫面截在兩行。 */
  readonly summary: string;
}

const HEADING = /^#\s+\S/u;

export function planDocument(markdown: string): PlanDocument {
  const titled = HEADING.test(markdown.trim());
  const title = titled ? markdownPlainText(markdown, 'first-line') : '';
  const paragraph = markdownPlainText(markdown, 'first-paragraph');
  return {
    markdown,
    title: title === '' ? UNTITLED_PLAN : title,
    summary: paragraph === title ? '' : paragraph,
  };
}

/**
 * 一張 `exit_plan_mode` 工具卡交出的計劃。
 *
 * 照 dsh `submittedPlan`：參數解得開、`plan` 是字串、**以 `# ` 標題開頭**才算；其他的留在通用工具卡。harness 在問人
 * 之前就擋掉沒有標題的計劃（`PLAN_HEADING_REQUIRED_MESSAGE`），所以被審過的都有標題。
 */
export function submittedPlanOf(entry: ToolEntry): PlanDocument | undefined {
  if (entry.name !== EXIT_PLAN_MODE) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.input);
  } catch {
    return undefined;
  }
  const plan = (parsed as { plan?: unknown } | null)?.plan;
  if (typeof plan !== 'string' || !HEADING.test(plan.trim())) return undefined;
  return planDocument(plan);
}

/** 審核的結果：同意、要求修改（含選了繼續規劃、舊路由的拒絕）、這一輪被停掉。 */
export type PlanOutcome = 'approved' | 'revise' | 'stopped';

export const PLAN_OUTCOME_LABEL: Readonly<Record<PlanOutcome, string>> = {
  approved: '已同意',
  revise: '要求修改',
  stopped: '停止',
};

/** 人關掉審核那一題（「要求修改」）時工具回的話（`PLAN_REVIEW_DISMISSED_MESSAGE`）。 */
export const PLAN_REVIEW_DISMISSED_TEXT =
  '使用者關掉了計劃審核，要自己說話。留在計劃模式，停在這裡，等使用者的訊息。';

/** 選了繼續規劃（有沒有寫意見都一樣）時工具回的話的開頭（`PLAN_KEEP_PLANNING_MESSAGE`、`planFeedbackMessage`）。 */
export const PLAN_KEEP_PLANNING_LEAD = '使用者選擇繼續規劃；';

/** 改路由之前（#652 以前）閘門拒絕交出計劃時的話（`@nexus/core` 的 `approval.ts`）。 */
export const LEGACY_PLAN_REJECTED_TEXT = `有人看過並拒絕了 "${EXIT_PLAN_MODE}"。`;

/**
 * 這張 `exit_plan_mode` 卡的審核結果；還在等、或在問人之前就被擋掉的（不在計劃模式、沒有人可以回答）是
 * `undefined`。
 *
 * **只比結尾或包含**：失敗的卡上是 core 的錯誤前綴接那一句，前綴只有一個主人，這裡不拼它。
 */
export function planOutcomeOf(entry: ToolEntry): PlanOutcome | undefined {
  if (entry.name !== EXIT_PLAN_MODE) return undefined;
  // 兩條路都只有同意才讓工具跑完：新路由回 `PLAN_APPROVED_MESSAGE`，舊路由是閘門放行之後工具本體跑完。
  if (entry.status === 'done') return 'approved';
  if (entry.status !== 'failed') return undefined;
  const said = entry.error ?? entry.text ?? '';
  if (said.endsWith(WITHDRAWN_TOOL_REASON) || said === UNFINISHED_TOOL_TEXT) return 'stopped';
  if (said.endsWith(PLAN_REVIEW_DISMISSED_TEXT) || said.endsWith(LEGACY_PLAN_REJECTED_TEXT)) {
    return 'revise';
  }
  if (said.includes(PLAN_KEEP_PLANNING_LEAD)) return 'revise';
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// 自動打開過哪幾份

export const AUTO_OPENED_KEY = 'nexus.plan-review.v1.auto-opened';
/** 記幾份。一份一個工具呼叫 id；只留最近的，免得無限長。 */
export const MAX_AUTO_OPENED = 200;

function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function readAutoOpened(): string[] {
  try {
    const raw = storage()?.getItem(AUTO_OPENED_KEY);
    const parsed: unknown = raw === null || raw === undefined ? [] : JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * 這份計劃自動打開過沒有（照 dsh `PlanReviewOpen`：同一份只自動開一次，人關掉就不再彈）。dsh 記在會話的記憶體裡，
 * 我們多記進 `localStorage`：卡上要求重新整理之後也不再自動開同一份。讀不到就當沒開過——多開一次比永遠不開好。
 */
export function wasAutoOpened(id: string): boolean {
  return readAutoOpened().includes(id);
}

export function markAutoOpened(id: string): void {
  const store = storage();
  if (store === undefined) return;
  try {
    const next = [id, ...readAutoOpened().filter((other) => other !== id)].slice(
      0,
      MAX_AUTO_OPENED,
    );
    store.setItem(AUTO_OPENED_KEY, JSON.stringify(next));
  } catch (error) {
    console.error('記不住自動打開過的計劃，重新整理之後可能再開一次：', error);
  }
}
