/**
 * 「在對話裡定位」（[#1033](https://github.com/DemianLi/nexus-agent/issues/1033)）：從右側欄的觀測分頁捲到對話區的那一則。
 *
 * **找格子走 DOM，捲動走對話區自己登記的那條**：右側欄是 `SidebarInset` 的兄弟，不在 `MessageScrollerProvider` 裡，
 * 拿不到 `useMessageScroller()`。對話區每一格都帶 `data-message-id`（條目 id，見 `Transcript`），這裡用它找；
 * `Transcript` 裡有一個不畫東西的元件把 `scrollToMessage` 登記進來（{@link registerTranscriptScroller}）。
 *
 * **不能直接 `scrollIntoView`**：串流中對話區在自動捲到底（`following-bottom`），自己手動捲的位置下一格內容長出來就被它拉回去
 * （實測：1280 寬那一格始終進不了視野）。原語的 `scrollToMessage` 會把它的狀態機切到 `settling-jump`，自動捲到底才讓開。
 * 沒登記（對話區還沒掛、測試）時退回 `scrollIntoView`。捲動一律瞬間（`auto`），不做平滑。
 *
 * @module
 */

const SELECTOR = '[data-slot="message-scroller-item"]';

type ScrollToMessage = (id: string) => boolean;

let scroller: ScrollToMessage | undefined;

/** 對話區掛上時登記它的 `scrollToMessage`，卸下時用回傳的函式取消（只取消自己登記的那一份）。 */
export function registerTranscriptScroller(scrollTo: ScrollToMessage): () => void {
  scroller = scrollTo;
  return () => {
    if (scroller === scrollTo) scroller = undefined;
  };
}

/** 目標標示掛多久（毫秒）。只是靜態底色的開與關，不是動效。 */
export const LOCATED_MS = 1600;

function escapeId(id: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(id)
    : id.replace(/["\\]/g, '\\$&');
}

/** 對話區裡那一格；沒載入、或那一則畫不出來（`Entry` 回 `null`）就是 `undefined`。 */
export function findTranscriptItem(id: string): HTMLElement | undefined {
  return (
    document.querySelector<HTMLElement>(`${SELECTOR}[data-message-id="${escapeId(id)}"]`) ??
    undefined
  );
}

type ExpandRun = (entryId: string) => boolean;

let expander: ExpandRun | undefined;

/**
 * 對話區登記「把含有這一則的那一段收起來的工具呼叫展開」（#1309，`components/tool-run.tsx`）：展開要**同步畫出來**
 * （`flushSync`），回傳那一則是不是在某一段裡。卸下時用回傳的函式取消。
 */
export function registerRunExpander(expand: ExpandRun): () => void {
  expander = expand;
  return () => {
    if (expander === expand) expander = undefined;
  };
}

/**
 * 找那一格；它收在一段工具呼叫裡（#1309）就先展開那一段再找。只在使用者按下去的那一刻呼叫（展開會同步重畫）。
 * 找不到（沒載入、畫不出來）是 `undefined`。
 */
export function findOrExpandTranscriptItem(id: string): HTMLElement | undefined {
  const found = findTranscriptItem(id);
  if (found !== undefined) return found;
  return expander?.(id) === true ? findTranscriptItem(id) : undefined;
}

/** 這一格被標示的計時器：同一格連按不疊，換一格就收掉上一格。 */
let marked: { item: HTMLElement; timer: ReturnType<typeof setTimeout> } | undefined;

function mark(item: HTMLElement): void {
  if (marked !== undefined) {
    clearTimeout(marked.timer);
    marked.item.removeAttribute('data-located');
  }
  item.setAttribute('data-located', '');
  marked = {
    item,
    timer: setTimeout(() => {
      item.removeAttribute('data-located');
      marked = undefined;
    }, LOCATED_MS),
  };
}

/** 捲到那一格並標示它（焦點另外給，見 {@link focusTranscriptItem}）。 */
export function revealTranscriptItem(item: HTMLElement): void {
  const id = item.getAttribute('data-message-id');
  if (id === null || scroller?.(id) !== true) {
    item.scrollIntoView?.({ block: 'center', behavior: 'auto' });
  }
  mark(item);
}

/**
 * 把焦點交給那一格：1024 以下收掉抽屜之後焦點會丟，由抽屜關掉時還（`right-sidebar.tsx` 的 `onCloseAutoFocus`）。
 * 那一格不是互動元件，所以給 `tabindex="-1"`，只能用程式聚焦、不進 Tab 順序。
 */
export function focusTranscriptItem(item: HTMLElement): void {
  if (!item.isConnected) return;
  if (!item.hasAttribute('tabindex')) item.setAttribute('tabindex', '-1');
  item.focus({ preventScroll: true });
}
