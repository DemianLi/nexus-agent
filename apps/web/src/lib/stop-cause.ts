import type { TurnStopCause } from '@nexus/wire';

/**
 * 一輪為什麼停（[#1631](https://github.com/DemianLi/nexus-agent/issues/1631)）：時間到停下和人按停止分開講。
 *
 * **只認得時鐘到點那一種**，其餘（人按的 `user`、別的 `hook`、沒帶原因的舊 server）照舊講「已停止」。同 dsh 只替自己
 * 認得的 hook 原因另畫一句（`ui-chat` 的 `conversation-nodes/turn-error.ts:40-44`，`687f282e`）。時間到不是失敗
 * （[#276](https://github.com/DemianLi/nexus-agent/issues/276)），所以這幾句都不用紅字。下行沒帶上限是多少，文案不寫數字。
 */

/**
 * 時鐘到點的 `hook` 原因：`@nexus/harness` 的 `TURN_TIMEOUT_REASON`（`settings/turn-timeout.ts`）。web 不相依 harness，
 * 所以抄一份；`stop-cause.test.ts` 讀 harness 的原始碼把兩份釘在一起。
 */
export const TURN_TIMEOUT_REASON = 'turn-timeout';

/** 狀態列：人按的。 */
export const STOPPED_STATUS_TEXT = '已停止';
/** 狀態列：時鐘到點。要讓人知道不是誰按了停止，而且可以再送一次。 */
export const TIMED_OUT_STATUS_TEXT = '超過時間上限，已停止；可以再送一次';
/** 回覆底下：人按的。 */
export const STOPPED_FOOTER_TEXT = '（已停止）';
/** 回覆底下：時鐘到點。 */
export const TIMED_OUT_FOOTER_TEXT = '（超過時間上限，已停止）';

/**
 * @param cause - 收尾帶的原因；舊 server 沒帶是 `undefined`。
 * @returns 這一輪是不是時鐘到點停下的。
 */
export function stoppedByTurnClock(cause: TurnStopCause | undefined): boolean {
  return cause?.kind === 'hook' && cause.reason === TURN_TIMEOUT_REASON;
}
