/**
 * 以前的會話怎麼分組、怎麼搜（inventory 列 6；決定見卡片）。
 *
 * - **按時間分組**：今天、昨天、過去 7 天、更早，分界是瀏覽器當地的日曆日。dsh 按工作區分組，但一台 serve 只對一個專案
 *   （`projectKey(cwd)`），照它分只會有一組；UI 的形狀以 shadcn 為基底，不必照 dsh（AGENTS.md「技術實現標準」）。
 * - **空白的那一列不進分組**：它的時間是建立時間，不是誰說過話（`thread-list.tsx` 不帶時間的同一個理由），排在所有組前面。
 * - **搜尋只比標題**：第一則人打的字的開頭，不分大小寫、子字串。這是 dsh 側欄在前端做的那一半
 *   （`ui-workspace/src/client/tree.ts` 的 `deriveSearchResults`）；內容搜尋要伺服器的 `session.search`，還沒有。
 *   沒有標題的列（空白、只有目標排的輪次）搜尋時不列：畫面上那一句是我們替它寫的說明，不是它的標題。
 *
 * @module
 */

import type { ThreadSummary } from '@nexus/wire';

export type ThreadBucket = 'today' | 'yesterday' | 'week' | 'older';

export const BUCKET_LABEL: Record<ThreadBucket, string> = {
  today: '今天',
  yesterday: '昨天',
  week: '過去 7 天',
  older: '更早',
};

const BUCKET_ORDER: readonly ThreadBucket[] = ['today', 'yesterday', 'week', 'older'];

/** 那一天當地的零點。 */
function startOfDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** 差幾個日曆日；用日期算，不用毫秒除，夏令時間那天才不會差一天。 */
function daysBetween(earlier: number, later: number): number {
  const a = new Date(startOfDay(earlier));
  const b = new Date(startOfDay(later));
  return Math.round(
    (Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) -
      Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) /
      86_400_000,
  );
}

/** 這一列落在哪一組。時鐘比列表舊（`updatedAt` 在未來）時當成今天。 */
export function bucketOf(updatedAt: number, now: number): ThreadBucket {
  const days = daysBetween(updatedAt, now);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days <= 7) return 'week';
  return 'older';
}

export interface ThreadGroups {
  /** 不進分組、排在最前面的空白列。 */
  readonly blank: readonly ThreadSummary[];
  /** 有列的組，照今天到更早排；組內保持列表原本的順序（由新到舊）。 */
  readonly groups: readonly {
    readonly bucket: ThreadBucket;
    readonly items: readonly ThreadSummary[];
  }[];
}

export function groupThreads(items: readonly ThreadSummary[], now: number): ThreadGroups {
  const blank = items.filter((item) => item.blank);
  const byBucket = new Map<ThreadBucket, ThreadSummary[]>();
  for (const item of items) {
    if (item.blank) continue;
    const bucket = bucketOf(item.updatedAt, now);
    byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), item]);
  }
  return {
    blank,
    groups: BUCKET_ORDER.flatMap((bucket) => {
      const members = byBucket.get(bucket);
      return members === undefined ? [] : [{ bucket, items: members }];
    }),
  };
}

/** 搜尋：空字串（含只有空白）回原清單；否則只留標題含這段字的列。 */
export function filterThreads(
  items: readonly ThreadSummary[],
  query: string,
): readonly ThreadSummary[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === '') return items;
  return items.filter((item) => item.title?.toLocaleLowerCase().includes(needle) === true);
}
