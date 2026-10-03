/**
 * diff 卡、搜尋卡與讀檔卡的畫面字元上限（[#961](https://github.com/DemianLi/nexus-agent/issues/961)、
 * [#980](https://github.com/DemianLi/nexus-agent/issues/980)）。
 *
 * 這幾種專屬卡的列是 `whitespace-pre-wrap`＋`wrap-anywhere`，**單列超長時點開的成本隨長度超線性成長**：
 * 一行 527KB 的連續中文，diff 卡點開要 105 秒、搜尋卡 66 秒；「字＋127 空白」約 0.5／0.9 秒。
 * 傳輸上的上限擋不住它：搜尋 meta「至少留一項」（`capToolResultMeta`），write_file 新建檔的 diff 是從參數算的，
 * 兩條都沒有大小上限。列數上限（{@link MAX_RENDERED_LINES}）也管不到：它管列數、不管每列多長，
 * 而幾千列各二十幾字的短列在 5,000 列時也要 131ms 且有長任務。
 *
 * 所以跟 #950（結果）、#958（參數）一樣在畫面上再加兩道，只動畫面、模型看到的不變：
 *
 * - **每列** 最多 {@link CARD_LINE_MAX_CHARS} 字元，超過的取頭尾各半、中間一句講沒畫多少字（`clipMiddle`）。
 * - **整張卡** 展開後所有列加起來最多 {@link CARD_MAX_CHARS} 字元（每列最多算 {@link CARD_LINE_MAX_CHARS}），
 *   超過的列不畫、底下寫「只顯示前 N 行」。
 *
 * **登記的偏離**：dsh 的 `DiffBlock`、`SearchBlock` 預設 `white-space: pre`＋橫向捲動、不截字（換行是選項：
 * `DiffBlock.module.css` 的 `data-code-wrap`、`SearchBlock.module.css` 的 `.line`，master `ec48669`），所以沒有這個問題；
 * 我們的卡一開始就選了自動換行，成本出在換行。這裡不退回橫向捲動（那是 UI 形狀的改變，不是這張卡的事），
 * 沿用 #950、#958 已登記的做法在畫面上截。讀檔卡同理（dsh `ReadBlock.module.css` 預設 `white-space: pre`，`data-code-wrap` 才換行，
 * dsh master `5badb15009a`）。
 *
 * **讀檔卡只收每列、不收整張卡**（#980）：一頁最多 100,000 位元組的 meta 擋住了總量，單列連續中文最多約 33,000 字
 * （超過就整格不給、改走通用卡），那一列點開約 99–105ms 且有長任務，每列 {@link CARD_LINE_MAX_CHARS} 之後回到地板。
 *
 * **上限值怎麼挑**（#961 實測：`serve`＋假 OpenAI 模型＋headless Chrome，點開前等 1.5 秒，點開到兩個 rAF，
 * 地板約 48ms；每格 3 次中位數，ms）：
 *
 * | 整張卡 | ASCII 24 字短列（write_file）展開 | 中文 24 字短列（write_file）展開 | 60 列各 10,000 中文，展開 |
 * |---|---|---|---|
 * | 20,000 | 48（870 列） | — | 45（10 列） |
 * | **40,000** | 49（1,739 列） | **81**（2,222 列） | 41（20 列） |
 * | 60,000 | 81（2,609 列） | 118＋長任務（3,333 列） | 41（30 列） |
 * | 80,000 | 98（3,478 列） | 156＋2 個長任務（4,444 列） | — |
 *
 * 最壞是中文短列（每個字都是斷行點）：40,000 是它仍在約 100ms 內、沒有長任務的最大值，所以取它。
 * 每列 2,000 是人眼的上限（換行後約 28 個畫面列），不是效能的上限：改成 4,000，收著畫 9 列各 4,000 中文的
 * 那一格從 50ms 變 65ms（IQR 60–72），仍沒有長任務。收著最多畫 9 列（`CHAT_DIFF_MAX_LINES`），
 * 9 × {@link CARD_LINE_MAX_CHARS} 要在 {@link CARD_MAX_CHARS} 之內。
 *
 * **這兩道壓不住的，靠字型堆疊解**（[#979](https://github.com/DemianLi/nexus-agent/issues/979)）：堆疊裡沒有字型涵蓋的符號
 * （旗、☺、❤、⚠️ 之類）要走系統字型回退，成本跟字元上限無關，分兩段——每個新頁面第一次遇到約 40ms（🏳️‍🌈 約 75ms），
 * 以及不帶 VS16 的裸旗 U+1F3F3 每含它的**一列**約 1.6–2.6ms（與列長無關，20 字與 2,000 字一樣）。`--font-mono` 尾端明寫
 * 三個平台的 emoji 字型（`index.css`）之後兩段都回到地板，畫面逐像素相同。`--font-sans` 補了沒有效果，所以內文沒改。
 *
 * @module
 */

/** 一列最多畫幾個字元（UTF-16 單位）。 */
export const CARD_LINE_MAX_CHARS = 2_000;

/** 一張卡展開後最多畫幾個字元（UTF-16 單位）。 */
export const CARD_MAX_CHARS = 40_000;

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
