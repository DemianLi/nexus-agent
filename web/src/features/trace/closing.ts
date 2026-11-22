/**
 * 最新那一組的收尾與等待中：讀 `status` 補收尾列、讀掛著的中斷判斷是不是停在等人。
 *
 * @module
 */

import { isApprovalPending, isQuestionPending } from '@nexus/wire';
import type { ConversationState } from '@nexus/wire';
import { stoppedByTurnClock } from '@/shared/lib/stop-cause';
import { ENDING_LABEL } from '@/features/trace/model';
import type { EndingReason, TraceRow, TurnHead } from '@/features/trace/model';

/** 最新那一組的收尾：回覆上的旗標標不到的（停在工具執行中被停止、整輪失敗）讀 `status`。 */
export function closeWithStatus(rows: TraceRow[], state: ConversationState): void {
  const reason: EndingReason | undefined =
    state.status === 'stopped'
      ? stoppedByTurnClock(state.stopCause)
        ? 'timed-out'
        : 'stopped'
      : state.status === 'failed'
        ? 'failed'
        : undefined;
  const lastRow = rows.at(-1);
  if (reason === undefined || lastRow === undefined) return;
  if (rows.some((row) => row.kind === 'ending' && row.reason === reason)) return;
  rows.push({
    kind: 'ending',
    key: `status:${reason}`,
    target: lastRow.target,
    reason,
    summary: reason === 'failed' && state.error !== undefined ? state.error : ENDING_LABEL[reason],
  });
}

/**
 * 最後一組現在是不是停在等人：掛著中斷，而且這一組的收尾是 `completed` 或還沒收。`aborted`、`failed` 那些是真的結束了，
 * 不會還在等。核准優先於問答：兩種同時掛著時，狀態列也是先講核准。
 */
export function waitingOf(state: ConversationState, head: TurnHead): TurnHead['waiting'] {
  if (head.end !== undefined && head.end !== 'completed') return undefined;
  if (state.pendings.some(isApprovalPending)) return 'approval';
  if (state.pendings.some(isQuestionPending)) return 'question';
  return undefined;
}
