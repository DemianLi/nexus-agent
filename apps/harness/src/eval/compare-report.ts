/**
 * `eval:compare` 報表上一個模型那一段的文字。
 *
 * 從 `compare-cli.ts` 抽出來，是因為那個檔一 import 就會開跑（要憑證），而報表上印什麼
 * 是驗收條件（[#1002](https://github.com/DemianLi/nexus-agent/issues/1002)）：「一題 = X 個百分點」
 * 那一行與失敗次數的 token 都得有測試釘住它印得出來，所以文字要活在一個可以 import 的地方。
 */

import type { Spread, TierSummary } from './compare.js';
import { formatFloor } from './floor.js';
import type { ModelUnderTest } from './model-under-test.js';
import { formatCaseStats } from './stats.js';

/**
 * 一欄數字：平均，加上**範圍**（最小到最大）。
 *
 * 範圍不是誤差棒。它把「不同題目」與「同題重跑」兩種變異混在一起，所以改名叫「範圍」，
 * 區間另外印在底下（見 {@link formatCaseStats}）。範圍塌成一點時不印，省得每一行都拖一段
 * 沒有資訊的括號。
 */
export function formatSpread(spread: Spread | undefined): string {
  if (spread === undefined) return '—';
  const mean = spread.mean.toFixed(2);
  if (spread.min === spread.max) return mean;
  return `${mean}（範圍 ${spread.min.toFixed(2)}–${spread.max.toFixed(2)}）`;
}

/** 這一欄實際判了幾次。等於評到分的次數時不印 —— 每行都拖一段沒有資訊的括號很吵。 */
function judged(summary: TierSummary, spread: { count: number } | undefined): string {
  if (spread === undefined || spread.count === summary.scored) return '';
  return `（判了 ${spread.count}/${summary.scored} 次）`;
}

function tokens(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * 一個模型那一段報表。
 *
 * @param summary - 這個模型的彙總。
 * @param floor - 三個平凡 agent 的彙總，印在成功題數旁邊。
 * @param head - 抬頭底下的額外行（量過的日期之類），呼叫端才知道。
 */
export function summaryLines<T extends ModelUnderTest>(
  summary: TierSummary<T>,
  floor: readonly TierSummary[],
  head: readonly string[] = [],
): readonly string[] {
  const { tier } = summary;
  const failed = Object.entries(summary.failures)
    .map(([reason, count]) => `${reason}×${count}`)
    .join(' ');
  const stats = summary.caseStats;

  const lines = [
    `\n${tier.label}  ${tier.modelId}`,
    ...head,
    `  評到分      ${summary.scored} 次${failed === '' ? '' : `，失敗 ${failed}`}`,
    // **「這題成功」不是下面「工具成功率」那一欄**：後者只問該叫的叫了沒；這一項要三欄全滿、
    // 多叫沒超過容許值（見 `scorers.ts` 的 isCaseSuccess）。分母是評到分的次數。
    `  這題成功    ${summary.successes}/${summary.scored}`,
    `    區間      ${formatCaseStats(stats.success)}`,
    `    地板      ${formatFloor(floor)}（每題一次，同一份題目）`,
    // 前兩欄的 count 不一定等於「評到分」的次數：期望零筆呼叫的題目在這兩欄是
    // 「沒有可判的」，被濾掉了（見 `compare.ts` 的 TierSummary）。所以少於總數時印出來。
    `  工具成功率  ${formatSpread(summary.toolCallSuccess)}${judged(summary, summary.toolCallSuccess)}`,
    `    區間      ${formatCaseStats(stats.toolCallSuccess)}`,
    `  參數正確性  ${formatSpread(summary.argumentCorrectness)}${judged(summary, summary.argumentCorrectness)}`,
    `    區間      ${formatCaseStats(stats.argumentCorrectness)}`,
    `  多叫次數    ${formatSpread(summary.extraToolCalls)}`,
    `  回覆提到    ${formatSpread(summary.mentions)}${judged(summary, summary.mentions)}`,
    `    區間      ${formatCaseStats(stats.mentions)}`,
    // 成本與分數分開講：沒回報 usage 是「不知道」，印成 0 會讀成「免費」。
    `  總 token    ${formatSpread(summary.totalTokens)}` +
      `${summary.costed === summary.scored ? '' : `（只有 ${summary.costed}/${summary.scored} 次有回報 usage）`}`,
  ];

  const totals = summary.tokenTotals;
  if (totals !== undefined) {
    // **失敗的執行照樣花了 token**，所以合計分開列：評到分的、失敗的、全部。失敗那一欄是
    // 下限（被中止或被拒的最後一次呼叫沒有結束事件，量不到）。
    const failedNote =
      totals.failedRuns === 0
        ? ''
        : `（${totals.failedRuns} 次失敗中 ${totals.failedReported} 次有記到，是下限）`;
    lines.push(
      `  token 合計  評到分 ${tokens(totals.scored)} ＋ 失敗 ${tokens(totals.failed)}${failedNote} ＝ ${tokens(totals.all)}`,
    );
  }
  return lines;
}
