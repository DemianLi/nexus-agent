/**
 * 提問選項的「（推薦）」字尾（[#1306](https://github.com/DemianLi/nexus-agent/issues/1306)）。
 *
 * 字尾是模型寫進標籤的：ask-user 插件要模型「你有推薦的就放第一個，並在標籤後面加上『（推薦）』」
 * （`docs/tool-catalog.md` 的 `ask_user_question`）。web 只把它從畫面上的文字拆出來畫成小標，**送出的值仍是整個標籤**——
 * 模型拿回來比對的是它自己寫的那串字。
 *
 * 半形括號也認：模型不一定照抄全形。
 */

/** 插件要模型加的那個字尾。 */
export const RECOMMENDED_SUFFIX = '（推薦）';

/** 小標上的字。 */
export const RECOMMENDED_BADGE = '推薦';

const SUFFIX = /\s*[（(]推薦[)）]\s*$/;

/** 標籤拆成「顯示的字」與「是不是推薦」。拆完沒字（整個標籤就是「（推薦）」）就不拆。 */
export function splitRecommended(label: string): { text: string; recommended: boolean } {
  const text = label.replace(SUFFIX, '');
  return text === label || text.trim() === ''
    ? { text: label, recommended: false }
    : { text, recommended: true };
}
