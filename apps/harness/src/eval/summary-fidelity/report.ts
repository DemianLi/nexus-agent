/**
 * 交接保真度評估的報表（[#2774](https://github.com/DemianLi/nexus-agent/issues/2774)）：每個變體一列得分，下面逐題列出。
 *
 * 樣本數跟著每個數字印：摘要是取樣出來的，一次與五次的 `1.00` 不是同一件事。
 */

import type { FidelityQuestionResult, FidelityVariantResult } from './runner.js';

const mean = (values: readonly number[]) =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

function formatScores(values: readonly number[]): string {
  if (values.length === 0) return '—';
  const low = Math.min(...values);
  const high = Math.max(...values);
  const range = low === high ? '' : `（範圍 ${low.toFixed(2)}–${high.toFixed(2)}）`;
  return `${mean(values).toFixed(2)}${range} n=${values.length}`;
}

/**
 * 把幾輪結果排成報表。
 *
 * @param rounds - 一輪是每個變體各跑一次的結果；變體失敗的那一輪沒有它的結果。
 * @returns 多行文字。
 */
export function formatFidelityReport(
  rounds: readonly (readonly FidelityVariantResult[])[],
): string {
  const byVariant = new Map<string, FidelityVariantResult[]>();
  for (const result of rounds.flat()) {
    byVariant.set(result.variantId, [...(byVariant.get(result.variantId) ?? []), result]);
  }

  const lines: string[] = [
    '變體          得分                         過時命中  摘要次數  摘要耗時（每次平均）',
  ];
  for (const [variantId, results] of byVariant) {
    const scores = results.flatMap((result) => (result.score === undefined ? [] : [result.score]));
    const stale = results.reduce((sum, result) => sum + result.staleHits, 0);
    const summaries = results.flatMap((result) => result.summaries);
    const seconds = (mean(summaries.map((summary) => summary.summarizeMs)) / 1000).toFixed(1);
    lines.push(
      `${variantId.padEnd(12)}  ${formatScores(scores).padEnd(27)}  ${String(stale).padEnd(8)}  ` +
        `${String(results[0]?.summaries.length ?? 0).padEnd(8)}  ${seconds}s`,
    );
  }

  lines.push('', '逐題（得分是各輪平均；「摘要裡有」是該提到的字串原樣在最後那則摘要裡的輪數）');
  for (const [variantId, results] of byVariant) {
    const first = results[0];
    if (first === undefined) continue;
    lines.push(`${variantId}  ${first.title}`);
    for (const question of first.questions) {
      const samples = results.flatMap((result) =>
        result.questions.filter((entry) => entry.questionId === question.questionId),
      );
      lines.push(`  ${formatQuestion(question, samples)}`);
    }
  }
  return lines.join('\n');
}

function formatQuestion(
  question: FidelityQuestionResult,
  samples: readonly FidelityQuestionResult[],
): string {
  const counted = samples.filter((sample) => !sample.leaked);
  const leaked = samples.length - counted.length;
  const inSummary = samples.filter((sample) => sample.inSummary).length;
  const stale = samples.filter((sample) => sample.staleHit).length;
  return (
    `${question.questionId.padEnd(13)} ${question.kind.padEnd(10)} 經過 ${question.summariesCrossed} 次摘要  ` +
    `得分 ${formatScores(counted.map((sample) => sample.score))}  摘要裡有 ${inSummary}/${samples.length}` +
    (stale === 0 ? '' : `  過時命中 ${stale}`) +
    (leaked === 0 ? '' : `  落在尾巴 ${leaked}（不計分）`)
  );
}
