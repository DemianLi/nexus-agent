import type { ThreadSummary } from '@nexus/wire';

/**
 * 側欄的會話管理：釘選、封存、改名（[#633](https://github.com/DemianLi/nexus-agent/issues/633) 的 web 那一半）。
 *
 * **整個功能藏在一個寫死的開關後面**（{@link threadManagementEnabled}），同附件（`lib/attachments.ts` 的
 * `serverSupportsAttachments`）的做法：沒開時列的選單、「已釘選」「已封存」兩區、改名輸入都不出現，畫面與以前逐像素相同。
 * 伺服器端（釘選／封存集合與改名事件）合進 develop、`WireClient` 的五支方法接上之後，另開一張 PR 把開關改成 `true`、
 * 並把 `hooks/use-thread-management.ts` 從「只記在這個分頁」換成呼叫那五支；`not_supported` 到時整個藏起來，同模型座。
 *
 * 規則照 dsh（`workspace-controller/src/commands.ts:155-230`）：**封存的會話不能釘**（封存的那一刻它就不在釘選裡）；
 * 取消是冪等的；釘選的順序是最近釘的在前。
 *
 * @module
 */

/** 側欄有沒有釘選、封存、改名。 */
export function threadManagementEnabled(): boolean {
  return false;
}

/** 五個動作都回失敗的原因（講給人聽的話）；成功回 `undefined`。 */
export type ThreadActionResult = Promise<string | undefined>;

export interface ThreadManagement {
  /** 釘選的會話 id，最近釘的在前。 */
  readonly pinnedIds: readonly string[];
  readonly archivedIds: ReadonlySet<string>;
  /** 使用者改過的標題，按 id；蓋過清單上的標題。 */
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
