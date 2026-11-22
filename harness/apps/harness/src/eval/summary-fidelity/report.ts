/**
 * 交接保真度評估的報表（[#2774](https://github.com/DemianLi/nexus-agent/issues/2774)）：每個變體一列得分，下面逐題列出。
 *
 * 得分跟著印樣本數：摘要是取樣出來的，一次與五次的 `1.00` 不是同一件事。
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
    const without = results.flatMap((result) =>
      result.scoreWithoutTools === undefined ? [] : [result.scoreWithoutTools],
    );
    const stale = results.reduce((sum, result) => sum + result.staleHits, 0);
    const summaries = results.flatMap((result) => result.summaries);
    const seconds = (mean(summaries.map((summary) => summary.summarizeMs)) / 1000).toFixed(1);
    lines.push(
      `${variantId.padEnd(12)}  ${formatScores(scores).padEnd(27)}  ${String(stale).padEnd(8)}  ` +
        `${String(results[0]?.summaries.length ?? 0).padEnd(8)}  ${seconds}s` +
        (without.length === 0 ? '' : `  不帶工具 ${formatScores(without)}`),
    );
  }

  lines.push(
    '',
    '逐題（得分是各輪平均；「摘要裡有」是該提到的字串都在最後那則摘要裡的輪數，比對不看空白與連字號的寫法）',
  );
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
  lines.push(...formatBySummary(rounds.flat().flatMap((result) => result.questions)));
  return lines.join('\n');
}

/**
 * 照「摘要裡有沒有答案」把所有題次分成兩類各算一次。讀回工具只有在摘要裡沒有答案時才有東西可以補，
 * 混在一起平均看不出它的作用。
 */
function formatBySummary(samples: readonly FidelityQuestionResult[]): string[] {
  const counted = samples.filter((sample) => !sample.leaked);
  const paired = counted.some((sample) => sample.withoutTools !== undefined);
  const recall = paired || counted.some((sample) => sample.recallCalls > 0);
  const lines = ['', '照摘要裡有沒有答案分（所有變體、所有輪的題次；落在尾巴的不算）'];
  for (const [label, group] of [
    ['摘要裡有答案', counted.filter((sample) => sample.inSummary)],
    ['摘要裡沒有答案', counted.filter((sample) => !sample.inSummary)],
  ] as const) {
    if (group.length === 0) {
      lines.push(`  ${label}  0 題次`);
      continue;
    }
    const called = group.filter((sample) => sample.recallCalls > 0);
    const without = group.flatMap((sample) =>
      sample.withoutTools === undefined ? [] : [sample.withoutTools.score],
    );
    lines.push(
      `  ${label}  ${group.length} 題次  得分 ${mean(group.map((sample) => sample.score)).toFixed(2)}` +
        (paired && without.length > 0 ? `  不帶工具 ${mean(without).toFixed(2)}` : '') +
        (recall
          ? `  叫了讀回工具 ${called.length}/${group.length}` +
            (called.length === 0
              ? ''
              : `（叫了的得分 ${mean(called.map((sample) => sample.score)).toFixed(2)}）`)
          : ''),
    );
  }
  return lines;
}

function formatQuestion(
  question: FidelityQuestionResult,
  samples: readonly FidelityQuestionResult[],
): string {
  const counted = samples.filter((sample) => !sample.leaked);
  const leaked = samples.length - counted.length;
  const inSummary = samples.filter((sample) => sample.inSummary).length;
  const stale = samples.filter((sample) => sample.staleHit).length;
  const recalled = samples.filter((sample) => sample.recallCalls > 0).length;
  const without = counted.flatMap((sample) =>
    sample.withoutTools === undefined ? [] : [sample.withoutTools.score],
  );
  return (
    `${question.questionId.padEnd(13)} ${question.kind.padEnd(10)} 經過 ${question.summariesCrossed} 次摘要  ` +
    `得分 ${formatScores(counted.map((sample) => sample.score))}  摘要裡有 ${inSummary}/${samples.length}` +
    (without.length === 0 ? '' : `  不帶工具 ${formatScores(without)}`) +
    (recalled === 0 ? '' : `  叫了讀回工具 ${recalled}/${samples.length}`) +
    (stale === 0 ? '' : `  過時命中 ${stale}`) +
    (leaked === 0 ? '' : `  落在尾巴 ${leaked}（不計分）`)
  );
}
