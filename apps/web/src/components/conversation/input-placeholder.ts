/**
 * 送出框的灰字，獨立頁面與嵌入版共用（#2366）。`App.tsx` 再匯出 `inputPlaceholder`，測試從那裡讀。
 */

import type { ConnectionStall } from '@/lib/connection-stall';
import { disconnectedPlaceholder } from '@/lib/connection-stall';
import { STOPPED_QUESTION_TEXT } from '@/lib/question-view';
import { STEER_QUEUE_PLACEHOLDER } from '@/lib/steer-queue';

/**
 * 送出框裡那句灰字。
 *
 * **等人回答時它看不見**：核准與提問面板換掉輸入框（#408、#409，規格 §4.3），面板名稱與狀態列講現在該做什麼，所以這裡
 * 不再分「先回答上面那個核准請求」與「那組問題」——那幾格是 [#239](https://github.com/DemianLi/nexus-agent/issues/239)
 * 在卡片疊在輸入框上方時的補丁。
 *
 * **停在提問時按了停止**（❌，§4.3）：跟那張展開的提問工具卡講同一句，請人直接打字回覆（#376 第 9 條）。
 */
export function inputPlaceholder({
  connected,
  stall,
  stoppedOnQuestion,
  steerQueue = false,
}: {
  readonly connected: boolean;
  /** 沒連上、也不會自己接回的那兩種（{@link connectionStall}）；沒有就是在重接，講「連線中…」。 */
  readonly stall?: ConnectionStall | undefined;
  readonly stoppedOnQuestion: boolean;
  /** 草稿空白、這一輪跑著、佇列裡有排著的：提示那個手勢（#710，dsh 的 `placeholder.steerQueue`）。 */
  readonly steerQueue?: boolean;
}): string {
  if (!connected) return disconnectedPlaceholder(stall);
  if (stoppedOnQuestion) return STOPPED_QUESTION_TEXT;
  return steerQueue ? STEER_QUEUE_PLACEHOLDER : '說點什麼…';
}
