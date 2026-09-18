/**
 * `ask_user_question` 那張工具卡要知道的事（規格 §4.3，#409）：它是不是**停在提問時被停止**的那一張，以及它問了哪幾題。
 *
 * 停止這一輪是提問面板 ❌ 的唯一行為（寫明的例外，§4.3）。停下來之後那張工具卡直接展開、列出題目與選項，標
 * {@link STOPPED_QUESTION_TEXT}；輸入框的提示字同一句（#376 第 9 條）。不另插一則文字訊息，免得把系統文字偽裝成模型回覆。
 *
 * @module
 */

import type { ConversationState, QuestionItem, ToolEntry } from '@nexus/wire';
import { UNFINISHED_TOOL_TEXT } from '@nexus/wire';

/** 模型看到的工具名（`@nexus/plugin-ask-user` 的 `ASK_USER_QUESTION_TOOL_NAME`）。 */
export const ASK_USER_QUESTION = 'ask_user_question';

/** 停在提問時按了停止：工具卡上的標記、輸入框的提示字。 */
export const STOPPED_QUESTION_TEXT = '已停止，請直接打字回覆';

/**
 * 停止時 pump 替懸著的那顆呼叫寫進對話與日誌的結果，**理由那半句**（`@nexus/core` 的
 * `TOOL_ABORTED_BEFORE_DISPATCH_REASON`，`ThreadPump.#withdraw`）。卡上的紅字是 core 的 `Error: ` 前綴接這一句；
 * 前綴只有一個主人（`apps/harness/src/tool-error-prefix.test.ts`），所以這裡只抄理由、比結尾。web 不相依
 * `@nexus/core`，`question-view.test.ts` 讀那邊的原始碼對字。
 */
export const WITHDRAWN_TOOL_REASON = 'tool call aborted before dispatch';

/**
 * 這張卡是不是停在提問時被停止的那一張。
 *
 * 認的是**這一輪收掉時它還沒有答案**的兩種結果：pump 收回時寫的那一句，或折疊器替沒結果的卡補的那一句。卡上只有文字、
 * 沒有碼（`ToolEntry` 不帶 `error.code`），所以用字比對。一輪因為失敗（不是停止）而收掉時也會補同一句，分不出來；
 * 那時狀態列講的是失敗。
 */
export function isStoppedQuestion(entry: ToolEntry): boolean {
  return (
    entry.name === ASK_USER_QUESTION &&
    entry.status === 'failed' &&
    (entry.error?.endsWith(WITHDRAWN_TOOL_REASON) === true || entry.error === UNFINISHED_TOOL_TEXT)
  );
}

/** 這一輪是不是停在提問上被停止的：輸入框提示字換成 {@link STOPPED_QUESTION_TEXT}。 */
export function stoppedOnQuestion(state: ConversationState): boolean {
  if (state.status !== 'stopped') return false;
  const turn = state.entries.slice(
    state.entries.findLastIndex((entry) => entry.kind === 'human') + 1,
  );
  return turn.some((entry) => entry.kind === 'tool' && isStoppedQuestion(entry));
}

/** 呼叫參數裡的題目（模型面是 `multi_select`）。解不開或形狀不對就是 `undefined`，卡片退回參數原文。 */
export function questionsOf(input: string): QuestionItem[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return undefined;
  }
  const questions = (parsed as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(questions)) return undefined;
  const items: QuestionItem[] = [];
  for (const raw of questions) {
    const question = raw as Record<string, unknown> | null;
    if (typeof question?.id !== 'string' || typeof question.question !== 'string') return undefined;
    const options = Array.isArray(question.options)
      ? question.options.flatMap((option: unknown) => {
          const shaped = option as { label?: unknown; description?: unknown } | null;
          if (typeof shaped?.label !== 'string') return [];
          return [
            {
              label: shaped.label,
              ...(typeof shaped.description === 'string'
                ? { description: shaped.description }
                : {}),
            },
          ];
        })
      : undefined;
    items.push({
      id: question.id,
      question: question.question,
      ...(typeof question.header === 'string' ? { header: question.header } : {}),
      ...(options === undefined ? {} : { options }),
      ...(question.multi_select === true ? { multiSelect: true } : {}),
    });
  }
  return items;
}
