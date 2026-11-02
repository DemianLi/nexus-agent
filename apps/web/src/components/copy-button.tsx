/**
 * 一顆複製鈕（[#1305](https://github.com/DemianLi/nexus-agent/issues/1305)）：交付卡片的「複製路徑」、回覆底下的
 * 「複製回覆」、程式碼區塊的「複製程式碼」共用同一套行為與回饋。
 *
 * - 行為走 `copyText`（內網非安全來源沒有 `navigator.clipboard` 時退回 `execCommand`）。
 * - 回饋：成功時圖示換成勾勾 {@link COPIED_MS}、跳一則 toast；寫不進剪貼簿就跳錯誤 toast，請人手動選取。
 *   不另開 live region（§8）：toast 自己會唸。
 */

import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/utils';

/** 複製成功的勾勾留多久。 */
export const COPIED_MS = 1500;

export function CopyButton({
  text,
  label,
  copied: copiedToast,
  failed,
  className,
}: {
  /** 寫進剪貼簿的字。 */
  readonly text: string;
  /** 按鈕名稱（`aria-label` 與 `title`）。 */
  readonly label: string;
  /** 成功時那則 toast。 */
  readonly copied: { readonly title: string; readonly description?: string };
  /** 寫不進剪貼簿時那則 toast。 */
  readonly failed: { readonly title: string; readonly description: string };
  readonly className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    if (await copyText(text)) {
      clearTimeout(timer.current);
      setCopied(true);
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
      if (copiedToast.description === undefined) toast(copiedToast.title);
      else toast(copiedToast.title, { description: copiedToast.description });
    } else {
      toast.error(failed.title, { description: failed.description });
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn('shrink-0', className)}
      title={label}
      aria-label={label}
      onClick={() => void copy()}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}
