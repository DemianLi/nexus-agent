/**
 * 會話標題上線的形狀（[#647](https://github.com/DemianLi/nexus-agent/issues/647)）。
 *
 * 照 dsh 的 `title` 投影（`packages/session/session-title/src/index.ts` 的 `titleProjectionDefinition`，`477b4f4`）：
 * root 日誌上最後一顆 `session/title` 的文字，**latest-wins**；客戶端看到的值是 `string | null`，還沒有標題是 `null`。
 *
 * 載體是協定的 `custom` 事件，`data.name` 是 {@link TITLE}，`payload` 是 {@link TitlePayload}，後到的取代先到的：
 *
 * - **即時**：root 日誌記下一顆 `session/title` 就送一顆。來源有兩種，一條會話各至多一顆：
 *   - **退回標題**：第一則合格的人話**開跑**的那一刻（送出佇列領走它的那一刻，不是送出的那一刻），落在那一輪的
 *     模型與工具的 frame 之前。
 *   - **模型標題**（[#650](https://github.com/DemianLi/nexus-agent/issues/650)）：同一則人話的標題請求成功之後，落在
 *     一輪之外，蓋過退回標題。
 * - **歷史**：只在最新一頁送一顆**目前的**標題，同送出佇列；較舊的頁不帶，免得往上捲時把新的蓋回舊的。18 以前的
 *   日誌沒有這一顆事件，server 照同一條規則當場推，推不出來就不送。
 *
 * **對 dsh 的偏離**：dsh 的投影值走 follow 快照與 host-wide 的 `session.control` 投影 frame。我們沒有 host-wide 的
 * 控制通道，每條 thread 各自一條下行，所以跟 `todos`、`inbox` 一樣由 pump 合成 `custom` 事件。
 *
 * @module
 */

/** `custom` 事件的 `data.name`：這條會話現在叫這個。 */
export const TITLE = 'title';

/** {@link TITLE} 的 `payload`。 */
export interface TitlePayload {
  /** 標題，不是空字串。server 只在有標題時送，所以沒有 `null`。 */
  readonly title: string;
}
