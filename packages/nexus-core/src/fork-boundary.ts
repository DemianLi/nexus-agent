/**
 * 分叉的切點：把 web 指名的那則 root 回覆（`messageId`）換算成同一輪收尾那顆 `turn/end` 的 `seq`
 * （[#1580](https://github.com/DemianLi/nexus-agent/issues/1580) 刀 2）。
 *
 * dsh 的 web 入口送的就是那一輪 `turn/end` 的 seq（`ui-chat/src/client/conversation-nodes/turn-tail.ts:93-96`，`687f282e`），
 * server 只看那顆在不在（`session-controller/src/commands.ts:251-260`）。我們的 wire 不帶耐久 seq（`@nexus/wire` 的
 * `thread-management.ts` 偏離 4），所以 web 指名回覆、由這裡換算；換算之後的切點與 dsh 的按鈕相同。
 *
 * @module
 */

import { loggedMessageId } from './logged-message.js';
import { hasUnansweredInterrupt, isLogicalTurnStart } from './session-log.js';
import type { SessionEvent } from './session-log.js';

/**
 * 指名的那則回覆所在的那一個邏輯輪，收尾那顆 `turn/end` 的 `seq`；分不出去就是 `undefined`（`fork_unavailable`）。
 *
 * 分不出去的情形：
 *
 * - 找不到記著這個 id 的 `assistant/message`：使用者的話、子代理的回覆（在它自己那一份日誌）、沒記 `messageId` 的舊輪
 *   （限制同評分），或根本沒有這則；
 * - 那一輪還沒收尾：沒有 `turn/end`，或最後一顆 `turn/end` 之後又被核准接著跑（`resume` 的 `turn/start`）還沒收；
 * - 那一輪停在核准點、沒人回答（**停在核准點的那一輪也有 `turn/end`**，見 `session-log.ts` 的 `hasUnansweredInterrupt`）；
 * - 那一輪是失敗收尾的（`turn/failed`）。dsh 由 UI 不給失敗的輪分支鈕（`turn-tail.ts` 的 `branchUnavailable`），我們由 server 判，
 *   偏離 4 寫明了。
 *
 * **同一輪的任何一則 root 回覆都換算到同一顆 `turn/end`**（#1580 卡面刀 2 第 2 步）：不另判是不是收尾那一則，web 只在收尾那則上放按鈕。
 * 一個邏輯輪可以有好幾段物理輪次（核准之後 `resume` 接著跑），收尾取這個邏輯輪最後一顆 `turn/end`。
 *
 * @param events - 來源日誌，照 `seq` 排、從 0 連續。
 * @param messageId - web 指名的那則回覆的 id（`AiEntry.messageId`）。
 * @returns 切點（含），可以直接交給 `buildForkSeed`。
 */
export function forkBoundaryOf(
  events: readonly SessionEvent[],
  messageId: string,
): number | undefined {
  const at = events.findIndex(
    (event) =>
      event.type === 'assistant/message' && loggedMessageId(event.data.message) === messageId,
  );
  if (at < 0) return undefined;
  let end: number | undefined;
  for (let index = at + 1; index < events.length; index += 1) {
    const event = events[index];
    /* v8 ignore next -- 索引在長度內 */
    if (event === undefined) break;
    if (isLogicalTurnStart(event)) break;
    if (event.type === 'turn/failed') return undefined;
    if (event.type === 'turn/end') end = index;
    else if (event.type === 'turn/start') end = undefined;
  }
  if (end === undefined) return undefined;
  if (hasUnansweredInterrupt(events.slice(0, end + 1))) return undefined;
  return events[end]?.seq;
}
