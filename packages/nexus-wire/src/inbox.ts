/**
 * 送出佇列上線的形狀（[#637](https://github.com/DemianLi/nexus-agent/issues/637)）。
 *
 * 照 dsh 的收件匣投影（key `inbox`，`packages/core/agent-loop/src/inbox.ts`，`477b4f4`）：人送出、還沒開跑的那幾句，
 * 從會話日誌的 `inbox/spliced` 折出來，**從日誌開頭折起**——它不會在一輪開頭清空。
 *
 * 載體是協定的 `custom` 事件，`data.name` 是 {@link INBOX}，`payload` 是 {@link InboxPayload}，後到的取代先到的：
 *
 * - **即時**：pump 每次佇列變動送一顆，帶整份清單。送出（閒著時也一樣）、領走開跑、改、刪各一顆。
 * - **歷史**：到 `throughSeq` 為止日誌上出現過佇列的變動，就送一顆**目前的**清單（空的也送），放在最新一頁；一顆變動
 *   都沒有就不送。
 *
 * ## 開跑那一刻：`claimed`
 *
 * 人送出的話一律先進佇列，**畫面在送出那一刻不畫人的泡泡**，等它被領走開跑才畫，而且用開跑用的那份文字（改過的就是
 * 改過的）。清單少一件分不出是開跑了還是被刪了（刪可能是別的分頁按的），所以領走那一顆多帶 {@link InboxPayload.claimed}。
 * 它一定比那一輪的任何 frame 先到、走同一條下行：pump 在 `turn/start` 之後、叫模型之前就寫下領走那一顆，而寫入的當下
 * 就同步送出。
 *
 * **對 dsh 的偏離**：dsh 把「領走」與「丟掉」分成兩種通知（`agent/inbox/claimed`、`agent/inbox/discarded`），投影本身只有
 * 清單。我們沒有投影與通知兩層，只有 pump 合成的 `custom` 事件（同 #575 的待辦清單），所以把領走併進同一顆：清單少一件與
 * 人的泡泡出現是同一件事，拆成兩顆的話中間會有一瞬間兩邊對不上。丟掉的那一種不需要：換掉清單就夠了。
 *
 * @module
 */

/** `custom` 事件的 `data.name`：送出佇列現在是這一份。 */
export const INBOX = 'inbox';

/** 排著的一件。結構上是 `@nexus/core` 的 `QueuedInput`，重新宣告的理由同 `SlashDescriptor`。 */
export interface WireQueuedInput {
  /** 就是送出時 `run.start` 回的 `run_id`：畫面拿它對上自己送出的那一句。改過之後不變。 */
  readonly id: string;
  readonly text: string;
  /** 誰送的。這一版只有人；目標續行走佇列是 #638。 */
  readonly source: { readonly kind: 'user' };
}

/** {@link INBOX} 的 `payload`。 */
export interface InboxPayload {
  /** 整份清單，照開跑的先後。 */
  readonly items: readonly WireQueuedInput[];
  /**
   * 這一顆是因為這一件被領走開跑而送的：畫面據它畫人的泡泡。**只有領走那一顆帶**，送出、改、刪都不帶；歷史也不帶
   * （人的泡泡在歷史裡由那一輪的 human 訊息畫）。
   */
  readonly claimed?: { readonly id: string; readonly text: string };
}
