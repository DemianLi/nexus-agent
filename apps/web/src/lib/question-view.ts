/**
 * `ask_user_question` 那張工具卡要知道的事（規格 §4.3，#409）：它是不是**停在提問時被停止**的那一張、它問了哪幾題，
 * 以及答完之後人答了什麼。
 *
 * 停止這一輪是提問面板 ❌ 的唯一行為（寫明的例外，§4.3）。停下來之後那張工具卡直接展開、列出題目與選項，標
 * {@link STOPPED_QUESTION_TEXT}；輸入框的提示字同一句（#376 第 9 條）。不另插一則文字訊息，免得把系統文字偽裝成模型回覆。
 *
 * @module
 */

import type {
  AnswerEntry,
  ConversationEntry,
  ConversationState,
  QuestionItem,
  ToolEntry,
} from '@nexus/wire';
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

/**
 * 答案接到哪一張提問卡上：工具卡的 id → 那一則答案（規格 §4.3「答完」）。
 *
 * **按題目 id 配**：問答中斷帶的是 `interruptId`，工具卡帶的是呼叫 id，線上沒有欄位把兩個接起來；題目 id 是兩邊都有
 * 的那一格。一則答案配**同一輪**（上一則人話之後）裡**最早**一張還沒配到、題目 id 對得上的 `ask_user_question` 卡：
 * 問的時候輸入框被面板換掉，所以卡與答案之間不會有人話；同一輪兩顆提問並行時中斷先來先答，最早的那張就是它的。
 * 往回找最近的那張會在這時把兩則配反，跨輪找則會配到重新整理前、答案沒有留下來的舊卡。
 *
 * **答案只有作答的那個分頁記得**（`AnswerEntry`：下行不回聲答案）。重新整理、別的分頁、往回載入的歷史都沒有這一則，
 * 卡就配不到，退成「已回答 N 題」。放棄整組（`cancelled`）不是答案，不配。
 */
export function pairAnswers(
  entries: readonly ConversationEntry[],
): ReadonlyMap<string, AnswerEntry> {
  const paired = new Map<string, AnswerEntry>();
  entries.forEach((entry, index) => {
    if (entry.kind !== 'answer' || entry.cancelled === true) return;
    const ids = new Set(entry.answers.map((answer) => answer.id));
    const turn = entries.slice(0, index);
    const card = turn
      .slice(turn.findLastIndex((other) => other.kind === 'human') + 1)
      .find((candidate) => {
        if (
          candidate.kind !== 'tool' ||
          candidate.name !== ASK_USER_QUESTION ||
          paired.has(candidate.id)
        ) {
          return false;
        }
        const questions = questionsOf(candidate.input);
        return (
          questions !== undefined &&
          questions.length === ids.size &&
          questions.every((question) => ids.has(question.id))
        );
      });
    if (card !== undefined) paired.set(card.id, entry);
  });
  return paired;
}

/** 一題的答案：`AnswerEntry` 裡那一格，工具結果文字回的也是同一個形狀。 */
export type QuestionAnswer = AnswerEntry['answers'][number];

/**
 * 工具結果文字裡的答案（[#439](https://github.com/DemianLi/nexus-agent/issues/439)）。
 *
 * 成功的 `ask_user_question` 回的就是 `{"answers":[{id,selected,custom?}]}`（`@nexus/plugin-ask-user`），
 * 這一段在 {@link ToolEntry.text}，即時與重播同一串，**不分分頁**——所以重新整理、在別的分頁打開、往回載入
 * 歷史都讀得到，不再只靠本地的 `AnswerEntry`。
 *
 * 形狀檢查照 dsh `ask-question-row.tsx` 的 `answerEntries`（`ddefc45`）：**對不上就整份不要**，不挑能用的那幾筆。
 *
 * **一定要真的 `JSON.parse`**：文字超過 50000 bytes 時 harness 取頭尾各半、中間放一行說明
 * （`apps/harness/src/tool-result-text.ts`），截過的那一份**開頭 `{"answers":[`、結尾 `]}` 都還在**，
 * 用頭尾字元判斷會把它當成完整的 JSON。
 */
export function answersOfText(text: string | undefined): readonly QuestionAnswer[] | undefined {
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const answers = (parsed as { answers?: unknown } | null)?.answers;
  if (!Array.isArray(answers)) return undefined;
  const items: QuestionAnswer[] = [];
  for (const raw of answers) {
    const answer = raw as Record<string, unknown> | null;
    if (typeof answer?.id !== 'string') return undefined;
    if (!Array.isArray(answer.selected)) return undefined;
    if (!answer.selected.every((item) => typeof item === 'string')) return undefined;
    if (answer.custom !== undefined && typeof answer.custom !== 'string') return undefined;
    items.push({
      id: answer.id,
      selected: answer.selected as readonly string[],
      ...(answer.custom === undefined ? {} : { custom: answer.custom }),
    });
  }
  return items;
}

/**
 * 逐題配上答案：題目 id → 那一題的答案。
 *
 * 照 dsh `pairAnswers`：**題數不同、答案的 id 重複、有一題配不到，就整組不配**（回 `undefined`），
 * 卡片退回只列題目。配一半比不配更難看出哪裡不對。
 */
export function pairQuestions(
  questions: readonly QuestionItem[],
  answers: readonly QuestionAnswer[],
): ReadonlyMap<string, QuestionAnswer> | undefined {
  if (questions.length !== answers.length) return undefined;
  const byId = new Map<string, QuestionAnswer>();
  for (const answer of answers) {
    if (byId.has(answer.id)) return undefined;
    byId.set(answer.id, answer);
  }
  if (questions.some((question) => !byId.has(question.id))) return undefined;
  return byId;
}

/** 這一題算不算答了：選了東西或自己寫了字（照 dsh 算 `answered` 的規則）。 */
function isAnswered(answer: QuestionAnswer): boolean {
  return answer.selected.length > 0 || (answer.custom ?? '') !== '';
}

/** 一題的回答怎麼寫：選到的與自己寫的接起來；**兩者都空＝跳過**（照抄 dsh 的編碼，`AnswerEntry`）。 */
export function answerText(answer: QuestionAnswer | undefined): string {
  if (answer === undefined) return '（沒有紀錄）';
  const picked = [...answer.selected, ...(answer.custom === undefined ? [] : [answer.custom])];
  return picked.length === 0 ? '（跳過）' : picked.join('、');
}

/**
 * 提問卡收著時那一行：答完了講幾題，還沒答講問什麼。
 *
 * 讀得到答案時講**答了幾題／共幾題**（照 dsh `ask.answered`＝`{answered}/{total} 已回答`，跳過的不算答）；
 * 讀不到就只講題數，同 [#429](https://github.com/DemianLi/nexus-agent/pull/429) 那條退路。
 */
export function questionSummary(
  questions: readonly QuestionItem[],
  done: boolean,
  answers?: readonly QuestionAnswer[],
): string {
  if (done) {
    if (answers === undefined) return `已回答 ${questions.length} 題`;
    return `已回答 ${answers.filter(isAnswered).length}/${answers.length} 題`;
  }
  const first = questions[0]?.question ?? '';
  return questions.length > 1 ? `${first}（共 ${questions.length} 題）` : first;
}
