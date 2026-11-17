/**
 * 側欄一組先畫幾條（[#2960](https://github.com/DemianLi/nexus-agent/issues/2960)）：會話上萬條時，側欄不一次掛上全部的列。
 *
 * - 每組先 {@link SHOW_FIRST} 條，組尾的「顯示更多」每按一次多 {@link SHOW_STEP} 條。
 * - 一定要看得到的列（目前這條，或有狀態的：等人、在跑、跑完沒看）排在前 {@link AUTO_REVEAL_LIMIT} 條裡時，水位自動延伸到包住它；再後面的靠按。
 * - 水位由 `list.tsx` 的 `ThreadList` 持有，按搜尋字與組名記；本模組只算要畫幾條。
 *
 * @module
 */

/** 每組沒按過「顯示更多」時先畫的條數。 */
const SHOW_FIRST = 10;
/** 每按一次「顯示更多」多畫的條數。 */
const SHOW_STEP = 20;
/** 自動延伸最遠到組內第幾條；更後面的一定要看得到的列，要靠按才露出來。 */
const AUTO_REVEAL_LIMIT = 50;

/**
 * 這一組要畫前幾條。
 *
 * @param mustShow - 這一列要不要一定看得到。
 * @param expanded - 使用者按「顯示更多」之後的水位；沒按過是 `undefined`。
 * @returns 自動延伸的下界與 `expanded` 取大的，不超過 `items.length`。下界從第 {@link AUTO_REVEAL_LIMIT} 條往前找最後一條一定要看得到的列，沒有就是 {@link SHOW_FIRST}。
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
