/** 被中止的工具（#2247）：這一輪被中止，結果被換掉（本體可能已做完）或本體沒開始；不是工具自己回報失敗。 */
import { ABORTED_BEFORE_DISPATCH_CODE, ASK_USER_QUESTION } from '@/lib/question-view';

/** 停止的提問（`.docs/web-ui-spec.md` §4.3，#409）與被中止工具（#2247）的狀態字：停止不是失敗（#276）。 */
export const STOPPED_STATUS_LABEL = '已停止';

/**
 * 本體開始後被中止時寫入的**錯誤碼**（`@nexus/core` 的 `TOOL_ABORTED`，core 與 pump 都會寫）。
 * web 不相依 `@nexus/core`，值手寫。
 */
const TOOL_ABORTED_CODE = 'ABORTED';

/**
 * 這顆工具被中止時的狀態字；不是被中止的 `undefined`。比碼不比字。工具自己拋 `AbortError`
 * 也會記成 `ABORTED`，畫面分不出來。提問不在內：它的停止另由 `isStoppedQuestion` 判斷。
 */
export function abortedToolLabel(name: string, code: string | undefined): string | undefined {
  if (name === ASK_USER_QUESTION) return undefined;
  if (code === TOOL_ABORTED_CODE) return STOPPED_STATUS_LABEL;
  if (code === ABORTED_BEFORE_DISPATCH_CODE) return '沒有執行';
  return undefined;
}
