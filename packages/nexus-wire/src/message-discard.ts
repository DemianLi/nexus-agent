/**
 * 「這則回覆作廢」上線的形狀（[#520](https://github.com/DemianLi/nexus-agent/issues/520)）。
 *
 * **這一份只是契約**：型別與折疊形狀。**沒有 harness 的生產者**——中段出錯的串流重試（#520）落地時由 pump 送。
 *
 * 要解的事：一則回覆吐了一半才出錯、重試後第二次成功，線上會是兩則並存，第一則沒有 `message-finish`、也沒有任何作廢記號。
 * 畫面不知道該把第一則擦掉。載體是協定的 `custom` 事件，`data.name` 是 {@link MESSAGE_DISCARD}。
 *
 * ## 與 dsh 的關係：dsh 沒有，為什麼做
 *
 * dsh 的串流錯誤在 step 層重試（見 #520 的決策記錄），沒有「作廢已送出的部分回覆」的線上載體。我們的 `wrapModelCall`
 * 重試夠得到串流中途，而 wire 上又已經送出去了，所以需要一顆明講的記號；形狀取最小——一個訊息 id。
 *
 * ## 折疊
 *
 * 折疊器把 `messageId` 對應的 AI 回覆**整格拿掉**（連同它的推理）。`messageId` 先比 entry 的 `messageId`（日誌記的訊息 id），
 * 再比 entry 的 `id`（串流的 `run_id`）。找不到是 no-op，重複送也是 no-op——生產端不必先確認那則還在不在畫面上。
 * 只拿掉回覆本身，**不動工具卡**：工具卡不掛在回覆底下，作廢哪些工具呼叫是生產端另外要講清楚的事（#520 落地時決定）。
 *
 * @module
 */

/** `custom` 事件的 `data.name`：這則回覆作廢了。 */
export const MESSAGE_DISCARD = 'message-discard';

/** {@link MESSAGE_DISCARD} 的 `payload`。 */
export interface MessageDiscardPayload {
  /** 作廢的那則回覆：日誌記的訊息 id，或串流的 `run_id`。 */
  readonly messageId: string;
}

// 名字→酬載表（#685）上屬於這個檔的格子，見 `custom-frame.ts`。
declare module './custom-frame.js' {
  interface CustomFramePayloads {
    [MESSAGE_DISCARD]: MessageDiscardPayload;
  }
}
