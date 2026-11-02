/**
 * 下行沒連上、而且**不會自己接回**時，輸入框那句灰字（[#1865](https://github.com/DemianLi/nexus-agent/issues/1865)）。
 * 主對話的送出框與展開的子代理面板（[#1876](https://github.com/DemianLi/nexus-agent/issues/1876)）用同一份判斷、講同一句，
 * 才不會一邊說停了、一邊說連線中。
 *
 * @module
 */

import type { Conversation } from '@/hooks/use-conversation';
import { THREAD_PROTOCOL_ERROR_TEXT } from '@/lib/thread-protocol-error';

/** 連線停住、等人按「立刻重連」時送出框那句灰字（#1865）：跟狀態列「…已停止自動重連」與它旁邊的按鈕講同一件事。 */
export const HALTED_PLACEHOLDER = '已停止自動重連，請按上方「立刻重連」';

/** 伺服器永久不收這條下行時送出框那句灰字（#1865）：原因（子代理的對話、歷史太深）由狀態列講。 */
export const REFUSED_PLACEHOLDER = '這條對話打不開，無法送出';

/** 不會自己接回的那兩種，見 {@link connectionStall}。 */
export type ConnectionStall = 'refused' | 'halted';

/**
 * 下行沒連上、而且**不會自己接回**的那兩種（#1865），跟狀態列（`status-line.tsx`）用同一組欄位判斷，畫的東西才一致：
 *
 * - `refused`：被伺服器永久拒絕，`refusal` 有值、`reconnecting` 沒有（子代理的對話 #1708、歷史太深 #1753）。
 * - `halted`：伺服器送來看不懂的資料、停了自動重連（#1601）。**由 `refusal` 是不是 {@link THREAD_PROTOCOL_ERROR_TEXT} 判斷**：
 *   改狀態列那一句時，這裡跟著變。按了「立刻重連」、還在連的那段時間，狀態列仍講那一句，這裡也還是 `halted`。
 *
 * 其他（thread 數滿了在重試、一般斷線）回 `undefined`：背景真的在重接，「連線中…」是實話。
 */
export function connectionStall({
  connected,
  refusal,
  reconnecting,
}: Pick<Conversation, 'connected' | 'refusal' | 'reconnecting'>): ConnectionStall | undefined {
  if (connected || refusal === undefined) return undefined;
  if (reconnecting === undefined) return 'refused';
  return refusal === THREAD_PROTOCOL_ERROR_TEXT ? 'halted' : undefined;
}

/** 沒連上時那句灰字：停住、被拒各有一句，其餘（背景在重接）講「連線中…」。 */
export function disconnectedPlaceholder(stall: ConnectionStall | undefined): string {
  if (stall === 'halted') return HALTED_PLACEHOLDER;
  if (stall === 'refused') return REFUSED_PLACEHOLDER;
  return '連線中…';
}
