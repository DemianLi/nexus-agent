/**
 * 側欄的會話管理：釘選、封存、改名（[#633](https://github.com/DemianLi/nexus-agent/issues/633) 的 web 那一半）。
 *
 * **有沒有這個功能看 server**：列表（`GET /threads`）帶了釘選與封存兩個集合（{@link readSets}）才算支援，沒帶（還沒實作的
 * server、列表還在讀或讀失敗）整個功能不出現——列的選單、「已釘選」「已封存」兩區、改名輸入都沒有，畫面與以前逐像素相同。
 * 附件寫死開關是因為沒有可以先問的東西，這裡列表本身就是答案。實作在 `hooks/use-thread-management.ts`。
 *
 * **畫面一律以 server 回的完整集合為準，本機不自己推**（例如「封存同時取消釘選」是 server 的規則，不在這裡重算）：
 * 動作成功就拿回應裡的整份集合取代，封存與改名之後再重抓一次列表。規則照 dsh（`workspace-controller/src/commands.ts:155-230`）：
 * 封存的會話不能釘、取消是冪等的、釘選的順序是最近釘的在前。
 *
 * @module
 */

import type { ThreadListResult, ThreadSummary } from '@nexus/wire';

/** 列表帶的兩個集合；兩格都有才算 server 支援釘選與封存，缺一格就當沒有。 */
export function readSets(
  result: ThreadListResult | undefined,
): { readonly pinned: readonly string[]; readonly archived: readonly string[] } | undefined {
  if (result?.pinnedThreadIds === undefined || result.archivedThreadIds === undefined) {
    return undefined;
  }
  return { pinned: result.pinnedThreadIds, archived: result.archivedThreadIds };
}

/** server 回的業務失敗換成給人看的話。 */
export function explainThreadFailure(error: {
  readonly code: string;
  readonly message?: string;
}): string {
  switch (error.code) {
    case 'thread_not_found':
      return '找不到這條會話（可能已經被刪掉）。';
    case 'thread_archived':
      return '封存的會話不能釘選。';
    case 'thread_active':
      return '這條會話還在跑，先停掉它再封存。';
    case 'title_invalid':
      return error.message ?? '這個標題不合法。';
    default:
      return '這個動作沒成功。';
  }
}

/** 五個動作都回失敗的原因（講給人聽的話）；成功回 `undefined`。 */
export type ThreadActionResult = Promise<string | undefined>;

export interface ThreadManagement {
  /** 釘選的會話 id，最近釘的在前。 */
  readonly pinnedIds: readonly string[];
  readonly archivedIds: ReadonlySet<string>;
  /** server 剛受理的標題，按 id；蓋過清單上的標題，直到下一份列表（重抓）來了為止。 */
  readonly titles: ReadonlyMap<string, string>;
  readonly onPin: (threadId: string) => ThreadActionResult;
  readonly onUnpin: (threadId: string) => ThreadActionResult;
  readonly onArchive: (threadId: string) => ThreadActionResult;
  readonly onUnarchive: (threadId: string) => ThreadActionResult;
  readonly onRename: (threadId: string, title: string) => ThreadActionResult;
}

export interface ThreadSections {
  /** 釘選的，照 `pinnedIds` 的順序（最近釘的在前）；封存的不在這裡。 */
  readonly pinned: readonly ThreadSummary[];
  /** 其餘沒封存的，保持清單原本的順序（由新到舊）。 */
  readonly rest: readonly ThreadSummary[];
  readonly archived: readonly ThreadSummary[];
}

/** 把清單切成釘選、其餘、封存三份。封存的優先：同時在兩邊的算封存（封存的不能釘）。 */
export function splitThreads(
  items: readonly ThreadSummary[],
  pinnedIds: readonly string[],
  archivedIds: ReadonlySet<string>,
): ThreadSections {
  const byId = new Map(items.map((item) => [item.threadId, item]));
  const pinned = pinnedIds.flatMap((id) => {
    const item = byId.get(id);
    return item === undefined || archivedIds.has(id) ? [] : [item];
  });
  const pinnedSet = new Set(pinned.map((item) => item.threadId));
  return {
    pinned,
    rest: items.filter((item) => !archivedIds.has(item.threadId) && !pinnedSet.has(item.threadId)),
    archived: items.filter((item) => archivedIds.has(item.threadId)),
  };
}

/** 使用者打的標題：前後空白拿掉、連續空白併成一個；空的回 `undefined`。 */
export function normalizeTitle(raw: string): string | undefined {
  const title = raw.replace(/\s+/g, ' ').trim();
  return title === '' ? undefined : title;
}
