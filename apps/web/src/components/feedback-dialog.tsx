/**
 * 回饋對話框：分類加備註，可以空著送（[#278](https://github.com/DemianLi/nexus-agent/issues/278)）。
 *
 * 一張表單兩個目標，照 dsh 的 `FeedbackDialogController`：按讚或點踩時是那一則回覆，只打 `/feedback`
 * 時是整個會話。送出失敗時框留著，失敗那句話寫在框裡。
 *
 * 外殼是 shadcn `dialog`（規格 §4.2 列 35；`radix-ui` 從 #401 起就在）：蓋住底下、Esc 與點外面都算關、
 * 焦點困在框裡、關掉後回到打開前的地方，都由 Radix 做。這裡只管表單，開起來時游標落在備註欄。
 *
 * **框常駐、用 `open` 開關**，退場動效才跑得完；換目標時呼叫端換 `key`，草稿不帶過去。
 */

import { useRef, useState } from 'react';

import type { WireFeedbackCategory } from '@nexus/wire';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CATEGORIES, CATEGORY_LABEL, FEEDBACK_COPY } from '@/lib/feedback';

export interface FeedbackDraft {
  readonly category?: WireFeedbackCategory;
  readonly text: string;
}

export function FeedbackDialog({
  open,
  submitting,
  failure,
  onSubmit,
  onDismiss,
}: {
  open: boolean;
  submitting: boolean;
  failure?: string;
  onSubmit: (draft: FeedbackDraft) => void;
  onDismiss: () => void;
}) {
  const [category, setCategory] = useState<WireFeedbackCategory | undefined>(undefined);
  const [text, setText] = useState('');
  const detailRef = useRef<HTMLTextAreaElement>(null);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onDismiss();
      }}
    >
      <DialogContent
        showCloseButton={false}
        // 沒有另外的說明文字：標題與欄位的名字已經講完了。
        aria-describedby={undefined}
        className="max-w-md"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          detailRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{FEEDBACK_COPY.title}</DialogTitle>
        </DialogHeader>
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
        <DialogFooter>
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
