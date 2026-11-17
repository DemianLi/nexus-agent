/**
 * 側欄一組先畫幾條（[#2960](https://github.com/DemianLi/nexus-agent/issues/2960)）：會話上萬條時，側欄不一次掛上全部的列。
 *
 * - 每組先 {@link SHOW_FIRST} 條，組尾的「顯示更多」每按一次多 {@link SHOW_STEP} 條。
 * - 一定要看得到的列（需要人注意的、目前這條）排在前 {@link AUTO_REVEAL_LIMIT} 條裡時，水位自動延伸到包住它；再後面的靠按。
 * - 水位不記住：清單卸掉（側欄收起）或換了搜尋字就回到起點，由呼叫方決定狀態放哪。
 *
 * 時間組、搜尋結果、已封存都照這一套；釘選區不設上限，不經過這裡。
 *
 * @module
 */

export const SHOW_FIRST = 10;
export const SHOW_STEP = 20;
export const AUTO_REVEAL_LIMIT = 50;

/**
 * 這一組要畫前幾條。
 *
 * @param mustShow - 這一列要不要一定看得到。
 * @param expanded - 使用者按「顯示更多」之後的水位；沒按過是 `undefined`。
 */
export function shownCount<T>(
  items: readonly T[],
  mustShow: (item: T) => boolean,
  expanded: number | undefined,
): number {
  let floor = SHOW_FIRST;
  for (let index = Math.min(items.length, AUTO_REVEAL_LIMIT) - 1; index >= SHOW_FIRST; index -= 1) {
    if (mustShow(items[index]!)) {
      floor = index + 1;
      break;
    }
  }
  return Math.min(items.length, Math.max(floor, expanded ?? 0));
}

/** 按一次「顯示更多」後的水位：從畫面上現在的條數往下多 {@link SHOW_STEP} 條。 */
export function showMore(shown: number): number {
  return shown + SHOW_STEP;
}
