/**
 * `<nexus-chat>` 的 `context`（#2366，地圖 #2365 第 7 點）：宿主頁目前選取的東西。它是**資料不是指令**：使用者可能選了某台設備
 * 卻在問別台，所以交給模型時要寫成「畫面上目前選取 X」。目前只收值、畫成標籤，不送出；TODO(#2367)：交給模型的措辭與 wire 欄位。
 *
 * @module
 */

export interface NexusChatContext {
  /** 標籤上顯示的字，也是之後交給模型的那個名字。 */
  readonly label: string;
}

/**
 * 宿主頁給的值 → 元件用的形狀。字串當成標籤；物件要有非空的 `label`；`null`、`undefined`、空字串是清掉。其餘的不收、講一聲，
 * 標籤維持原樣——宿主頁寫錯一次不該把使用者看得到的情境默默清掉。
 *
 * @returns `undefined` 是清掉；`'invalid'` 是不收。
 */
export function parseContext(value: unknown): NexusChatContext | undefined | 'invalid' {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'string') return { label: value };
  if (typeof value === 'object' && 'label' in value) {
    const label = (value as { label: unknown }).label;
    if (typeof label === 'string' && label !== '') return { label };
  }
  return 'invalid';
}
