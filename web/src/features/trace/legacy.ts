/**
 * 第 0 版的分組：沒有軌跡投影的那一側，以人那一格切成組。
 *
 * @module
 */

import type { TraceRow, TraceTurn } from '@/features/trace/model';
import type { Item } from '@/features/trace/rows';

/** 第 0 版的切法：以人那一格（`startsTurn`）切成組。 */
export function legacyGroups(items: readonly Item[]): TraceTurn[] {
  const groups: { key: string; rows: TraceRow[] }[] = [];
  let current: { key: string; rows: TraceRow[] } | undefined;
  for (const item of items) {
    const [first] = item.rows;
    if (first === undefined) continue;
    if (item.opens || current === undefined) {
      current = { key: first.key, rows: [] };
      groups.push(current);
    }
    current.rows.push(...item.rows);
  }
  return groups.map((group) => ({ ...group, legacy: true }));
}
