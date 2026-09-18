/**
 * **一顆問答中斷一個面板**：模型問的那一組問題，一題一頁（規格 §4.2 列 23、§4.3，#409）。
 *
 * 外殼是 shadcn `questionnaire`（`components/ui/questionnaire.tsx`）；外框、名稱、邊框光、收起、❌ 與焦點歸
 * `pending-swap.tsx`，這裡只畫題目與上下題。資料面照 dsh `QuestionComposer`（`references/deepseek-harness/packages/client/
 * ui-user-questions/src/client/QuestionComposer.tsx`）：
 *
 * - **一顆中斷帶整批問題**，一個面板答完（[#231](https://github.com/DemianLi/nexus-agent/issues/231) 第 8 項）。
 * - **跳過一題送 `{ id, selected: [] }`**——空陣列就是跳過的編碼，不是「答了空字串」。每一題都要有個交代（答了或
 *   跳過），primitive 的驗證擋住「還沒填」：送出時跳回那一題、秀出 `QuestionnaireError`。
 * - **有選項的題目也附一列「輸入你的答案」**（#376 第 2 條，dsh 的 “Other”）：單選時填字就取代選項、點選項就取代
 *   填的字（primitive 同一題只留一個作答），多選並存。沒有選項的題目只有這一列。
 * - **沒有「放棄整組」**：❌＝停止這一輪，是寫明的例外（§4.3），按鈕在換手層的名稱列上。
 *
 * **單選自動跳只認指標選取**（§8、WCAG 3.2.2）：滑鼠、觸控、VoiceOver 點兩下選了才跳，先停 200 讓勾選看得到；
 * 鍵盤（方向鍵、數字鍵）改選取不跳，要按 Enter。說明句放在題目描述裡事先告知。
 *
 * **草稿不暫存**（#231 第 8 項）：收起不會丟（換手層保持掛載），關掉分頁再回來就沒了。dsh 也把草稿標成 transient。
 */

import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import type { PendingQuestion } from '@nexus/wire';

import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireError,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSkip,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from '@/components/ui/questionnaire';

export type QuestionAnswer = { id: string; selected: string[]; custom?: string };

/** 單選自動跳之前先停多久（`--auto-advance-delay`，§7）。 */
const AUTO_ADVANCE_MS = 200;

/** 「第 2 題，共 3 題」：進度字與 legend 前的 sr-only 題號同一句（§8）。 */
export function questionPosition(index: number, total: number): string {
  return `第 ${index + 1} 題，共 ${total} 題`;
}

/** 自由作答那一列的名稱與提示字。 */
export const FREE_ANSWER_LABEL = '輸入你的答案';

/**
 * 從表單讀回答案。**不用 `FormData`**：自由作答那一列與選項共用題目的 `name`，`getAll` 會把自己填的字跟選到的
 * 標籤混在一起。逐題找 primitive 留著 `name` 的那幾格——被取代、被跳過的那一格 primitive 會把 `name` 拿掉。
 */
function readAnswers(form: HTMLFormElement, pending: PendingQuestion): QuestionAnswer[] {
  const items = [...form.querySelectorAll<HTMLElement>('[data-question-id]')];
  return pending.questions.map((question) => {
    // 比 `dataset` 不拼選擇器：題目 id 是模型給的，什麼字都有。
    const item = items.find((element) => element.dataset.questionId === question.id);
    const selected = [
      ...(item?.querySelectorAll<HTMLInputElement>(
        'input[data-slot="questionnaire-choice-input"][name]:checked',
      ) ?? []),
    ].map((input) => input.value);
    const custom =
      item
        ?.querySelector<HTMLInputElement>('input[data-slot="questionnaire-input"][name]')
        ?.value.trim() ?? '';
    return { id: question.id, selected, ...(custom === '' ? {} : { custom }) };
  });
}

