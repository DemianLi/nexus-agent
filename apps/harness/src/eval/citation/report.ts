/**
 * 出處量測的彙總：把逐次記錄算成每組五項的比例與 Wilson 區間，印成 markdown。純函式。
 *
 * 分母的規矩：**執行失敗的（逾時、連線斷）不進任何比例**，另外列「失敗 x 次」，不默默丟掉。捏造的分母再排除
 * 「什麼都沒說也沒問」的執行（沒有東西可判）。
 */

import { formatProportion, wilson } from './proportion.js';
import type { Proportion } from './proportion.js';
import { GROUPS } from './fixture.js';
import type { Group } from './fixture.js';
import { scoreObservation } from './rubric.js';
import type { Observation, Scores } from './rubric.js';

/** 一次執行寫進 `runs.jsonl` 的一行。 */
export interface RunRecord extends Observation {
  readonly id: string;
  readonly rep: number;
  readonly durationMs: number;
  /** 執行失敗（逾時、連線斷）的原因；成功的沒有這一格。 */
  readonly error?: string;
}

/** 人工標的捏造判定，按 {@link RunRecord.id} 對應。 */
export interface Label {
  /** 答案（或反問）裡有工具結果以外的具體事實。 */
  readonly fabricated: boolean;
  /** 有保留語氣（「一般而言」「我沒有查到貴公司的規定」），不是當作這家公司的規定講。 */
  readonly hedged?: boolean;
  /** 沒有捏造具體事實，但斷言了一份它沒讀到的文件「載有／說明了」某些內容（例如「該公告說明了所需提前天數」）。另列，不算捏造。 */
  readonly claimsUnseenContent?: boolean;
  readonly note?: string;
}

export type Labels = Readonly<Record<string, Label>>;

interface Row {
  readonly record: RunRecord;
  readonly scores: Scores;
}

function rows(records: readonly RunRecord[], group: Group): Row[] {
  return records
    .filter((record) => record.group === group && record.error === undefined)
    .map((record) => ({ record, scores: scoreObservation(record) }));
}

function count(items: readonly Row[], predicate: (row: Row) => boolean): Proportion {
  return wilson(items.filter(predicate).length, items.length);
}

/** 一組的各項比例。 */
export interface GroupSummary {
  readonly group: Group;
  readonly total: number;
  readonly failed: number;
  readonly calledSource: Proportion;
  readonly calledAnyTool: Proportion;
  readonly asked: Proportion;
  readonly answered: Proportion;
  readonly none: Proportion;
  readonly namesSystem: Proportion;
  readonly namesSystemLoose: Proportion;
  readonly markdownLink: Proportion;
  readonly markdownLinkToSource: Proportion;
  readonly fabricatedAuto: Proportion;
  /** 有人工標才有。 */
  readonly fabricatedManual?: Proportion;
  readonly fabricatedUnhedged?: Proportion;
  readonly claimsUnseenContent?: Proportion;
  /** 說出系統名的那幾次，是否各項都在「有答案」的執行裡（分母：回答了的）。 */
  readonly namesSystemWhenAnswered: Proportion;
}

/**
 * 算一組。
 *
 * @param records - 全部記錄。
 * @param group - 要算哪一組。
 * @param labels - 人工標；沒有就只報自動判。
 */
export function summarizeGroup(
  records: readonly RunRecord[],
  group: Group,
  labels: Labels = {},
): GroupSummary {
  const ok = rows(records, group);
  const failed = records.filter((r) => r.group === group && r.error !== undefined).length;
  const judgeable = ok.filter((row) => row.scores.judgedText.trim() !== '');
  const answered = ok.filter((row) => row.scores.outcome === 'answered');
  const labelled = judgeable.filter((row) => labels[row.record.id] !== undefined);
  const complete = judgeable.length > 0 && labelled.length === judgeable.length;
  return {
    group,
    total: ok.length,
    failed,
    calledSource: count(ok, (r) => r.scores.calledSource),
    calledAnyTool: count(ok, (r) => r.scores.calledAnyTool),
    asked: count(ok, (r) => r.scores.outcome === 'asked'),
    answered: count(ok, (r) => r.scores.outcome === 'answered'),
    none: count(ok, (r) => r.scores.outcome === 'none'),
    namesSystem: count(ok, (r) => r.scores.namesSystem),
    namesSystemLoose: count(ok, (r) => r.scores.namesSystemLoose),
    markdownLink: count(ok, (r) => r.scores.markdownLink),
    markdownLinkToSource: count(ok, (r) => r.scores.markdownLinkToSource),
    fabricatedAuto: count(judgeable, (r) => r.scores.fabricatedAuto),
    ...(complete
      ? {
          fabricatedManual: count(judgeable, (r) => labels[r.record.id]?.fabricated === true),
          fabricatedUnhedged: count(
            judgeable,
            (r) => labels[r.record.id]?.fabricated === true && labels[r.record.id]?.hedged !== true,
          ),
          claimsUnseenContent: count(
            judgeable,
            (r) => labels[r.record.id]?.claimsUnseenContent === true,
          ),
        }
      : {}),
    namesSystemWhenAnswered: wilson(
      answered.filter((r) => r.scores.namesSystem).length,
      answered.length,
    ),
  };
}

