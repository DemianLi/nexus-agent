/**
 * 封存會話在輸入區的判斷與用詞（[#633](https://github.com/DemianLi/nexus-agent/issues/633)）。
 *
 * 目前這條會話在封存集合裡，輸入框就不給送（橫幅 `components/archived-banner.tsx`）。**這是第一道，不是唯一一道**：伺服器端
 * 也擋——另一個分頁送進來、歷史重播的話，會被當成一輪「已擋下」（`lifecycle completed` 帶 `blocked`），畫面上標「已封存，這句話沒有送給模型」。
 * 兩處用詞一致，全部講「會話已封存」。
 *
 * @module
 */

/** 橫幅上的一句話。 */
export const ARCHIVED_BANNER_TEXT = '此會話已封存';

/** 橫幅上的按鈕。 */
export const ARCHIVED_RESTORE_LABEL = '取消封存';

/** 被擋下的那句話，泡泡底下的中性提示（不是錯誤，不畫紅）。 */
export const BLOCKED_HINT_TEXT = '已封存，這句話沒有送給模型';

/**
 * 目前這條會話是不是封存的。沒有管理功能（server 沒帶集合）或還沒讀到清單時回 `false`：不知道就不擋，
 * 擋的責任落回伺服器那一道。
 */
export function isArchivedThread(
  archivedIds: ReadonlySet<string> | undefined,
  threadId: string,
): boolean {
  return archivedIds?.has(threadId) ?? false;
}
