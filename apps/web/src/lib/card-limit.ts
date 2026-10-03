/**
 * diff 卡與搜尋卡的畫面字元上限（[#961](https://github.com/DemianLi/nexus-agent/issues/961)）。
 *
 * 這兩種專屬卡的列是 `whitespace-pre-wrap`＋`wrap-anywhere`，**單列超長時點開的成本隨長度超線性成長**：
 * 一行 527KB 的連續中文，diff 卡點開要 105 秒、搜尋卡 66 秒；「字＋127 空白」約 0.5／0.9 秒。
 * 傳輸上的上限擋不住它：搜尋 meta 「至少留一項」、write_file 新建檔的 diff 是從參數算的，兩條都沒有大小上限。
 * 列數上限（{@link MAX_RENDERED_LINES}）也管不到，那是管列數、不管每列多長。
 *
 * 所以跟 #950（結果）、#958（參數）一樣在畫面上再加兩道，只動畫面、模型看到的不變：
 *
 * - **每列** 最多 {@link CARD_LINE_MAX_CHARS} 字元，超過的取頭尾各半、中間一句講沒畫多少字（`clipMiddle`）。
 * - **整張卡** 展開後所有列加起來最多 {@link CARD_MAX_CHARS} 字元（每列最多算 {@link CARD_LINE_MAX_CHARS}），
 *   超過的列不畫。短列的大檔（5000 列各二十幾字）也靠這一道收，不只長列。
 *
 * @module
 */

/** 一列最多畫幾個字元（UTF-16 單位）。 */
export const CARD_LINE_MAX_CHARS = 2_000;

/** 一張卡展開後最多畫幾個字元；跟 `OUTPUT_MAX_CHARS`、`INPUT_MAX_CHARS` 同值。 */
export const CARD_MAX_CHARS = 20_000;

/**
 * 從頭數起，累計畫出來的字元（每列最多算 `lineMax`）不超過 `totalMax` 的話能畫幾列。
 * 第一列一定畫（空陣列除外），不讓一張卡因為第一列太長而什麼都沒有。
 *
 * @param rows - 展開後要畫的全部列。
 * @param weigh - 一列的字元數。
 * @param lineMax - 一列最多算幾字元。
 * @param totalMax - 整張卡最多幾字元。
 * @returns 要畫的前幾列。
 */
export function fitRowCount<T>(
  rows: readonly T[],
  weigh: (row: T) => number,
  lineMax: number = CARD_LINE_MAX_CHARS,
  totalMax: number = CARD_MAX_CHARS,
): number {
  let used = 0;
  for (let index = 0; index < rows.length; index += 1) {
    used += Math.min(weigh(rows[index] as T), lineMax);
    if (used > totalMax) return Math.max(index, 1);
  }
  return rows.length;
}
