/**
 * 對話壓縮過這件事上線的形狀（[#896](https://github.com/DemianLi/nexus-agent/issues/896)）。
 *
 * 照 dsh 的壓縮標記（`packages/client/ui-chat/src/client/chat/CompactionItem.tsx:31`、
 * `conversation-nodes/command.ts:101` 的 `compactSummary`，`c1b47e41fcd`）：transcript 裡的一列，**不取代**被蓋掉的
 * 列，只表示「模型的歷史在這裡換成了一份摘要」，展開可看摘要全文。
 *
 * 載體是協定的 `custom` 事件，`data.name` 是 {@link COMPACTION}，`payload` 是 {@link CompactionPayload}。
 * 它跟 `todos` 那類「整份取代」的值不同：壓縮是對話裡**發生過的一件事**，有位置、可以有很多顆，折疊器為它長一格
 * `CompactionEntry`（`id` 由 `seq` 定，同一個 `seq` 只長一格），落在它在串流裡的位置，跟 `workspace-changes` 同形。
 *
 * - **即時**：root 日誌每記一顆 `compaction/summary` 就送一顆。
 * - **歷史**：每一頁逐顆轉，位置就是日誌上的位置。
 *
 * ## 位置：在觸發它的那次呼叫的回覆**之後**
 *
 * 摘要器包在記回覆那一層外面，要等那次呼叫回來才讀得到壓縮事件（`summarization.ts`），所以日誌上的順序是
 * `assistant/message`、`model/end`、`context/measure`、`compaction/summary`——實測。語意上壓縮發生在回覆**之前**
 * （那則回覆是看著壓縮後的串寫的）。**對 dsh 的偏離**：dsh 的標記落在替換用的那顆 `user/message`，在呼叫之前。我們讀不到
 * 更早的時刻，不是不想；即時與歷史都照日誌，兩邊才會長出同一個順序。
 *
 * ## 數字是「前 N 則」，不是這一次壓了多少
 *
 * `cutoff` 是日誌上的 `cutoffIndex`：模型的**原始訊息串**（含工具結果與外掛注入的，不只是畫面上看得到的那些）
 * 裡，前 `cutoff` 則已被換成摘要。原始串只增不減，所以第二次壓縮的 `cutoff` 比第一次大，差值才是這一次新壓進去的。
 * 畫面上看到的列數不等於它，要寫成「前 N 則」而不是「N 則對話」。dsh 另有被蓋掉的 token 數，日誌沒記，這裡沒有。
 *
 * ## 摘要全文
 *
 * `summary` 是摘要器產出的那段話，已拿掉面向模型的外框（`You are in the middle of a conversation…`，裡面還寫著原文存在
 * 哪個路徑，對人沒有意義），**套上跟工具結果文字同一個位元組上限**（`capToolText`），超過取頭尾、中間放一行通知。
 * 舊日誌（格式 8 以前）沒有摘要本文，這一欄就不放。
 *
 * @module
 */

/** `custom` 事件的 `data.name`：模型的歷史在這裡換成了一份摘要。 */
export const COMPACTION = 'compaction';

/** {@link COMPACTION} 的 `payload`。 */
export interface CompactionPayload {
  /** 那顆 `compaction/summary` 在 root 日誌裡的 `seq`：確定值，當這一格的 id。 */
  readonly seq: number;
  /** 前幾則原始訊息已被換成摘要（日誌的 `cutoffIndex`）。 */
  readonly cutoff: number;
  /** 被壓掉的原文有沒有存成檔讓模型讀回去（日誌的 `filePath` 不是 `null`）。`false`＝原文消失了。 */
  readonly saved: boolean;
  /** 摘要全文，已拿掉外框、套過位元組上限。日誌上沒有（舊格式）或拿不出文字就不放。 */
  readonly summary?: string;
}
