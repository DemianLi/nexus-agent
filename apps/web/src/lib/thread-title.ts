import type { ThreadSummary } from '@nexus/wire';

/**
 * 一條會話叫什麼：側欄列表、會話標頭與瀏覽器分頁標題講同一句（[#655](https://github.com/DemianLi/nexus-agent/issues/655)）。
 * 標題由 harness 推（`ConversationState.title`，#647／#649），第一句人話開跑時到；之後模型產生的標題（#650）會再推一次，
 * 後到的取代先到的。
 *
 * @module
 */

/** 產品名：瀏覽器分頁標題的後半、沒有會話標題時的全部。照 dsh `DocumentTitle` 的 `productTitle`。 */
export const PRODUCT_TITLE = 'nexus-agent';

/** 還是空白的會話。照 dsh 的 `session.new`（「新会话」），不帶時間。 */
export const BLANK_THREAD_LABEL = '新會話';

/** 有輪次，但沒有人打過字——全是目標排的。 */
export const UNTITLED_THREAD_LABEL = '（沒有人打過字：只有目標排的輪次）';

/**
 * 畫面上寫的名字：有標題寫標題；沒有的話分空白與「有輪次但沒人打過字」兩種，照講。
 * dsh 退回工作區資料夾名、再退回會話 id；我們沒有 `--workspace` 時沒得退，而且列表早就這樣講，標頭跟著講同一句。
 */
export function threadLabel(title: string | null | undefined, blank: boolean): string {
  if (title !== null && title !== undefined && title !== '') return title;
  return blank ? BLANK_THREAD_LABEL : UNTITLED_THREAD_LABEL;
}

/**
 * 會話標頭寫什麼（Q1）：同 {@link threadLabel}。**還沒連上又什麼都沒有時寫產品名**：接回一條既有的會話，歷史到之前
 * 畫面上是空的，照規則會先閃一下「新會話」再換成標題。
 */
export function headerTitle(title: string | null, blank: boolean, connected: boolean): string {
  if (!connected && blank && (title === null || title === '')) return PRODUCT_TITLE;
  return threadLabel(title, blank);
}

/** 瀏覽器分頁標題：照 dsh 「標題 — 產品名」，沒有標題就只寫產品名。 */
export function documentTitle(title: string | null): string {
  return title === null || title === '' ? PRODUCT_TITLE : `${title} — ${PRODUCT_TITLE}`;
}

/**
 * 側欄列表是打開那一刻的快照；**目前這一列**的標題以即時推來的為準（Q3），別的列維持快照。
 * 有標題就表示已經開跑過，所以一併不再算空白。要在過濾與分組之前套，搜尋與分組才吃得到新標題。
 */
export function withCurrentTitle(
  items: readonly ThreadSummary[],
  currentThreadId: string,
  title: string | null,
): readonly ThreadSummary[] {
  if (title === null || title === '') return items;
  return items.map((item) =>
    item.threadId === currentThreadId ? { ...item, title, blank: false } : item,
  );
}
