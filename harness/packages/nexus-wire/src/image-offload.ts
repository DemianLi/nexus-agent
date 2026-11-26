/**
 * 圖片因為請求的圖片額度被省略（[#1270](https://github.com/DemianLi/nexus-agent/issues/1270)，#732 第 8 項）在線上的形狀。
 *
 * 模型一次請求收得下的圖有限（型錄的 `imageBudget`）。超額時 server 把**最舊的幾張**換成佔位字、記一筆 `image/offload`，
 * 之後每次請求都沿用：**模型從此看不到那張圖**，但圖還在附件儲存裡、人還是看得到。畫面需要知道哪幾張被省略了，才能在縮圖上標出來
 * 「這張模型已經看不到了」，否則使用者會問一個模型答不出來的問題而不明白為什麼。
 *
 * ## 形狀
 *
 * - **`HumanEntry.omittedAttachments`**（`conversation.ts`）：這一句的 `attachments` 裡被省略的那幾格的**位置**（0 起算、遞增、
 *   對的是 `attachments` 陣列，不是只數圖）。沒有被省略的就不給這一格。
 * - **冷載入**：歷史的人話 `message-start` 帶 `omittedAttachments`，是整份日誌到 `throughSeq` 為止的最終狀態（含比這一頁新的 `image/offload`），
 *   翻頁拿到較舊的一頁時舊的人話已經標對了。
 * - **即時**：每記一筆 `image/offload` 送一顆 `custom` frame（{@link IMAGE_OFFLOAD}），酬載見 {@link ImageOffloadPayload}。**累加**：
 *   折疊器把 `positions` 併進那一句的 `omittedAttachments`（同一位置重複送無妨）。
 *
 * ## 認條目：`inboxId` 或 `seq`
 *
 * 同一句人話在畫面上有兩種身分：這個頁面這一次開著期間即時長出來的（`id` 是 `inbox:<件的 id>`，`inboxId` 是那一件），與從歷史載入的
 * （`id` 是 `history-<seq>`，沒有 `inboxId`）。**server 不知道這個客戶端手上的是哪一種**，所以兩個都給：`inboxId`（有才給）和
 * `seq`（日誌上那顆事件的序號）。折疊器先用 `inboxId` 找，找不到再用 `history-<seq>` 找；兩個都沒有就不動。
 *
 * ## 照 dsh
 *
 * dsh 的 `image/offload` 直接改訊息節點上的圖（`compaction-image-offload`），下行的人話泡泡看的是節點，所以不需要另外的 frame。
 * 我們的訊息住在 LangGraph state，人話泡泡是從日誌合成的，所以由 pump 合成這顆 frame；與 `title` 等同一種做法。
 *
 * @module
 */

/** `custom` 事件的 `data.name`：有幾張圖被請求的圖片額度省略了。 */
export const IMAGE_OFFLOAD = 'image-offload';

/** {@link ImageOffloadPayload} 的一項：哪一句人話的哪幾格附件。 */
export interface ImageOffloadItem {
  /** 那一句人話在日誌上的事件序號（`turn/start` 或輪中插話的 `user/message`）。歷史載入的條目靠它認（`history-<seq>`）。 */
  readonly seq: number;
  /** 即時長出來的條目靠它認（`inbox:<inboxId>`）：送出佇列那一件的 id。重啟後從日誌推出來的沒有。 */
  readonly inboxId?: string;
  /** 被省略的附件在那一句 `attachments` 裡的位置（0 起算、遞增）。 */
  readonly positions: readonly number[];
}

/** {@link IMAGE_OFFLOAD} 的 `payload`：一筆 `image/offload` 涉及的所有人話。 */
export interface ImageOffloadPayload {
  readonly items: readonly ImageOffloadItem[];
}

// 名字→酬載表（#685）上屬於這個檔的格子，見 `custom-frame.ts`。
declare module './custom-frame.js' {
  interface CustomFramePayloads {
    [IMAGE_OFFLOAD]: ImageOffloadPayload;
  }
}
