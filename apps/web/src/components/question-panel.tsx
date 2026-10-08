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
 * - **題目帶 `detail` 就在題目下面畫成 markdown**（同 dsh `QuestionComposer`）。認得 `intent` 的計劃審核換成
 *   `review.tsx` 的面板（#654），到不了這裡；認不出來的（`planReviewOf` 有一條不成立）照一般提問畫、照一般提問答，
 *   全文仍然畫在這裡。
 *
 * **單選自動跳只認指標選取**（§8、WCAG 3.2.2）：滑鼠、觸控、VoiceOver 點兩下選了才跳，先停 200 讓勾選看得到；
 * 鍵盤（方向鍵、數字鍵）改選取不跳，要按 Enter。說明句放在題目描述裡事先告知。
 *
 * **MCP server 的反問**（[#1098](https://github.com/DemianLi/nexus-agent/issues/1098)）：`pending.origin` 有值才多這三樣，沒有就跟
 * 以前一樣。①面板最上面講**是哪台 server 的哪支工具在問、用什麼有效參數**——一個不說來源的問答卡，讓人不知道自己在回答誰；
 * ②操作列下面多一列「拒絕」（明確說不給）與「取消」（先不回答），MCP 的 `decline`／`cancel`，與作答的 `accept` 並列，**都不停止這一輪**
 * （名稱列的 ❌ 才是停止，§4.3）；③參數原文照畫在可捲動的區塊裡，不截斷（人要看得到將被同意的是什麼）。
 *
 * **草稿不暫存**（#231 第 8 項）：收起不會丟（換手層保持掛載），關掉分頁再回來就沒了。dsh 也把草稿標成 transient。
 */

import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import type { PendingQuestion } from '@nexus/wire';

import { Surface } from '@/components/surface';
import { Button } from '@/components/ui/button';
import { MarkdownText } from '@/components/markdown-text';
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
  onDecline,
  onDismiss,
}: {
  pending: PendingQuestion;
  busy: boolean;
  onAnswer: (answers: QuestionAnswer[]) => void;
  /** MCP 反問的「拒絕」；沒給就不畫。 */
  onDecline?: () => void;
  /** MCP 反問的「取消」（先不回答）；沒給就不畫。 */
  onDismiss?: () => void;
}) {
  const origin = pending.origin;
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

  // 操作列。有來源時外面再包一層釘住的容器、多一列拒絕／取消，這裡的列自己就不釘（`sticky`＝是不是最外層）。
  const actions = (sticky: boolean) => (
    <QuestionnaireActions className={sticky ? 'bg-stage sticky bottom-0 pb-4' : undefined}>
      <QuestionnairePrevious>上一題</QuestionnairePrevious>
      <QuestionnaireSkip>跳過</QuestionnaireSkip>
      <QuestionnaireNext>下一題</QuestionnaireNext>
      <QuestionnaireSubmit disabled={busy}>送出答案</QuestionnaireSubmit>
    </QuestionnaireActions>
  );

  return (
    <Surface tone="stage" className="max-h-[55svh] overflow-auto px-4 pt-4">
      {origin !== undefined && <OriginBlock origin={origin} />}
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
              {question.detail !== undefined && question.detail.trim() !== '' && (
                // 認不出來的計劃審核（#652）也走到這裡：全文不能丟。
                <div
                  data-slot="question-detail"
                  className="text-body border-border rounded-lg border px-3 py-2"
                >
                  <MarkdownText text={question.detail} />
                </div>
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
        {origin === undefined || (onDecline === undefined && onDismiss === undefined) ? (
          actions(true)
        ) : (
          <div className="bg-stage sticky bottom-0 flex flex-col gap-2 pb-4">
            {actions(false)}
            <div className="flex justify-end gap-2" data-testid="origin-actions">
              {onDecline !== undefined && (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 sm:min-h-0"
                  disabled={busy}
                  onClick={onDecline}
                >
                  拒絕
                </Button>
              )}
              {onDismiss !== undefined && (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 sm:min-h-0"
                  disabled={busy}
                  onClick={onDismiss}
                >
                  取消
                </Button>
              )}
            </div>
          </div>
        )}
      </Questionnaire>
    </Surface>
  );
}

/** 參數轉成可讀的文字；循環參照之類轉不了的退回 `String`（來源是 server 給的純 JSON，正常不會發生）。 */
function argumentsText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 這組問題是哪台 MCP server 的哪支工具在問（#1098）：最上面，題目之前。 */
function OriginBlock({ origin }: { origin: NonNullable<PendingQuestion['origin']> }) {
  return (
    <div
      data-testid="question-origin"
      className="border-border text-body mb-3 flex flex-col gap-2 rounded-lg border px-3 py-2"
    >
      <p className="font-medium">
        MCP 伺服器「<code className="font-mono">{origin.server}</code>」的工具「
        <code className="font-mono">{origin.tool}</code>」在問你
      </p>
      <div className="flex flex-col gap-1">
        <p className="text-muted-foreground text-tip">呼叫參數</p>
        <pre
          data-testid="question-origin-arguments"
          tabIndex={0}
          aria-label="呼叫參數"
          className="bg-chip max-h-32 min-w-0 overflow-auto rounded-lg p-2 font-mono text-tip break-words whitespace-pre-wrap"
        >
          {argumentsText(origin.arguments)}
        </pre>
      </div>
      <p className="text-muted-foreground text-tip">
        這是外部伺服器在問，不是模型。拒絕＝明確不給；取消＝先不回答。兩者都不會停止這一輪。
      </p>
    </div>
  );
}
