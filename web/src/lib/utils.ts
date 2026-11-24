import { createCn } from 'cn/config';

/**
 * 全站唯一的 `cn`（class 合併）。**不要直接 `from 'cn'`**：預設的 `cn` 不認得我們自訂的字級名，
 * 會把 `text-body`、`text-tip` 當成文字顏色，跟同串裡的 `text-primary-foreground` 之類互相吃掉
 * （[#1141](https://github.com/DemianLi/nexus-agent/issues/1141) 把 `text-sm` 換成 `text-body` 之後，預設按鈕的字級就這樣不見了）。
 *
 * 這裡的字級名與圓角名（`row`）要跟 `index.css` `@theme` 的 `--text-*`、`--radius-row` 一致；`utils.test.ts` 會逐個對字級。
 */
export const cn = createCn({
  extend: { theme: { text: ['ui', 'body', 'tip', 'micro'], radius: ['row'] } },
});