export function QuestionPanel({
  pending,
  busy,
  onAnswer,
}: {
  pending: PendingQuestion;
  busy: boolean;
  onAnswer: (answers: QuestionAnswer[]) => void;
}) {
  const ids = pending.questions.map((question) => question.id);
  const [item, setItem] = useState(ids[0] ?? '');
  const [dir, setDir] = useState<'next' | 'prev'>();
  const current = Math.max(0, ids.indexOf(item));

  const advance = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(advance.current), []);

  // 上下題有方向（§7）：往後從右邊進來、往前從左邊。
  const go = (to: string) => {
    clearTimeout(advance.current);
    setDir(ids.indexOf(to) > ids.indexOf(item) ? 'next' : 'prev');
    setItem(to);
  };

  // 這一次改選取是不是指標做的。按下指標時設、任何按鍵時清：數字鍵與方向鍵也會觸發選項的 change。
  const pointer = useRef(false);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onAnswer(readAnswers(event.currentTarget, pending));
  };

  return (
    <div className="bg-stage shadow-stage max-h-[55svh] overflow-auto rounded-xl px-4 pt-4">
      <Questionnaire
        item={item}
        onItemChange={go}
        data-page-dir={dir}
        onSubmit={submit}
        onKeyDownCapture={() => {
          pointer.current = false;
        }}
        shortcuts="numbers"
      >
        {/* 進度自己寫中文；`aria-live` 關掉，換題時由 legend 前的題號一次唸（§8，絆索 8）。 */}
        <QuestionnaireProgress
          aria-live="off"
          aria-label="問題進度"
          aria-valuetext={questionPosition(current, ids.length)}
        >
          {questionPosition(current, ids.length)}
        </QuestionnaireProgress>
        {pending.questions.map((question, index) => {
          const options = question.options ?? [];
          const multi = question.multiSelect === true;
          return (
            <QuestionnaireItem
              key={question.id}
              name={question.id}
              multiple={multi}
              data-question-id={question.id}
              // 換手層把焦點搬到面板時落在當前題（§8）；primitive 對其他題是 `hidden`＋`inert`。
              data-pending-focus={question.id === item ? '' : undefined}
            >
              <QuestionnaireTitle>
                <span className="sr-only">{`${questionPosition(index, ids.length)}：`}</span>
                {question.question}
              </QuestionnaireTitle>
              {(question.header !== undefined || (options.length > 0 && !multi)) && (
                <QuestionnaireDescription>
                  {question.header !== undefined && <span>{question.header}</span>}
                  {options.length > 0 && !multi && (
                    // WCAG 3.2.2：自動跳題之前先講。
                    <span className="sr-only">
                      點選項會跳到下一題，可以按上一題回來改；用鍵盤選好之後按
                      Enter。也可以按數字鍵選。
                    </span>
                  )}
                </QuestionnaireDescription>
              )}
              {options.length > 0 && (
                <QuestionnaireChoices>
                  {options.map((option) => (
                    <QuestionnaireChoice
                      key={option.label}
                      value={option.label}
                      disabled={busy}
                      onPointerDown={() => {
                        pointer.current = true;
                      }}
                      onChange={(event) => {
                        if (multi || !pointer.current || !event.target.checked) return;
                        pointer.current = false;
                        const next = ids[index + 1];
                        if (next === undefined) return;
                        clearTimeout(advance.current);
                        advance.current = setTimeout(() => go(next), AUTO_ADVANCE_MS);
                      }}
                    >
                      {option.label}
                      {option.description !== undefined && (
                        <QuestionnaireChoiceDescription>
                          {option.description}
                        </QuestionnaireChoiceDescription>
                      )}
                    </QuestionnaireChoice>
                  ))}
                </QuestionnaireChoices>
              )}
              <QuestionnaireInput
                type="text"
                aria-label={FREE_ANSWER_LABEL}
                placeholder={FREE_ANSWER_LABEL}
                disabled={busy}
              />
              <QuestionnaireError>
                {options.length > 0
                  ? '還沒回答這一題：選一個、自己寫，或按跳過。'
                  : '還沒回答這一題：寫下答案，或按跳過。'}
              </QuestionnaireError>
            </QuestionnaireItem>
          );
        })}
        {/* 題目長到要捲時，上下題與送出仍然看得到：釘在捲動區底部（實跑 1280／375 都被擠出畫面）。 */}
        <QuestionnaireActions className="bg-stage sticky bottom-0 pb-4">
          <QuestionnairePrevious>上一題</QuestionnairePrevious>
          <QuestionnaireSkip>跳過</QuestionnaireSkip>
          <QuestionnaireNext>下一題</QuestionnaireNext>
          <QuestionnaireSubmit disabled={busy}>送出答案</QuestionnaireSubmit>
        </QuestionnaireActions>
      </Questionnaire>
    </div>
  );
}
