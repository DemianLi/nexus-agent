// `<nexus-chat>` 給宿主頁用的型別（#2366）。serve 跟 `embed.js` 一起供應這一份（`/nexus-chat.d.ts`），宿主頁的專案把它放進
// `tsconfig` 的 `include` 就有元素的型別。接入說明見 `docs/embed-chat.md`。這裡也是 web 自己的型別：
// `nexus-chat-element.tsx` 的實作 `implements` 這個介面，形狀對不上 typecheck 就不過。

/** 宿主頁目前選取的東西，畫成元件裡的情境標籤。 */
interface NexusChatContext {
  readonly label: string;
}

interface NexusChatElement extends HTMLElement {
  /**
   * 情境：字串或 `{ label }`，`null` 清掉。讀回來一律是 `{ label }` 或 `null`。寫錯的值不收、console 講一聲，標籤維持原樣。
   * 元素升級（`embed.js` 載入）之前就設好的也收得到。
   */
  get context(): NexusChatContext | null;
  set context(value: NexusChatContext | string | null | undefined);
}

interface HTMLElementTagNameMap {
  'nexus-chat': NexusChatElement;
}
