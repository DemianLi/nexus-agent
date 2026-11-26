/**
 * `<nexus-chat>` 的 `context`（#2366，地圖 #2365 第 7 點）：宿主頁目前選取的東西。它是**資料不是指令**：使用者可能選了某台設備
 * 卻在問別台，所以交給模型時要寫成「畫面上目前選取 X」。畫成標籤，送出時放進 `run.start` 的 `context`（#2382，wire 的 `PageContext`）；
 * 交給模型的措辭在 server 那一側（`@nexus/core` 的 `page-context.ts`）。
 *
 * @module
 */

export interface NexusChatContext {
  /** 標籤上顯示的字，也是之後交給模型的那個名字。 */
  readonly label: string;
}

/**
 * 宿主頁給的值 → 元件用的形狀。不全是空白的字串當成標籤；物件要有不全是空白的 `label`；`null`、`undefined`、空字串是清掉。其餘的不收、講一聲，
 * 標籤維持原樣——宿主頁寫錯一次不該把使用者看得到的情境默默清掉。只有空白的 `label` server 也不收（`invalid_argument`），在這裡先擋，
 * 不然每一句都送不出去。超過長度上限的照樣收，送出時由 server 拒。
 *
 * @returns `undefined` 是清掉；`'invalid'` 是不收。
 */
export function parseContext(value: unknown): NexusChatContext | undefined | 'invalid' {
  if (value === null || value === undefined || value === '') return undefined;
  const label =
    typeof value === 'string'
      ? value
      : typeof value === 'object' && 'label' in value
        ? (value as { label: unknown }).label
        : undefined;
  if (typeof label === 'string' && label.trim() !== '') return { label };
  return 'invalid';
}
