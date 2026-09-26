import type { ConversationStatus } from '@nexus/wire';

/**
 * 送出佇列在畫面上的幾個判斷（[#645](https://github.com/DemianLi/nexus-agent/issues/645)）。資料是 harness 的投影
 * `ConversationState.inbox`（#637）：人送出、還沒開跑的那幾句。
 *
 * @module
 */

/** 一列的預覽最多幾個字，照 dsh `QUEUE_PREVIEW_CHARS`。 */
export const QUEUE_PREVIEW_CHARS = 200;

/** 新進來的一件要撐過多久才畫（Q5）：閒著時送出，伺服器緊接著就領走，不壓的話佇列會閃一列。 */
export const QUEUE_SETTLE_MS = 200;

/** 消失時淡出多久（Q8）。 */
export const QUEUE_LEAVE_MS = 150;

/** 停住時表頭多講的那一句（Q6）。 */
export const QUEUE_PARKED_TEXT = '停止後這些不會自己跑，送出下一句時會先照順序跑它們';

/** 改、刪沒收下而那一件已經不在隊裡（Q7）。 */
export const QUEUE_GONE_TEXT = '這一則可能已經開始跑了';

/** 表頭：件數。 */
export function queueHeading(count: number): string {
  return `${count} 則排著的訊息`;
}

/** 一列的預覽：攤成一行，超過 {@link QUEUE_PREVIEW_CHARS} 個字截掉加「…」。照 dsh `queuePreview`。 */
export function queuePreview(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  const chars = [...line];
  return chars.length > QUEUE_PREVIEW_CHARS
    ? `${chars.slice(0, QUEUE_PREVIEW_CHARS).join('')}…`
    : line;
}

/**
 * 排著的是不是**停住**了（Q6）：按了停止之後排著的不會自己跑，等下一句送出才照順序跑（#637 Q2）。伺服器沒有推
 * 這個旗標，但看得出來——清單不空，而一輪既不在跑、也不在等人，排著的就沒有人會去領。
 *
 * - `running`：等這一輪跑完。`awaiting-input`：停在核准點後面，答完才跑（#629）。這兩種不算。
 * - `stopped`：停住。重新整理後從歷史回來的停住是 `idle` 或 `stopped`，同樣算。
 * - `failed`：伺服器不因失敗停住，下一件會接著跑，所以只會短暫出現——畫面上新項目本來就要撐過
 *   {@link QUEUE_SETTLE_MS} 才畫，這一格照規則算停住也碰不太到。
 */
export function isQueueParked(status: ConversationStatus, count: number): boolean {
  return count > 0 && status !== 'running' && status !== 'awaiting-input';
}

/**
 * 輸入框送得出一句話嗎（Q2）。**純文字跑著也放行**：伺服器收下就排進佇列。停在核准點時輸入框被面板換掉（Q3、
 * §4.3），這裡照樣擋，免得別的路徑繞過去。
 */
export function canSendText(connected: boolean, status: ConversationStatus, line: string): boolean {
  return connected && line.trim() !== '' && status !== 'awaiting-input';
}

/**
 * 斜線命令送得出去嗎。**一輪沒收尾時照舊擋**：伺服器那側也擋（跑著、停在核准點都是）。只打 `/feedback` 例外：
 * 它不起一輪，只開回饋對話框（#267 的 Q10）。
 */
export function canRunSlash(
  connected: boolean,
  status: ConversationStatus,
  line: string,
  feedbackLine: string,
): boolean {
  const busy = status === 'running' || status === 'awaiting-input';
  return connected && line.trim() !== '' && (!busy || line.trim() === feedbackLine);
}
