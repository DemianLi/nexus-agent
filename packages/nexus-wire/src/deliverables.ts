/**
 * 交付事件上線的形狀（[#441](https://github.com/DemianLi/nexus-agent/issues/441)）。
 *
 * 載體是協定的 `custom` 事件：`method: 'custom'`，`data: { name, payload }`（`@langchain/protocol`
 * 的 `CustomEvent`）。`name` 是 {@link DELIVERABLES_PRESENTED}，`payload` 是 {@link DeliverablesPresentedPayload}。
 * 即時由 pump 從 root 那一份日誌的 `deliverables/presented` 合成，重新整理由歷史路由從同一顆事件合成，
 * 兩條路產出同一種 frame。**只有 root 那一份**：子代理宣告的交付留在子代理的日誌裡，兩條路都不送。
 *
 * 這裡只放形狀——`@nexus/wire` 不相依 `@nexus/core`，所以 `PresentedFile` 在這裡另寫一份，兩份的
 * 欄位要一樣（core 那份是 `SessionEventMap['deliverables/presented']`）。
 *
 * @module
 */

/** `custom` 事件的 `data.name`：一次成功的 `present` 宣告交付了這幾個檔案。 */
export const DELIVERABLES_PRESENTED = 'deliverables/presented';

/** 一個宣告交付的檔案，模型給的原樣。 */
export interface WirePresentedFile {
  /** 相對路徑以工作區根為準。前端不解析它。 */
  readonly path: string;
  /** 給使用者的一句說明。沒給就沒有這個 key。 */
  readonly description?: string;
}

/**
 * `custom` 事件 `data.payload` 的形狀。
 *
 * **沒有輪的編號**：這一顆屬於它在串流裡落在的那一輪（即時與歷史的順序一樣），見 core 的
 * `SessionEventMap['deliverables/presented']`。
 */
export interface DeliverablesPresentedPayload {
  /** 那次 `present` 呼叫的 `tool_call_id`，對得上同一輪那張 `present` 工具卡。 */
  readonly callId: string;
  /**
   * 那顆 `deliverables/presented` 在 root 日誌裡的 `seq`（[#452](https://github.com/DemianLi/nexus-agent/issues/452)）。
   *
   * **它是座標，不是編號**：`(seq, index)` 一起指名「那一次交付宣告的第 index 個檔」，`index` 是它在
   * {@link DeliverablesPresentedPayload.files} 裡的位置。照 dsh 的 `handlePresentOpen`——那條路由也不收
   * 路徑輸入，只收座標，所以路徑遍歷在形狀上就不可能發生。
   *
   * `callId` 取代不了它：`callId` 認得出是哪一次呼叫，但日誌那側要的是「哪一顆事件」。
   */
  readonly seq: number;
  /** 通過檢查的檔案，順序照模型給的。 */
  readonly files: readonly WirePresentedFile[];
}

/**
 * 一個交付檔在 server 上的身分，照 dsh 的 `statOf`
 * （`packages/api/workspace-files/src/index.ts:448-454`，`ddefc45`）。
 *
 * **不回 `absolutePath`，這是一條偏離。** dsh 那一格是給它的「在 Host 上開啟」用的——瀏覽器拿著
 * 主機絕對路徑去叫 `present.open`。我們不做那個動作（#452 的背景：多人共用的遠端主機，在那裡開檔
 * 使用者看不到），所以那一格在我們這裡沒有消費者，而它會把工作區的佈局講給瀏覽器聽。改回
 * {@link DeliverableFileStat.path}：模型宣告時給的原字串，前端本來就拿它當標籤。
 */
export interface DeliverableFileStat {
  /** 模型宣告當下給的那個字串，原樣。前端不解析它（同 {@link WirePresentedFile.path}）。 */
  readonly path: string;
  /** 這一次 stat 拍到的新鮮度標記，**不解析**，同 dsh 的 `version`。同值即同一份內容。 */
  readonly version: string;
  /** 完整檔案的位元組數。 */
  readonly bytes: number;
}

/**
 * 預覽路由的結果：從一份文字檔切出來的一頁。
 *
 * **頁的上限是拒絕，不是截斷**（dsh `Config.maxBytes` 的理由逐字：「a silently cut page reads as the
 * whole page」）。所以超標時這個結果不會出現，出現的是 413。**檔案本身沒有大小上限**——呼叫端翻頁，
 * 同 dsh。
 */
export interface DeliverableFilePage extends DeliverableFileStat {
  /** 這一頁從第幾行起，0 起算。 */
  readonly offset: number;
  /** 這一頁的內容，**不帶行號**（dsh 的 `read` 也不帶；行號是基座 `read` 的形狀，不是路由的）。 */
  readonly text: string;
  /** `text` 裡的行數；整頁都在最後一行之後時是 0。 */
  readonly lines: number;
  /** 這一頁碰到檔尾了。 */
  readonly eof: boolean;
}

/**
 * 預覽一個宣告過的交付檔，`GET`，帶 `?seq=&index=`，選配 `?offset=&limit=`。
 *
 * **只收座標，不收路徑**，照 dsh 的 `handlePresentOpen`——路徑遍歷在形狀上就不可能發生。
 * 座標的意義見 {@link DeliverablesPresentedPayload.seq}。
 *
 * 錯誤協定照隔壁 `changes` 兩條（裸 status ＋純文字 ＋`cache-control: no-store`），而狀態碼**要分得出
 * 前端該做什麼**：400 座標不對；404 這台 server 錨不住這顆座標、或檔不在、或不是一般檔；
 * 413 **這一頁**超過頁的位元組上限（整檔沒有上限，串流分頁，
 * [#544](https://github.com/DemianLi/nexus-agent/issues/544)）；**422 不是文字**——這一頁含 NUL 位元組、
 * 或讀到不是 UTF-8 的位元組，照 dsh（前端改提供下載）。
 *
 * **不是 415**：那個碼這條線上已經在講「請求沒帶 `content-type: application/json`」，壓在一起
 * 前端就分不出「我忘了帶 header」與「這個檔是二進位」。
 *
 * @param threadId - thread id，就是 root 會話的 id。
 * @returns 路徑。
 */
export function deliverableFilePath(threadId: string): string {
  return `/threads/${encodeURIComponent(threadId)}/deliverables/file`;
}

/**
 * 下載一個宣告過的交付檔，`GET`，帶 `?seq=&index=`。回的是**原始位元組**
 * （`application/octet-stream` ＋ `content-disposition: attachment`）。
 *
 * **回原始位元組而不是 base64，是一條偏離。** dsh 的 `readAll` 回 base64 是因為它的載體是 RPC、
 * 帶不動位元組；我們的載體是 HTTP，原始位元組就是同一件事在這個載體上的講法，而 base64 會讓每一份
 * 下載多三分之一。
 *
 * **它跟這條線上每一條 `GET` 一樣要帶 `content-type: application/json`**（理由見 `THREADS_PATH`：
 * 那個 header 是閘門，擋的是不發 preflight 的跨來源 simple request）。**所以下載不能用
 * `<a download>`**——那種連結設不了 header。前端要 `fetch` 成 blob 再存。這是契約的一部分，
 * 不是實作建議：拿掉那道閘門才能用 `<a download>`，而那會把閘門本身挖掉。
 *
 * 上限是 `maxFileBytes`，超標回 413（**拒絕，不截斷**，同 dsh）。
 *
 * @param threadId - thread id，就是 root 會話的 id。
 * @returns 路徑。
 */
export function deliverableDownloadPath(threadId: string): string {
  return `/threads/${encodeURIComponent(threadId)}/deliverables/download`;
}
