/**
 * 回饋對話框：分類加備註，可以空著送（[#278](https://github.com/DemianLi/nexus-agent/issues/278)）。
 *
 * 一張表單兩個目標，照 dsh 的 `FeedbackDialogController`：按讚或點踩時是那一則回覆，只打 `/feedback`
 * 時是整個會話。送出失敗時框留著，失敗那句話寫在框裡。
 *
 * **自己寫，不是 shadcn 的 Dialog**：那一份靠 `@radix-ui/react-dialog`，而這個 repo 還沒有它；為了一個
 * 框多一條相依不划算。所以這裡只做到框該做的：蓋住底下、Esc 關、開起來時游標落在備註欄。
 */

import { useEffect, useId, useRef, useState } from 'react';

import type { WireFeedbackCategory } from '@nexus/wire';

import { Button } from '@/components/ui/button';
import { CATEGORIES, CATEGORY_LABEL, FEEDBACK_COPY } from '@/lib/feedback';

export interface FeedbackDraft {
  readonly category?: WireFeedbackCategory;
  readonly text: string;
}

export function FeedbackDialog({
  submitting,
  failure,
  onSubmit,
  onDismiss,
}: {
  submitting: boolean;
  failure?: string;
  onSubmit: (draft: FeedbackDraft) => void;
  onDismiss: () => void;
}) {
  const [category, setCategory] = useState<WireFeedbackCategory | undefined>(undefined);
  const [text, setText] = useState('');
  const titleId = useId();
  const detailRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    detailRef.current?.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onDismiss();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-card flex w-full max-w-md flex-col gap-4 rounded-lg p-4 shadow-menu"
      >
        <h2 id={titleId} className="text-base font-semibold">
          {FEEDBACK_COPY.title}
        </h2>
        <div className="flex flex-wrap gap-2" role="group" aria-label={FEEDBACK_COPY.categories}>
          {CATEGORIES.map((candidate) => (
            <Button
              key={candidate}
              type="button"
              size="sm"
              variant={category === candidate ? 'default' : 'outline'}
              aria-pressed={category === candidate}
              disabled={submitting}
              onClick={() => setCategory(category === candidate ? undefined : candidate)}
            >
              {CATEGORY_LABEL[candidate]}
            </Button>
          ))}
        </div>
        <textarea
          ref={detailRef}
          className="border-input bg-background min-h-24 rounded-md border px-3 py-2 text-sm"
          aria-label={FEEDBACK_COPY.detail}
          placeholder={FEEDBACK_COPY.hint}
          value={text}
          readOnly={submitting}
          onChange={(event) => setText(event.target.value)}
        />
        {failure !== undefined && (
          <p className="text-destructive text-sm" role="alert">
            {failure}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={submitting} onClick={onDismiss}>
            {FEEDBACK_COPY.close}
          </Button>
          <Button
            type="button"
            disabled={submitting}
            onClick={() => onSubmit({ ...(category === undefined ? {} : { category }), text })}
          >
            {submitting ? FEEDBACK_COPY.submitting : FEEDBACK_COPY.submit}
          </Button>
        </div>
      </div>
    </div>
  );
}
