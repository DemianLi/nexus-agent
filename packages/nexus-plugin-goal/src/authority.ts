/**
 * 執行時的權限判準：**這一顆變更呼叫背後有沒有一個人**。
 *
 * 形狀照 dsh 的 `packages/goal/tool-goal/src/authority.ts`（對讀版本
 * `d347e703908d0406b7a7ef80e3a0e594d86b2215`，2026-09-04）。那邊有兩種授權——直接人類
 * 與**當前 Goal Round**；**這裡只有前一種**，理由與其他三件一起寫在 `tools.ts` 檔頭：
 * 沒有續行驅動器就沒有 goal 來源的輪次，那個分支在我們的範圍內沒有生產者。
 *
 * ## 判準是「往回追」，不是「看最後一顆」
 *
 * 寫成「最後一顆 `turn/start` 是不是 `kind: 'message'`」會**拒絕掉一個人剛剛動了兩次手
 * 的情形**。停在核准點也算 `turn/end`（`session-log.ts` 明文），而恢復時 append 的是
 * **一顆新的** `turn/start`、`kind` 為 `resume`：
 *
 * ```
 * turn/start{message} → interrupt/raised → turn/end
 * turn/start{resume}  → …模型在這一段呼叫 create_goal
 * ```
 *
 * 所以要追的是**鏈**：往回走，遇到 `resume` 繼續往回，遇到 `message` 就是找到根。
 *
 * ## 認不得的 `kind` 一律**當場停住**，不是跳過
 *
 * 這是這個檔最重要的一行。今天 `turn/start` 的酬載只有 `{kind:'message'}` 與
 * `{kind:'resume'}` 兩個成員，所以「有 message 輪次 ⇒ 有人類授權」成立**完全是因為
 * 沒有第三個生產者**。dsh 的 `goal-round-driver` 排入的正是第三種：一則 goal 來源的
 * user 輪次，長得跟人打的一模一樣。
 *
 * 所以遇到不認得的 `kind` 時**不往回穿**：一個未知的生產者既不該自己拿到人類授權，也
 * 不該讓我們越過它去撿一則更早的人類輪次。fail-closed。
 *
 * **這條在今天是絆索，在補上 `source` 判別欄的那天會變成驗收句**（[#152](https://github.com/DemianLi/nexus-agent/issues/152)
 * 的決議把 `source` 與驅動器綁在同一張卡）：那時 `message` 這一支再多讀一格 source，
 * `kind: 'goal'` 的走到這裡就是同一個結論。改的是一行，不是一個機制。
 *
 * @module
 */

import type { SessionEvent, SessionEventMap } from '@nexus/core';

/** `turn/start` 的酬載。**單獨取出來是為了讓下面那個 `default` 分支有話可說**。 */
type TurnStart = SessionEventMap['turn/start'];

/**
 * 這條物理輪次鏈往回追到的是不是一則人類訊息。
 *
 * @param events - 一份會話日誌到目前為止的全部事件，照 `seq` 排。
 * @returns 追到 `kind: 'message'` 為真；追到頭、或撞上認不得的 `kind` 為假。
 */
export function hasDirectHumanTurn(events: readonly SessionEvent[]): boolean {
  for (let at = events.length - 1; at >= 0; at -= 1) {
    const event = events[at];
    if (event === undefined || event.type !== 'turn/start') continue;
    const data = event.data as TurnStart;
    if (data.kind === 'message') return true;
    if (data.kind === 'resume') continue;
    // 認不得的第三種：停住，見檔頭。
    return false;
  }
  return false;
}
