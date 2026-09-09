/**
 * **一顆問答中斷一張卡**：模型問的那一組問題，一次答完。
 *
 * 形狀照抄 dsh 的 `QuestionComposer`（`references/deepseek-harness/packages/client/
 * ui-user-questions/src/client/QuestionComposer.tsx`）的資料面，不是它的視覺：
 *
 * - **一顆中斷帶整批問題，一張卡列完**（[#231](https://github.com/DemianLi/nexus-agent/issues/231)
 *   第 8 項）。逐題各發一顆中斷在「一顆中斷一張卡」之下會長出 N 張卡。
 * - **跳過一題送 `{ id, selected: [] }`**——空陣列就是跳過的編碼，不是「答了空字串」。
 * - **取消整組**是另一件事：那條路讓工具收到錯誤，模型知道人放棄了。
 * - `options` 缺席的題目給自由文字（`custom`）；有 options 的也能同時填 `custom`
 *   （dsh 的 “Other”）。
 *
 * **草稿不暫存**（#231 第 8 項）：關掉分頁再回來，填到一半的東西不在了。dsh 自己也把
 * 草稿標成 transient，而我們這一層還沒有那種 store。
 */

import { useState } from 'react';

import type { PendingQuestion } from '@nexus/wire';

import { Button } from '@/components/ui/button';

interface Draft {
  readonly selected: readonly string[];
  readonly custom: string;
  readonly skipped: boolean;
}

const EMPTY: Draft = { selected: [], custom: '', skipped: false };

export function QuestionCard({
  pending,
  busy,
  onAnswer,
  onCancel,
}: {
  pending: PendingQuestion;
  busy: boolean;
  onAnswer: (answers: { id: string; selected: string[]; custom?: string }[]) => void;
  onCancel: () => void;
}) {
  const [drafts, setDrafts] = useState<readonly Draft[]>(() => pending.questions.map(() => EMPTY));

  const update = (index: number, next: (draft: Draft) => Draft): void => {
    setDrafts((previous) => previous.map((draft, at) => (at === index ? next(draft) : draft)));
  };

  const toggle = (index: number, label: string, multi: boolean): void => {
    update(index, (draft) => {
      if (!multi) return { selected: [label], custom: draft.custom, skipped: false };
      const selected = draft.selected.includes(label)
        ? draft.selected.filter((item) => item !== label)
        : [...draft.selected, label];
      return { ...draft, selected, skipped: false };
    });
  };

  const answered = (draft: Draft): boolean =>
    draft.selected.length > 0 || draft.custom.trim() !== '' || draft.skipped;
  // 每一題都要有個交代——答了或明著跳過。這樣「還沒填」與「就是不想答」分得開，
  // 而模型收到的空陣列因此是一個決定，不是一個遺漏。
  const complete = drafts.every(answered);

  const submit = (): void => {
    onAnswer(
      pending.questions.map((question, index) => {
        const draft = drafts[index] ?? EMPTY;
        if (draft.skipped) return { id: question.id, selected: [] };
        const custom = draft.custom.trim();
        return {
          id: question.id,
          selected: [...draft.selected],
          ...(custom === '' ? {} : { custom }),
        };
      }),
    );
  };

  return (
    <section
      className="border-border bg-card flex flex-col gap-4 rounded-lg border p-4"
      aria-label="問答請求"
      data-testid="question-card"
    >
      <p className="text-sm font-medium">要繼續得先問你 {pending.questions.length} 件事：</p>
      <ol className="flex flex-col gap-4">
        {pending.questions.map((question, index) => {
          const draft = drafts[index] ?? EMPTY;
          const multi = question.multiSelect === true;
          return (
            <li key={question.id} className="flex flex-col gap-2">
              {question.header !== undefined && (
                <span className="text-muted-foreground text-xs">{question.header}</span>
              )}
              <p className="text-sm">{question.question}</p>
              {question.options !== undefined && question.options.length > 0 && (
                <div className="flex flex-col gap-1">
                  {question.options.map((option) => (
                    <label key={option.label} className="flex items-start gap-2 text-sm">
                      <input
                        type={multi ? 'checkbox' : 'radio'}
                        name={`q-${pending.interruptId}-${question.id}`}
                        checked={draft.selected.includes(option.label)}
                        disabled={busy}
                        onChange={() => {
                          toggle(index, option.label, multi);
                        }}
                      />
                      <span>
                        {option.label}
                        {option.description !== undefined && (
                          <span className="text-muted-foreground block text-xs">
                            {option.description}
                          </span>
                        )}
                      </span>
                    </label>
                  ))}
                </div>
              )}
              <input
                type="text"
                className="border-border rounded border px-2 py-1 text-sm"
                aria-label={`${question.question} 的自由作答`}
                placeholder={question.options === undefined ? '你的答案…' : '其他（自己寫）…'}
                value={draft.custom}
                disabled={busy || draft.skipped}
                onChange={(event) => {
                  update(index, (current) => ({
                    ...current,
                    custom: event.target.value,
                    skipped: false,
                  }));
                }}
              />
              <div>
                <Button
                  type="button"
                  variant={draft.skipped ? 'default' : 'outline'}
                  disabled={busy}
                  onClick={() => {
                    update(index, (current) =>
                      current.skipped ? EMPTY : { selected: [], custom: '', skipped: true },
                    );
                  }}
                >
                  {draft.skipped ? '這題已跳過' : '跳過這題'}
                </Button>
              </div>
            </li>
          );
        })}
      </ol>
      <div className="flex gap-2">
        <Button type="button" disabled={busy || !complete} onClick={submit}>
          送出答案
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
          放棄整組問題
        </Button>
      </div>
    </section>
  );
}
