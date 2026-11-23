import type { ToolEntry } from '@nexus/wire';

import { markdownPlainText } from '@/shared/markdown/plain-text';

/**
 * 連線核心讀計劃要用的：一份計劃的標題與摘要、從 `exit_plan_mode` 那張工具卡讀出交出的計劃，以及計劃分頁的旁路掃描
 * （`Conversation.findPlan`）找到什麼。
 *
 * @module
 */

/** 交出計劃的工具名（`@nexus/plugin-plan-mode` 的 `EXIT_PLAN_MODE_TOOL_NAME`）。 */
export const EXIT_PLAN_MODE = 'exit_plan_mode';

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

/**
 * 計劃分頁的旁路掃描（#1798，`Conversation.findPlan`）找到什麼。照 dsh `planResourceProvider` 的幾種結局：找到（帶那一頁的
 * `firstSeq`，給「定位」`loadThrough` 用）、掃完沒有（`plan/not-found`）、讀取失敗（`plan/read-failed`）。另外兩種是 nexus 的：
 * 掃到一半換代（`stale`，呼叫端從新的游標重掃）與被中止（`aborted`，呼叫端已經不要了）。
 */
export type PlanScanOutcome =
  | { readonly kind: 'found'; readonly plan: PlanDocument; readonly firstSeq: number }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'stale' }
  | { readonly kind: 'aborted' };