/** 自動判與人工判不一致的記錄 id，供抽查。 */
export function disagreements(records: readonly RunRecord[], labels: Labels): string[] {
  return records
    .filter((record) => record.error === undefined)
    .map((record) => ({ record, scores: scoreObservation(record) }))
    .filter(({ record, scores }) => {
      const label = labels[record.id];
      return (
        label !== undefined &&
        scores.judgedText.trim() !== '' &&
        label.fabricated !== scores.fabricatedAuto
      );
    })
    .map(({ record }) => record.id);
}

const LINES: readonly [string, keyof GroupSummary][] = [
  ['呼叫了夾具的搜尋工具', 'calledSource'],
  ['呼叫了任何工具', 'calledAnyTool'],
  ['反問（ask_user_question 或停在 awaiting-input）', 'asked'],
  ['回答了', 'answered'],
  ['空手收工（沒答也沒問）', 'none'],
  ['說出系統名 `kb`（嚴格）', 'namesSystem'],
  ['說出 `kb` 或「知識庫」（寬鬆）', 'namesSystemLoose'],
  ['其中：回答了的執行裡說出 `kb`', 'namesSystemWhenAnswered'],
  ['有 markdown 連結（任何網址）', 'markdownLink'],
  ['有 markdown 連結且網址是夾具回的', 'markdownLinkToSource'],
  ['捏造（自動判，下限）', 'fabricatedAuto'],
  ['捏造（人工判）', 'fabricatedManual'],
  ['捏造且沒有保留語氣（人工判）', 'fabricatedUnhedged'],
  ['斷言讀不到的文件載有某些內容（人工判，不算捏造）', 'claimsUnseenContent'],
];

/** 印出三組的對照表（markdown）。 */
export function renderSummary(
  records: readonly RunRecord[],
  labels: Labels = {},
  groups: readonly Group[] = GROUPS,
): string {
  const summaries = groups.map((group) => summarizeGroup(records, group, labels));
  const header = [
    '| 項目 | ' + summaries.map((s) => `${s.group}（n=${s.total}）`).join(' | ') + ' |',
  ];
  header.push('| --- | ' + summaries.map(() => '---').join(' | ') + ' |');
  const body = LINES.flatMap(([label, key]) => {
    const cells = summaries.map((s) => {
      const value = s[key];
      return typeof value === 'object' && value !== null && 'k' in value
        ? formatProportion(value as Proportion)
        : '—';
    });
    return cells.every((cell) => cell === '—') ? [] : [`| ${label} | ${cells.join(' | ')} |`];
  });
  const failures = summaries.filter((s) => s.failed > 0).map((s) => `${s.group} 組 ${s.failed} 次`);
  return [
    ...header,
    ...body,
    '',
    failures.length === 0
      ? '執行失敗（逾時、連線斷）：0 次。'
      : `執行失敗（不進任何比例）：${failures.join('、')}。`,
    '區間為 Wilson 95%，假設每次執行互相獨立（同一問法的重跑是近似）。',
  ].join('\n');
}

/** 各問法的明細：每組每題幾次反問、幾次說出 `kb`、幾次自動判捏造。 */
export function renderByQuestion(records: readonly RunRecord[]): string {
  const questions = [...new Set(records.map((r) => r.question))];
  const lines = [
    '| 問法 | 組 | n | 反問 | 說出 kb | markdown 連結 | 自動判捏造 |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const question of questions) {
    for (const group of GROUPS) {
      const ok = rows(records, group).filter((row) => row.record.question === question);
      if (ok.length === 0) continue;
      const n = (predicate: (row: Row) => boolean): number => ok.filter(predicate).length;
      lines.push(
        `| ${question} | ${group} | ${ok.length} | ${n((r) => r.scores.outcome === 'asked')} | ${n((r) => r.scores.namesSystem)} | ${n((r) => r.scores.markdownLink)} | ${n((r) => r.scores.fabricatedAuto)} |`,
      );
    }
  }
  return lines.join('\n');
}
