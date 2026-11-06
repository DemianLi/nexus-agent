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
  /**
   * 這次呼叫的身分，重新整理後補發同一次呼叫時不變。補發不會再出核准卡，不能重做的動作，宿主頁要以它記住做過了沒有。
   */
  readonly id: string;
  /** 宣告時的名字，不帶 `page__`。 */
  readonly name: string;
  /** 模型給的參數，server 已照宣告的 `parameters` 驗過。 */
  readonly args: Readonly<Record<string, unknown>>;
  /** 成功，交回結果（JSON 值，序列化後至多 4,000 字）。 */
  respond(result: unknown): void;
  /** 失敗，交回原因。 */
  fail(error: string): void;
}

/** `signIn` 失敗時 reject 的錯誤。`code` 之外的格子給人看，不要拿來判斷。 */
interface NexusSignInError extends Error {
  readonly name: 'NexusSignInError';
  /**
   * - `ticket_invalid`：票不存在或已經用過（一張票只能兌換一次）；
   * - `ticket_expired`：票過期了；
   * - `identity_rejected`：這位使用者不在 serve 的身分對應表上，或對應被撤掉了；
   * - `sign_in_failed`：其他失敗，例如票不是非空字串（不發請求）、網路斷了、serve 沒開換票、回應看不懂。
   */
  readonly code: 'ticket_invalid' | 'ticket_expired' | 'identity_rejected' | 'sign_in_failed';
  /** HTTP 狀態碼；請求沒有送到就沒有。 */
  readonly status?: number;
}

/**
 * `nexus-ticket-needed` 事件的 `detail`（#2370）：該換一張新票，交回 `signIn`。事件發在元素上、不 bubble；兩次 `signIn` 成功之間只發一次。
 */
interface NexusTicketNeededDetail {
  /**
   * - `expiring`：到期前 60 秒（照 serve 的時鐘）；
   * - `unauthorized`：請求被 401 擋下，例如 cookie 已經過期、被撤掉，或還沒換過票。
   */
  readonly reason: 'expiring' | 'unauthorized';
  /** `expiring` 才有：目前這顆 cookie 的到期時間，同 `signIn` resolve 的那個。 */
  readonly expiresAt?: number;
}

interface NexusChatElementEventMap extends HTMLElementEventMap {
  'nexus-host-tool': CustomEvent<NexusHostToolDetail>;
  'nexus-ticket-needed': CustomEvent<NexusTicketNeededDetail>;
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
   * 不收、console 講一聲，原本的不動。模型叫到時元素發 `nexus-host-tool`；沒在期限內交回就當失敗（預設 30 秒，營運者在 serve 的
   * `host-tools` 設定 `timeoutMs`）。升級之前就設好的也收得到。
   */
  get hostTools(): readonly NexusHostTool[] | null;
  set hostTools(value: readonly NexusHostTool[] | null | undefined);
  /**
   * 換票登入（#2370）：拿宿主系統後端換來的一次性登入票兌換嵌入 cookie。成功時回 cookie 的到期時間（系統時間的毫秒時間戳），
   * 對話改接這位使用者這一次登入最新開的那一條，沒有就開新的；同一個人續期（serve 認得是同一個嵌入方＋使用者代號）就留在畫面上這一條。
   * 失敗時 reject {@link NexusSignInError}，畫面不動。
   * 元素放進頁面之前或之後呼叫都可以；要走換票就在放進頁面之前呼叫，否則放進去的那一刻會先照主機擁有者的方式接上一條。
   */
  signIn(ticket: string): Promise<{ readonly expiresAt: number }>;
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
