/**
 * 人在核准點上按了什麼，怎麼說成一句話（對話裡那顆 chip 與右側欄觀測分頁的決定列共用，#1033）。
 *
 * 詞彙由基座定（`approve`／`reject`），不認得的原樣照講，不窄化。
 *
 * @module
 */

import type { DecisionEntry } from '@nexus/wire';

export function decisionText(entry: DecisionEntry): string {
  const approved = entry.decision === 'approve';
  const verdict = approved ? '已核准' : entry.decision === 'reject' ? '已拒絕' : entry.decision;
  return `${verdict}：${entry.actions.join('、')}${approved ? '' : '（沒有執行）'}`;
}
