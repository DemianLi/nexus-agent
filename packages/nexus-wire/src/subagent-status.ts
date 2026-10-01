/**
 * 背景子代理「現在在做什麼」上線的形狀（[#867](https://github.com/DemianLi/nexus-agent/issues/867)）。
 *
 * 載體是協定的 `custom` 事件，`data.name` 是 {@link SUBAGENT_STATUS}，`payload` 是 {@link SubagentStatusPayload}。
 * **整份取代**（冪等）：後到的 `items` 就是現況，沒出現在裡面的 runId 就是不在了。
 *
 * - `running`：有一輪正在跑，或有一輪排著且沒被中斷暫停（`subagent.send` 一受理就轉，不等那一輪開跑）。
 * - `idle`：這條 thread 認得它、此刻沒有輪次要跑——已結算還能被 `subagent.send` 叫醒的，和被 `subagent.interrupt`
 *   中斷後暫停的，**這兩種分不出來**。
 * - **不在 `items` 裡＝收線**：這條 thread 的背景子代理載體不認得它了（thread 被拆，或重啟之後編號表在記憶體裡沒了）。
 *   這時 `subagent.send` 回 `subagent_not_found`。委派卡的 meta 來自 root 日誌，重新整理之後還在，所以「歷史裡有、這裡沒有」
 *   的 runId 一律當收線。
 *
 * **只有即時，歷史不帶**：它是「現在」的事（同 `title`），日誌上沒有對應的事件，也不為它新增。取而代之的是**新接上的下行
 * 在註冊當下先收到目前那一份**（同 #728 補送還掛著的中斷），所以重新整理、重連之後不必等下一次變動。
 *
 * **對 dsh 的偏離**：dsh 的子代理狀態走 host-wide 的 `session.control` 投影 frame；我們沒有那條通道，每條 thread 各自一條
 * 下行，所以跟 `title`、`todos` 一樣由 pump 合成 `custom` 事件。
 *
 * @module
 */

/** `custom` 事件的 `data.name`：這條 thread 的背景子代理現況。 */
export const SUBAGENT_STATUS = 'subagent/status';

export type SubagentRunStatus = 'running' | 'idle';

/** {@link SUBAGENT_STATUS} 的 `payload`。 */
export interface SubagentStatusPayload {
  readonly items: readonly {
    /** 背景子代理的編號（`bg-…`），就是 `subagent.send` 的 `run_id`。 */
    readonly runId: string;
    readonly status: SubagentRunStatus;
  }[];
}
