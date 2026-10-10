/**
 * `run.start` 的請求編號（[#1335](https://github.com/DemianLi/nexus-agent/issues/1335)，協定見 `docs/operations.md`
 * 「重送同一句話（請求編號）」）。
 *
 * 請求到了伺服器、回應卻斷在半路時，畫面說「沒送出去」、草稿放回輸入框，使用者會再按一次送出。帶著**同一個編號**重送，
 * 伺服器認得這一句收過了，回原本那一件的 `run_id`、不再排——模型只看到一次，收件匣也不會多一件，所以畫面不必另外對。
 *
 * **伺服器只比編號、不比內容**（照 dsh）：同編號不同文字的第二次也回原本那一件，新的字不進佇列。所以編號由這裡保證
 * **只跟同一句話走**——送出的這一句跟上次沒送出去的那一句完全相同才沿用，改了一個字、換了點名、增減了附件都是新的一句、
 * 新的編號。不然人改過字再送，而第一次其實已經到了，改過的字就會無聲無息地被丟掉。
 */

/** 上次沒送出去的那一句，和它用過的編號。 */
export interface PendingRequest {
  readonly id: string;
  readonly sentence: Sentence;
}

/**
 * 判斷「同一句話」看的東西。
 *
 * - `text` 比 trim 過的：送出時本來就 trim（`use-conversation.ts` 的 `send`）。
 * - `attachmentIds` 比草稿附件的 id，**不比送出時準備好的收據**：重送會重新上傳，收據每次都不一樣。
 * - **不看 `mode`**（排隊或插話）：說的是同一句話，只是要它何時送進模型。第一次其實已經到了的話，伺服器回原本那一件，
 *   它照第一次的方式排著或插著。
 */
export interface Sentence {
  readonly text: string;
  /** 點名派的子代理名字；沒點名是 `undefined`。 */
  readonly mention: string | undefined;
  readonly attachmentIds: readonly string[];
}

/**
 * 一個新的請求編號：UUID v4 的字串形狀，36 個字元，遠低於 `REQUEST_ID_MAX_LENGTH`。
 *
 * 用 `crypto.getRandomValues` 自己排，不用 `crypto.randomUUID`：後者只在安全環境（HTTPS、localhost）有，內網用 IP 開的
 * `http://` 頁面上它是 `undefined`，送出會直接拋錯。
 */
export function newRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 這一句要帶的編號：跟上次沒送出去的那一句相同就沿用它的，否則是新的。 */
export function requestIdFor(pending: PendingRequest | undefined, sentence: Sentence): string {
  return pending !== undefined && sameSentence(pending.sentence, sentence)
    ? pending.id
    : newRequestId();
}

function sameSentence(a: Sentence, b: Sentence): boolean {
  return (
    a.text.trim() === b.text.trim() &&
    a.mention === b.mention &&
    a.attachmentIds.length === b.attachmentIds.length &&
    a.attachmentIds.every((id, index) => id === b.attachmentIds[index])
  );
}
