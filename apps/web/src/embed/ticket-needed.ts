/**
 * `nexus-ticket-needed`（[#2370](https://github.com/DemianLi/nexus-agent/issues/2370)）：嵌入 cookie 快到期、或請求被 401 擋下時，
 * 告訴宿主頁該換一張新票、經 `signIn()` 交回。
 *
 * - **一輪只發一次**：一輪是兩次 `signIn` 成功之間（還沒換過票也算一輪）。兩種原因合起來只發一次，下一次 `signIn` 成功才重來。
 *   宿主頁換票失敗時 `signIn` 會 reject，不靠再發一次事件。
 * - **快到期**：到期前 {@link TICKET_RENEW_LEAD_MS} 發。`expiresAt` 是 serve 的時鐘，所以拿 serve 的時間比（`lib/server-clock.ts`），
 *   還沒有樣本才用瀏覽器的。已經過了提前的那一刻就馬上發。
 * - 元素不在頁面上時計時暫停，放回去再照當下的時間重算。
 *
 * @module
 */

export const TICKET_NEEDED_EVENT = 'nexus-ticket-needed';

/** 到期前多久發 `expiring`：留給宿主頁的後端換一張票、再兌換一次。 */
export const TICKET_RENEW_LEAD_MS = 60_000;

/** `setTimeout` 收得下的最長延遲；再長會被當成 0 馬上跑。 */
const MAX_DELAY_MS = 2 ** 31 - 1;

/** 給宿主頁的形狀在 `nexus-chat.d.ts`，這裡取同一份。 */
export type NexusTicketNeededDetail = globalThis.NexusTicketNeededDetail;

export class TicketWatch {
  readonly #dispatch: (detail: NexusTicketNeededDetail) => void;
  readonly #now: () => number;
  #fired = false;
  #expiresAt: number | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running = false;

  constructor(dispatch: (detail: NexusTicketNeededDetail) => void, now: () => number) {
    this.#dispatch = dispatch;
    this.#now = now;
  }

  /** `signIn` 成功：開新的一輪，照新的到期時間重新計時。 */
  signedIn(expiresAt: number): void {
    this.#fired = false;
    this.#expiresAt = expiresAt;
    this.#arm();
  }

  /** 請求被 401 擋下。 */
  unauthorized(): void {
    this.#fire({ reason: 'unauthorized' });
  }

  /** 元素放進頁面。 */
  resume(): void {
    this.#running = true;
    this.#arm();
  }

  /** 元素拿掉。 */
  pause(): void {
    this.#running = false;
    this.#clear();
  }

  #arm(): void {
    this.#clear();
    const expiresAt = this.#expiresAt;
    if (!this.#running || this.#fired || expiresAt === undefined) return;
    const delay = expiresAt - TICKET_RENEW_LEAD_MS - this.#now();
    this.#timer = setTimeout(
      () => {
        if (delay > MAX_DELAY_MS) this.#arm();
        else this.#fire({ reason: 'expiring', expiresAt });
      },
      Math.min(Math.max(delay, 0), MAX_DELAY_MS),
    );
  }

  #clear(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #fire(detail: NexusTicketNeededDetail): void {
    if (this.#fired) return;
    this.#fired = true;
    this.#clear();
    this.#dispatch(detail);
  }
}
