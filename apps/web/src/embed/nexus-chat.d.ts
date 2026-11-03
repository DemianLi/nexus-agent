// `<nexus-chat>` 給宿主頁用的型別（#2366）。serve 跟 `embed.js` 一起供應這一份（`/nexus-chat.d.ts`），宿主頁的專案把它放進
// `tsconfig` 的 `include` 就有元素的型別。接入說明見 `docs/embed-chat.md`。這裡也是 web 自己的型別：
// `nexus-chat-element.tsx` 的實作 `implements` 這個介面，形狀對不上 typecheck 就不過。

/** 宿主頁目前選取的東西，畫成元件裡的情境標籤。 */
interface NexusChatContext {
  readonly label: string;
}

/** 宿主頁宣告的一支工具（#2374）。只收這三格。 */
interface NexusHostTool {
  /** 合 `^[a-z][a-z0-9_]{0,31}$`，同一份裡不重名。模型看到的是 `page__` 加上它。 */
  readonly name: string;
  /** 給模型看的說明，非空，至多 500 字。 */
  readonly description: string;
  /** 參數的 JSON Schema，`type: 'object'`，序列化後至多 4 KiB。 */
  readonly parameters: { readonly type: 'object'; readonly [keyword: string]: unknown };
}

/** `nexus-host-tool` 事件的 `detail`：模型叫了哪一支、帶什麼參數，執行完呼叫 `respond` 或 `fail`，只算第一次。 */
interface NexusHostToolDetail {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  /** 成功，交回結果（JSON 值，序列化後至多 4,000 字）。 */
  respond(result: unknown): void;
  /** 失敗，交回原因。 */
  fail(error: string): void;
}

interface NexusChatElementEventMap extends HTMLElementEventMap {
  'nexus-host-tool': CustomEvent<NexusHostToolDetail>;
}

interface NexusChatElement extends HTMLElement {
  /**
   * 情境：字串或 `{ label }`，`null` 清掉。讀回來一律是 `{ label }` 或 `null`。寫錯的值不收、console 講一聲，標籤維持原樣。
   * 元素升級（`embed.js` 載入）之前就設好的也收得到。
   */
  get context(): NexusChatContext | null;
  set context(value: NexusChatContext | string | null | undefined);
  /**
   * 宿主頁工具（#2374）：每一句送出時附上當下的這份，至多 8 支、整份序列化後至多 16 KiB。`null` 或空陣列清掉。超過上限或形狀不對的
   * 不收、console 講一聲，原本的不動。模型叫到時元素發 `nexus-host-tool`；30 秒沒交回就當失敗。升級之前就設好的也收得到。
   */
  get hostTools(): readonly NexusHostTool[] | null;
  set hostTools(value: readonly NexusHostTool[] | null | undefined);
  addEventListener<K extends keyof NexusChatElementEventMap>(
    type: K,
    listener: (this: NexusChatElement, event: NexusChatElementEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<K extends keyof NexusChatElementEventMap>(
    type: K,
    listener: (this: NexusChatElement, event: NexusChatElementEventMap[K]) => unknown,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
}

interface HTMLElementTagNameMap {
  'nexus-chat': NexusChatElement;
}
